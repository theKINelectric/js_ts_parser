# Elixir bridge

`JsTsParser.parse(source, filename, opts \\ [])` returns `{:ok, result}` with the
helper's complete string-keyed protocol map, or `{:error, reason}`. Successful
results require protocol `1`, policy `js-ts-ast-v1`, the SHA-256 of the exact
source bytes, typed function records, and mutation sites whose original bytes
and enclosing function match the supplied source. Metadata must identify
`@babel/parser` version `7.29.9` and helper package version `0.1.0`; upgrades
require an explicit contract change rather than silently accepting drift.
Branches require a nonempty kind, a line and byte range within the owning
function, and exactly one complexity increment per recorded branch.

The known skip reasons are `module_scope` for executable module-scope syntax
outside function findings, and `declaration_file` for `.d.ts`, `.d.mts`, and
`.d.cts` files. A declaration reply must mark `syntax_checked: false` and
contain no executable functions or mutation sites. A declaration skip for an
ordinary source filename is rejected. Declaration skips do not claim syntax
validation. Other skip reasons require an explicit protocol update.

Add the package as an Elixir path dependency from the consumer:

```elixir
{:js_ts_parser, path: "../js_ts_parser/elixir"}
```

The trusted parser root is selected by `:root` in the call, the application
setting `config :js_ts_parser, :root, path`, `JS_TS_PARSER_ROOT`, or the parser
package above `elixir/`, in that order. Node uses the same precedence with
`:node`, `JS_TS_PARSER_NODE`, and `System.find_executable("node")`. These are
operator-controlled infrastructure settings, never subject-project settings.
Install the parser's locked Node dependencies at the package root before use.
The bridge does not read or run the subject's package or build configuration.
Inherited `NODE_OPTIONS` and `NODE_PATH` are removed from the parser environment
so project loader hooks cannot preload code or alter module resolution.

The timeout defaults to 10,000 milliseconds and accepts a finite positive
`:timeout` override. Source is limited to 1,500,000 bytes and output to
16,000,000 bytes. One JSON request goes through stdin; no shell is started.
Stderr intentionally shares the bounded response stream. On exit 0, a diagnostic
mixed with a valid JSON reply returns `:malformed_json`; the bridge does not
extract a JSON substring or expose diagnostic/source bytes in its error.
Nonzero exits retain their exit-status precedence unless exit 1 contains a
valid structured parser error reply.
On timeout or output failure, the bridge terminates its Node child before
closing the port, escalating from TERM to KILL if necessary. A separate parser
owner monitors the calling process and performs the same cleanup if the caller
is killed, including an untrappable `:kill`. This lifecycle
uses the fixed Unix `/bin/kill` utility; macOS and Linux are the supported hosts.

Error reasons distinguish:

- `:invalid_request`, `:source_limit`, `:unavailable`.
- `:timeout`, `:output_limit`, `:malformed_json`.
- `{:protocol_error, field}` for response/protocol/policy/meta/functions/sites/skipped.
- `:source_hash_mismatch`.
- `{:parser_error, diagnostic_map}` for an explicit syntax/error reply on exit 0 or 1.
- `{:exit_status, status}` for other exits, including a crash after buffered output.
- `:transport_failure` if the dedicated parser-owner process fails. Unexpected
  transport exceptions are sanitized rather than logging source-bearing stacks.

Run `mix deps.get` and `mix test` with Node available. Tests use temporary trusted
helpers, never subject code, and include a SIGTERM-ignoring process to verify
KILL fallback, OS-process cleanup, and recovery after a calling task is killed.
Tests run synchronously and use explicit
root/node options rather than racing global application configuration.
