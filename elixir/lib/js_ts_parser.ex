defmodule JsTsParser do
  @moduledoc """
  Bounded stdin/stdout bridge to the trusted JavaScript/TypeScript syntax helper.

  The helper parses supplied source only. This module never starts a shell or
  loads the subject project's configuration. `:root` and `:node` options (or
  equivalent application configuration) select trusted parser infrastructure,
  not paths read from the subject project.

  Successful results retain the helper's string-keyed protocol map. Transport,
  protocol, parser and source-custody failures are separate error values.
  """

  @source_limit 1_500_000
  @output_limit 16_000_000
  @timeout 10_000
  @cleanup_timeout 150
  @policy "js-ts-ast-v1"
  @parser "@babel/parser"
  @parser_version "7.29.9"
  @package_version "0.1.0"

  @spec parse(binary(), binary(), keyword()) :: {:ok, map()} | {:error, term()}
  def parse(source, filename, opts \\ [])

  def parse(source, filename, opts)
      when is_binary(source) and is_binary(filename) and is_list(opts) do
    cond do
      byte_size(source) > @source_limit ->
        {:error, :source_limit}

      not valid_request?(source, filename, opts) ->
        {:error, :invalid_request}

      true ->
        with {:ok, node, root, script} <- infrastructure(opts),
             {:ok, output, status} <-
               exchange(
                 node,
                 root,
                 script,
                 source,
                 filename,
                 Keyword.get(opts, :timeout, @timeout)
               ) do
          interpret(output, status, source, filename)
        end
    end
  end

  def parse(_source, _filename, _opts), do: {:error, :invalid_request}

  defp valid_request?(source, filename, opts) do
    Keyword.keyword?(opts) and String.valid?(source) and String.valid?(filename) and
      filename != "" and is_integer(Keyword.get(opts, :timeout, @timeout)) and
      Keyword.get(opts, :timeout, @timeout) > 0
  end

  defp infrastructure(opts) do
    root = configured(opts, :root, "JS_TS_PARSER_ROOT", Path.expand("../..", __DIR__))
    node = configured(opts, :node, "JS_TS_PARSER_NODE", System.find_executable("node"))

    if is_binary(root) and is_binary(node) do
      script = Path.join(root, "bin/parser.mjs")

      case System.find_executable(node) do
        nil ->
          {:error, :unavailable}

        executable ->
          if File.regular?(script),
            do: {:ok, executable, Path.expand(root), Path.expand(script)},
            else: {:error, :unavailable}
      end
    else
      {:error, :unavailable}
    end
  end

  defp configured(opts, key, environment, fallback) do
    Keyword.get(opts, key) || Application.get_env(:js_ts_parser, key) ||
      System.get_env(environment) || fallback
  end

  defp exchange(node, root, script, source, filename, timeout) do
    caller = self()
    reply = make_ref()

    {owner, monitor} =
      spawn_monitor(fn ->
        caller_monitor = Process.monitor(caller)

        result =
          try do
            owned_exchange(node, root, script, source, filename, timeout, caller_monitor)
          rescue
            _ -> {:error, :transport_failure}
          catch
            _kind, _reason -> {:error, :transport_failure}
          end

        Process.demonitor(caller_monitor, [:flush])
        send(caller, {reply, result})
      end)

    receive do
      {^reply, result} ->
        Process.demonitor(monitor, [:flush])
        result

      {:DOWN, ^monitor, :process, ^owner, _reason} ->
        {:error, :transport_failure}
    end
  end

  # A separate owner keeps cleanup alive when a caller is killed with an
  # untrappable exit. Closing an automatically orphaned port cannot stop Node.
  defp owned_exchange(node, root, script, source, filename, timeout, caller_monitor) do
    case open_port(node, root, script) do
      {:ok, port} ->
        try do
          request = Jason.encode!(%{protocol: 1, source: source, filename: filename})

          if Port.command(port, [request, "\n"], [:nosuspend]) do
            collect(port, System.monotonic_time(:millisecond) + timeout, [], 0, caller_monitor)
          else
            {:error, :unavailable}
          end
        after
          close_port(port)
        end

      error ->
        error
    end
  end

  defp open_port(node, root, script) do
    {:ok,
     Port.open({:spawn_executable, node}, [
       :binary,
       :exit_status,
       :use_stdio,
       :stderr_to_stdout,
       :hide,
       {:args, [script]},
       {:env, [{~c"NODE_OPTIONS", false}, {~c"NODE_PATH", false}]},
       {:cd, root}
     ])}
  rescue
    ArgumentError -> {:error, :unavailable}
    ErlangError -> {:error, :unavailable}
  end

  defp collect(port, deadline, chunks, size, caller_monitor) do
    receive do
      {^port, {:data, chunk}} ->
        next_size = size + byte_size(chunk)

        if next_size > @output_limit do
          {:error, :output_limit}
        else
          collect(port, deadline, [chunk | chunks], next_size, caller_monitor)
        end

      {^port, {:exit_status, 0}} ->
        {:ok, chunks |> Enum.reverse() |> IO.iodata_to_binary(), 0}

      {^port, {:exit_status, status}} ->
        {:ok, chunks |> Enum.reverse() |> IO.iodata_to_binary(), status}

      {:DOWN, ^caller_monitor, :process, _caller, _reason} ->
        {:error, :caller_down}
    after
      max(deadline - System.monotonic_time(:millisecond), 0) -> {:error, :timeout}
    end
  end

  defp close_port(port) do
    if Port.info(port) do
      terminate_child(port)
      if Port.info(port), do: Port.close(port)
    end

    flush_port(port)
  rescue
    ArgumentError -> flush_port(port)
  end

  # Closing a BEAM port only closes its pipes; a CPU-bound Node process can
  # survive that operation. Signal it while the port still owns its OS pid.
  defp terminate_child(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} when is_integer(pid) and pid > 0 ->
        signal(pid, "-TERM")

        if not await_exit(port, System.monotonic_time(:millisecond) + @cleanup_timeout) do
          if Port.info(port, :os_pid) == {:os_pid, pid} do
            signal(pid, "-KILL")
            await_exit(port, System.monotonic_time(:millisecond) + @cleanup_timeout)
          end
        end

      _ ->
        :ok
    end
  end

  defp signal(pid, signal) do
    killer =
      Port.open({:spawn_executable, "/bin/kill"}, [
        :binary,
        :exit_status,
        :use_stdio,
        :stderr_to_stdout,
        :hide,
        {:args, [signal, Integer.to_string(pid)]}
      ])

    try do
      await_exit(killer, System.monotonic_time(:millisecond) + @cleanup_timeout)
    after
      if Port.info(killer), do: Port.close(killer)
      flush_port(killer)
    end
  rescue
    ArgumentError -> :ok
    ErlangError -> :ok
  end

  defp await_exit(port, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining > 0 do
      receive do
        {^port, {:exit_status, _}} -> true
        {^port, {:data, _}} -> await_exit(port, deadline)
      after
        remaining -> false
      end
    else
      false
    end
  end

  defp flush_port(port) do
    receive do
      {^port, _message} -> flush_port(port)
    after
      0 -> :ok
    end
  end

  defp decode(output) do
    case Jason.decode(output) do
      {:ok, response} -> {:ok, response}
      {:error, _} -> {:error, :malformed_json}
    end
  end

  defp interpret(output, 0, source, filename) do
    with {:ok, response} <- decode(output), do: validate(response, source, filename)
  end

  defp interpret(output, 1, source, filename) do
    # A parsed syntax error is an expected CLI failure (exit 1), whereas a
    # process crash after a success-shaped response must never become success.
    with {:ok, response} <- decode(output),
         {:error, {:parser_error, _}} = error <- validate(response, source, filename) do
      error
    else
      _ -> {:error, {:exit_status, 1}}
    end
  end

  defp interpret(_output, status, _source, _filename), do: {:error, {:exit_status, status}}

  defp validate(
         %{
           "protocol" => 1,
           "ok" => false,
           "error" => %{"code" => code, "message" => message} = error
         },
         _source,
         _filename
       )
       when is_binary(code) and is_binary(message), do: {:error, {:parser_error, error}}

  defp validate(%{"protocol" => protocol}, _source, _filename) when protocol != 1,
    do: {:error, {:protocol_error, :protocol}}

  defp validate(%{"protocol" => 1, "ok" => true} = response, source, filename) do
    cond do
      response["policy"] != @policy ->
        {:error, {:protocol_error, :policy}}

      not valid_meta?(response["meta"]) ->
        {:error, {:protocol_error, :meta}}

      response["source_sha256"] != source_hash(source) ->
        {:error, :source_hash_mismatch}

      not valid_functions?(response["functions"], source) ->
        {:error, {:protocol_error, :functions}}

      not valid_sites?(response["sites"], response["functions"], source) ->
        {:error, {:protocol_error, :sites}}

      not valid_skipped?(response["skipped"], filename, response["functions"], response["sites"]) ->
        {:error, {:protocol_error, :skipped}}

      true ->
        {:ok, response}
    end
  end

  defp validate(_response, _source, _filename), do: {:error, {:protocol_error, :response}}

  defp valid_meta?(%{
         "parser" => @parser,
         "parser_version" => @parser_version,
         "package_version" => @package_version
       }),
       do: true

  defp valid_meta?(_meta), do: false

  defp source_hash(source), do: Base.encode16(:crypto.hash(:sha256, source), case: :lower)

  defp valid_functions?(functions, source) when is_list(functions) do
    Enum.all?(functions, fn
      %{
        "id" => id,
        "name" => name,
        "module" => module,
        "line_start" => line_start,
        "line_end" => line_end,
        "start_byte" => first,
        "end_byte" => last,
        "arity" => arity,
        "complexity" => complexity,
        "branches" => branches
      } ->
        is_binary(id) and is_binary(name) and is_binary(module) and
          valid_lines?(line_start, line_end) and valid_range?(first, last, byte_size(source)) and
          is_integer(arity) and arity >= 0 and is_integer(complexity) and complexity >= 1 and
          is_list(branches) and length(branches) == complexity - 1 and
          valid_branches?(branches, line_start, line_end, first, last)

      _ ->
        false
    end) and unique?(functions, "id") and unique?(functions, "name")
  end

  defp valid_functions?(_functions, _source), do: false

  defp valid_branches?(branches, line_start, line_end, function_first, function_last) do
    Enum.all?(branches, fn
      %{"kind" => kind, "line" => line, "start_byte" => first, "end_byte" => last} ->
        is_binary(kind) and String.trim(kind) != "" and is_integer(line) and
          line >= line_start and line <= line_end and
          valid_range?(first, last, function_last) and first >= function_first

      _ ->
        false
    end)
  end

  defp valid_skipped?(skipped, filename, functions, sites) when is_list(skipped) do
    declaration? = String.ends_with?(filename, [".d.ts", ".d.mts", ".d.cts"])

    Enum.all?(skipped, fn
      %{"reason" => "declaration_file", "syntax_checked" => false} ->
        declaration? and functions == [] and sites == []

      %{"reason" => "module_scope"} ->
        not declaration? and Path.extname(filename) in ~w(.js .jsx .mjs .cjs .ts .tsx .mts .cts)

      _ ->
        false
    end)
  end

  defp valid_skipped?(_skipped, _filename, _functions, _sites), do: false

  defp valid_sites?(sites, functions, source) when is_list(sites) do
    owners = Map.new(functions, &{&1["name"], &1})

    Enum.all?(sites, fn
      %{
        "function" => name,
        "function_start" => line_start,
        "function_end" => line_end,
        "line" => line,
        "byte_start" => first,
        "byte_end" => last,
        "operator" => operator,
        "original" => original,
        "replacement" => replacement
      } ->
        is_binary(name) and valid_lines?(line_start, line_end) and
          is_integer(line) and line >= line_start and line <= line_end and
          valid_range?(first, last, byte_size(source)) and is_binary(operator) and
          is_binary(original) and is_binary(replacement) and
          original == binary_part(source, first, last - first) and
          valid_owner?(Map.get(owners, name), line_start, line_end, first, last)

      _ ->
        false
    end)
  end

  defp valid_sites?(_sites, _functions, _source), do: false

  defp valid_owner?(nil, _line_start, _line_end, _first, _last), do: false

  defp valid_owner?(function, line_start, line_end, first, last) do
    function["line_start"] == line_start and function["line_end"] == line_end and
      first >= function["start_byte"] and last <= function["end_byte"]
  end

  defp valid_lines?(first, last),
    do: is_integer(first) and is_integer(last) and first > 0 and last >= first

  defp valid_range?(first, last, size),
    do: is_integer(first) and is_integer(last) and first >= 0 and last > first and last <= size

  defp unique?(items, key), do: length(Enum.uniq_by(items, &Map.fetch!(&1, key))) == length(items)
end
