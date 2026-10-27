defmodule JsTsParserTest do
  use ExUnit.Case, async: false

  @source "const eligible = (age: number) => age >= 18;"
  @node System.find_executable("node")
  @base """
  import { createHash } from 'node:crypto';
  import { createInterface } from 'node:readline';
  import { writeFileSync } from 'node:fs';
  const lines = createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    lines.close();
    process.stdin.destroy();
    const request = JSON.parse(line);
    const reply = {ok:true, protocol:1, policy:'js-ts-ast-v1',
      source_sha256:createHash('sha256').update(request.source).digest('hex'),
      meta:{parser:'@babel/parser',parser_version:'7.29.9',package_version:'0.1.0'},
      functions:[], sites:[], skipped:[]};
    SCRIPT
  });
  """
  @function_facts """
  const at = request.source.indexOf('>=');
  reply.functions=[{id:'eligible',name:'eligible',module:'',line_start:1,line_end:1,
    start_byte:request.source.indexOf('(age'),end_byte:Buffer.byteLength(request.source)-1,
    arity:1,complexity:1,branches:[]}];
  reply.sites=[{function:'eligible',function_start:1,function_end:1,line:1,
    byte_start:at,byte_end:at+2,operator:'>=',original:'>=',replacement:'>'}];
  """

  setup do
    root = Path.join(System.tmp_dir!(), "js_ts_bridge_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, "bin"))
    on_exit(fn -> File.rm_rf!(root) end)
    %{root: root}
  end

  defp helper(root, body) do
    File.write!(Path.join(root, "bin/parser.mjs"), String.replace(@base, "SCRIPT", body))
    [root: root, node: @node]
  end

  test "round-trips exact source through one stdin request", %{root: root} do
    opts =
      helper(
        root,
        "reply.filename = request.filename; reply.request_protocol = request.protocol; console.log(JSON.stringify(reply));"
      )

    assert {:ok, result} = JsTsParser.parse(@source, "file.ts", opts)
    assert result["filename"] == "file.ts"
    assert result["request_protocol"] == 1
    assert result["source_sha256"] == Base.encode16(:crypto.hash(:sha256, @source), case: :lower)
  end

  test "does not load subject package configuration", %{root: root} do
    File.write!(Path.join(root, "package.json"), "this is not valid JSON and must not be read")
    opts = helper(root, "console.log(JSON.stringify(reply));")
    assert {:ok, _} = JsTsParser.parse("// unicode: λ🙂\n", "folder with spaces/hello.tsx", opts)
  end

  test "discards inherited Node preload and resolution hooks", %{root: root} do
    marker = Path.join(root, "preload-ran")
    preload = Path.join(root, "untrusted-preload.mjs")

    File.write!(
      preload,
      "import {writeFileSync} from 'node:fs'; writeFileSync(#{Jason.encode!(marker)},'ran');"
    )

    original_env = Map.new(["NODE_OPTIONS", "NODE_PATH"], &{&1, System.get_env(&1)})

    on_exit(fn ->
      for key <- ["NODE_OPTIONS", "NODE_PATH"] do
        case original_env[key] do
          nil -> System.delete_env(key)
          value -> System.put_env(key, value)
        end
      end
    end)

    System.put_env("NODE_OPTIONS", "--import=file://#{preload}")
    System.put_env("NODE_PATH", root)

    opts =
      helper(
        root,
        "reply.inherited={options:process.env.NODE_OPTIONS,path:process.env.NODE_PATH}; console.log(JSON.stringify(reply));"
      )

    assert {:ok, result} = JsTsParser.parse(@source, "file.ts", opts)
    refute File.exists?(marker)
    assert result["inherited"] == %{}
  end

  test "reports unavailable executable or helper", %{root: root} do
    assert {:error, :unavailable} = JsTsParser.parse(@source, "file.ts", root: root, node: @node)
    opts = helper(root, "console.log(JSON.stringify(reply));")

    assert {:error, :unavailable} =
             JsTsParser.parse(@source, "file.ts", Keyword.put(opts, :node, "/does/not/exist"))
  end

  test "rejects oversized input before launching", %{root: root} do
    assert {:error, :source_limit} =
             JsTsParser.parse(String.duplicate("a", 1_500_001), "large.js", root: root)
  end

  test "rejects invalid arguments", %{root: root} do
    for args <- [
          [nil, "x.js", []],
          ["x", nil, []],
          ["x", "x.js", [timeout: 0]],
          ["x", "x.js", [timeout: :infinity]]
        ] do
      assert {:error, :invalid_request} = apply(JsTsParser, :parse, args)
    end

    assert {:error, :invalid_request} = JsTsParser.parse(<<255>>, "x.js", root: root)
  end

  test "distinguishes malformed JSON and multiple replies", %{root: root} do
    for body <- [
          "console.log('not json');",
          "console.log(JSON.stringify(reply)); console.log(JSON.stringify(reply));"
        ] do
      opts = helper(root, body)
      assert {:error, :malformed_json} = JsTsParser.parse(@source, "file.ts", opts)
    end
  end

  @tag :stderr_contract
  test "stderr mixed with an otherwise valid reply is malformed without exposing bytes", %{
    root: root
  } do
    opts =
      helper(
        root,
        "process.stderr.write('PRIVATE SOURCE CONTENT\\n'); console.log(JSON.stringify(reply));"
      )

    assert {:error, :malformed_json} = JsTsParser.parse(@source, "file.ts", opts)
  end

  @tag :site_contract
  test "rejects fully shaped sites whose original differs or lies outside its owner", %{
    root: root
  } do
    opts = helper(root, @function_facts <> "console.log(JSON.stringify(reply));")
    assert {:ok, %{"sites" => [_]}} = JsTsParser.parse(@source, "file.ts", opts)

    for corruption <- [
          "reply.sites[0].original='==';",
          "reply.sites[0].byte_start=0; reply.sites[0].byte_end=5; reply.sites[0].original='const';"
        ] do
      opts = helper(root, @function_facts <> corruption <> "console.log(JSON.stringify(reply));")
      assert {:error, {:protocol_error, :sites}} = JsTsParser.parse(@source, "file.ts", opts)
    end
  end

  @tag :branch_contract
  test "requires typed branch evidence within its owner and a matching complexity count", %{
    root: root
  } do
    valid_branch =
      "reply.functions[0].complexity=2; reply.functions[0].branches=[{kind:'if',line:1,start_byte:at,end_byte:at+2}];"

    opts = helper(root, @function_facts <> valid_branch <> "console.log(JSON.stringify(reply));")
    assert {:ok, _} = JsTsParser.parse(@source, "file.ts", opts)

    for corruption <- [
          "reply.functions[0].branches=[{}];",
          "reply.functions[0].branches[0].kind=' ';",
          "reply.functions[0].branches[0].line=2;",
          "reply.functions[0].branches[0].start_byte=0;",
          "reply.functions[0].branches[0].end_byte=1000;",
          "reply.functions[0].complexity=1;"
        ] do
      opts =
        helper(
          root,
          @function_facts <> valid_branch <> corruption <> "console.log(JSON.stringify(reply));"
        )

      assert {:error, {:protocol_error, :functions}} = JsTsParser.parse(@source, "file.ts", opts)
    end
  end

  @tag :meta_contract
  test "requires the pinned parser and helper package metadata", %{root: root} do
    for corruption <- [
          "delete reply.meta;",
          "reply.meta={};",
          "reply.meta.parser='other-parser';",
          "reply.meta.parser_version='7.0.0';",
          "reply.meta.package_version='9.9.9';"
        ] do
      opts = helper(root, corruption <> "console.log(JSON.stringify(reply));")
      assert {:error, {:protocol_error, :meta}} = JsTsParser.parse(@source, "file.ts", opts)
    end
  end

  @tag :skip_contract
  test "declaration skips require the declaration suffix, unchecked syntax and no executable facts",
       %{root: root} do
    skipped = "reply.skipped=[{reason:'declaration_file',syntax_checked:false}];"
    opts = helper(root, skipped <> "console.log(JSON.stringify(reply));")
    assert {:error, {:protocol_error, :skipped}} = JsTsParser.parse(@source, "file.ts", opts)

    for filename <- ["file.d.ts", "file.d.mts", "file.d.cts"] do
      assert {:ok, _} = JsTsParser.parse(@source, filename, opts)
    end

    opts = helper(root, @function_facts <> skipped <> "console.log(JSON.stringify(reply));")
    assert {:error, {:protocol_error, :skipped}} = JsTsParser.parse(@source, "file.d.ts", opts)

    for invalid <- [
          "reply.skipped=[{reason:'declaration_file'}];",
          "reply.skipped=[{reason:'declaration_file',syntax_checked:true}];",
          "reply.skipped=[{reason:'unknown_skip'}];",
          "reply.skipped=[{}];"
        ] do
      opts = helper(root, invalid <> "console.log(JSON.stringify(reply));")
      assert {:error, {:protocol_error, :skipped}} = JsTsParser.parse(@source, "file.d.ts", opts)
    end

    opts =
      helper(root, "reply.skipped=[{reason:'module_scope'}]; console.log(JSON.stringify(reply));")

    assert {:ok, _} = JsTsParser.parse(@source, "file.ts", opts)
  end

  test "rejects incompatible protocol or policy", %{root: root} do
    opts = helper(root, "reply.protocol=2; console.log(JSON.stringify(reply));")
    assert {:error, {:protocol_error, :protocol}} = JsTsParser.parse(@source, "file.ts", opts)
    opts = helper(root, "reply.policy='other'; console.log(JSON.stringify(reply));")
    assert {:error, {:protocol_error, :policy}} = JsTsParser.parse(@source, "file.ts", opts)
  end

  test "requires hash of exact unmodified source", %{root: root} do
    opts = helper(root, "reply.source_sha256='0'.repeat(64); console.log(JSON.stringify(reply));")
    assert {:error, :source_hash_mismatch} = JsTsParser.parse(@source, "file.ts", opts)
  end

  test "validates functions and mutation sites", %{root: root} do
    for {field, invalid} <- [
          {"functions", %{}},
          {"functions", [%{"name" => "missing coordinates"}]},
          {"sites", %{}},
          {"sites", [%{"start_byte" => 0, "end_byte" => 1}]}
        ] do
      value = Jason.encode!(invalid)
      opts = helper(root, "reply.#{field}=#{value}; console.log(JSON.stringify(reply));")
      assert {:error, {:protocol_error, reason}} = JsTsParser.parse(@source, "file.ts", opts)
      assert reason == String.to_existing_atom(field)
    end
  end

  test "returns parser diagnostics separately from transport errors", %{root: root} do
    opts =
      helper(
        root,
        "console.log(JSON.stringify({ok:false,protocol:1,error:{code:'parse_error',message:'Unexpected token'}}));"
      )

    assert {:error, {:parser_error, %{"code" => "parse_error", "message" => "Unexpected token"}}} =
             JsTsParser.parse(@source, "file.ts", opts)

    opts =
      helper(
        root,
        "console.log(JSON.stringify({ok:false,protocol:1,error:{code:'parse_error',message:'Unexpected token'}})); process.exitCode=1;"
      )

    assert {:error, {:parser_error, %{"code" => "parse_error"}}} =
             JsTsParser.parse(@source, "file.ts", opts)
  end

  test "nonzero exit takes precedence over otherwise valid response", %{root: root} do
    opts = helper(root, "console.log(JSON.stringify(reply)); process.exitCode=9;")
    assert {:error, {:exit_status, 9}} = JsTsParser.parse(@source, "file.ts", opts)
  end

  test "does not disguise a crash as a normal syntax-error exit", %{root: root} do
    opts =
      helper(
        root,
        "console.log(JSON.stringify({ok:false,protocol:1,error:{code:'parse_error',message:'Unexpected token'}})); process.exitCode=9;"
      )

    assert {:error, {:exit_status, 9}} = JsTsParser.parse(@source, "file.ts", opts)
  end

  test "times out and closes its port", %{root: root} do
    pid_file = Jason.encode!(Path.join(root, "pid"))

    opts =
      helper(
        root,
        "writeFileSync(#{pid_file},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000);"
      )

    before = MapSet.new(Port.list())

    assert {:error, :timeout} =
             JsTsParser.parse(@source, "file.ts", Keyword.put(opts, :timeout, 200))

    assert MapSet.difference(MapSet.new(Port.list()), before) == MapSet.new()
    pid = File.read!(Path.join(root, "pid"))

    assert {"gone\n", 0} =
             System.cmd(@node, [
               "-e",
               "try {process.kill(Number(process.argv[1]), 0); console.log('alive')} catch {console.log('gone')}",
               pid
             ])
  end

  test "bounds output and closes its port", %{root: root} do
    opts = helper(root, "process.stdout.write('x'.repeat(16_000_001));")
    before = MapSet.new(Port.list())
    assert {:error, :output_limit} = JsTsParser.parse(@source, "file.ts", opts)
    assert MapSet.difference(MapSet.new(Port.list()), before) == MapSet.new()
  end

  test "terminates its Node child when its calling task is killed", %{root: root} do
    pid_file = Jason.encode!(Path.join(root, "pid"))

    opts =
      helper(
        root,
        "writeFileSync(#{pid_file},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000);"
      )

    caller = spawn(fn -> JsTsParser.parse(@source, "file.ts", opts) end)
    pid = wait_for_pid(Path.join(root, "pid"), 100)
    Process.exit(caller, :kill)

    {output, 0} =
      System.cmd(@node, [
        "-e",
        "const pid=Number(process.argv[1]); let attempts=0; const check=()=>{try{process.kill(pid,0); if(++attempts>=60){console.log('alive'); process.kill(pid,'SIGKILL');}else setTimeout(check,10);}catch{console.log('gone')}}; check();",
        pid
      ])

    assert output == "gone\n"
  end

  defp wait_for_pid(path, attempts) when attempts > 0 do
    case File.read(path) do
      {:ok, pid} ->
        pid

      {:error, :enoent} ->
        Process.sleep(10)
        wait_for_pid(path, attempts - 1)
    end
  end

  defp wait_for_pid(_path, 0), do: flunk("trusted fake helper failed to start")

  test "returns a sanitized error if the transport owner unexpectedly dies", %{root: root} do
    pid_file = Jason.encode!(Path.join(root, "pid"))

    opts =
      helper(root, "writeFileSync(#{pid_file},String(process.pid)); setInterval(() => {}, 1000);")

    parent = self()
    caller = spawn(fn -> send(parent, {:result, JsTsParser.parse(@source, "file.ts", opts)}) end)
    pid = wait_for_pid(Path.join(root, "pid"), 100)

    on_exit(fn ->
      System.cmd(@node, ["-e", "try{process.kill(Number(process.argv[1]),'SIGKILL')}catch{}", pid])
    end)

    {:monitors, [{:process, owner}]} = Process.info(caller, :monitors)
    Process.exit(owner, :kill)
    assert_receive {:result, {:error, :transport_failure}}, 1000
  end
end
