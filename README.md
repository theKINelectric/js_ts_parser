# Shared JavaScript / TypeScript parser

This shared Node package supplies the same syntax facts to PoopBags and
codeMUTATOR. It parses caller-supplied text with the pinned `@babel/parser`
dependency. It does **not** import the subject, resolve its dependencies, read its
files, run its tests, load its Babel/TypeScript configuration, or evaluate code.

Requires Node 20 or newer. Clone beside the consumer repositories and install
exactly the locked dependency graph:

```sh
git clone https://github.com/theKINelectric/js_ts_parser.git
cd js_ts_parser
npm ci --ignore-scripts
npm test
```

The npm package is marked `private` to prevent accidental registry publication;
the source repository is public. Consumers currently use a sibling Mix path
dependency, so retain the checkout directory name `js_ts_parser`.

The host application owns process timeouts, cancellation, environment isolation
and output limits. The helper independently rejects source over **1,500,000 UTF-8
bytes** and transport input over **9,065,536 bytes**. It never installs anything
while scanning. Missing dependencies or an incompatible Node runtime must be
reported by the consuming bridge as infrastructure failures, never clean scans.

## Wire protocol

Run `node bin/parser.mjs` and send **one newline-terminated JSON request** on
stdin. The CLI responds and exits immediately after the first line, even while
stdin remains open. EOF without a newline is also accepted. Output is one JSON
line, with exit code 0 for success and 1 for a structured error. Human logging is
never written to stdout. Each request launches a fresh process; it is not a
persistent multi-request server.

```json
{"protocol":1,"source":"export const eligible = (age: number) => age >= 18;","filename":"src/age.ts","language":"typescript"}
```

`language` is optional. A supplied value must agree with the filename extension.
The filename determines syntax; no package.json or tsconfig is consulted:

| Extensions | Syntax |
| --- | --- |
| `.js` | JavaScript, module/script inferred from import/export syntax |
| `.jsx` | JavaScript with JSX |
| `.mjs` | JavaScript ES module |
| `.cjs` | JavaScript CommonJS |
| `.ts` | TypeScript, module/script inferred |
| `.tsx` | TypeScript with JSX |
| `.mts` | TypeScript ES module; ambiguous JSX-like assertions disallowed |
| `.cts` | TypeScript CommonJS; ambiguous JSX-like assertions disallowed |
| `.d.ts`, `.d.mts`, `.d.cts` | Successful empty result with `declaration_file` skip reason and `syntax_checked: false` |

JSX is rejected in the other modes. TypeScript syntax is rejected in JavaScript
modes. Unknown extensions fail explicitly. CommonJS modes reject ES module
imports/exports rather than guessing a project transform. Babel proposal plugins,
including decorator syntax, are not enabled. Flow is not supported. These modes
describe this parser's scope and do not promise that a particular runtime,
compiler, test runner, browser, or bundler will accept or run the code.

The importable API is synchronous and returns the same result:

```js
import { parseRequest } from './parse.mjs';
const result = parseRequest({protocol: 1, source, filename: 'src/age.ts'});
```

Success shape:

```json
{
  "ok": true,
  "protocol": 1,
  "policy": "js-ts-ast-v1",
  "source_sha256": "sha256 of the exact UTF-8 source",
  "meta": {
    "parser": "@babel/parser",
    "parser_version": "7.29.9",
    "package_version": "0.1.0",
    "language": "typescript",
    "syntax": "typescript"
  },
  "functions": [{
    "id": "eligible",
    "name": "eligible",
    "module": "",
    "line_start": 1,
    "line_end": 1,
    "start_byte": 24,
    "end_byte": 50,
    "arity": 1,
    "complexity": 1,
    "branches": []
  }],
  "sites": [{
    "function": "eligible",
    "function_start": 1,
    "function_end": 1,
    "line": 1,
    "byte_start": 45,
    "byte_end": 47,
    "operator": ">=",
    "original": ">=",
    "replacement": ">"
  }],
  "skipped": []
}
```

The illustrative byte numbers above correspond to the request example. All byte
offsets are **UTF-8, zero-based and end-exclusive**. Lines are one-based. Function
ranges cover the AST function itself, including parameters, not the surrounding
variable declaration. Branches have `{kind,line,start_byte,end_byte}`; their ranges
cover the corresponding AST construct. `arity` counts declared parameters,
including a rest parameter as one, rather than JavaScript's runtime `.length`.

`function_start` and `function_end` on a mutation site are the owning function's
**line numbers**. `function` equals its unique qualified `name`. Consumers must
validate `source_sha256` and each site's `original` byte slice before mutating.

Errors use `{ok:false,protocol:1,error:{code,message,...}}`. Codes include
`invalid_request`, `invalid_json`, `unsupported_extension`, `language_mismatch`,
`source_too_large`, `request_too_large`, `parse_error`, `parser_error`, and
`input_error`. Parse errors include one-based `line` and zero-based `column`.

## Analysis policy `js-ts-ast-v1`

Reported functions include declarations, expressions, arrows, object/class/private
methods, getters, setters and constructors with executable bodies. TypeScript
overload/abstract/ambient signatures and type-only declarations are omitted.
Executable functions inside TypeScript namespaces are retained. Type wrappers
(`as`, `satisfies`, non-null assertions and angle assertions) preserve executable
expression traversal. No synthetic function is invented for module statements,
class static blocks or implicit instance initializers. An instance field's
expression is not charged to an enclosing factory; an explicit arrow field owns
its own finding.

When runtime syntax that would otherwise contribute a branch or eligible
mutation occurs outside a reported function, `skipped` contains
`{reason: "module_scope"}` **once per file**. This also exposes excluded implicit
initializer scope; it does not add synthetic functions or sites. A source such
as `const x = a > 1 ? 2 : 3` therefore produces no functions/sites and an explicit
module-scope skip, rather than a silently clean empty analysis. Type-only syntax
does not trigger that marker.

Declaration files are excluded **before parsing**. Even malformed text such as
`%%%` in `broken.d.ts` returns the declaration skip with
`syntax_checked: false`; success describes a recognized exclusion, not validated
declaration syntax. Consumers must preserve that distinction.

Functions have deterministic unique qualified names. Examples are `Box.#check`,
`Box.get value`, `tools.run`, `outer.inner` and `outer.items.map.callback#1`.
Anonymous callback ordinals are scoped to parent and call label. Repeated named
bindings gain a `#2` suffix. A global emitted-name guard prevents a synthetic
suffix from colliding with an explicit string property such as `"run#2"`.
These identities do not contain source line numbers,
so a whitespace-only shift does not change them. Inserting/reordering anonymous
callbacks or duplicate lexical bindings can change ordinals; they are structural
identities, not semantic identity proofs across arbitrary refactors.

Complexity is 1 plus one contribution for each `if`, `for`/`for in`/`for of`,
`while`, `do while`, `catch`, ternary expression, switch arm **including default**,
`&&`, `||`, `??`, and optional member/call whose AST `optional` flag is true.
`switch` itself adds no extra point. Each nested function owns its own branches;
they never double-count into its parent. Function parameter default expressions
belong to that function. Logical assignments (`&&=`, `||=`, `??=`), `await`,
`yield`, `throw` and ordinary calls add no point in v1. This is a documented
ranking policy rather than a claim of numerically equivalent complexity across
all languages or tools.

Comments, strings, regex literals, template text, JSX text/string attributes and
TypeScript type syntax produce no branch or mutation facts. Runtime expressions
inside template substitutions and JSX expression containers are traversed.

## Mutation policy

Candidates are attached only to a reported executable function:

- Boundary operators: `>=` ↔ `>`, `<=` ↔ `<`.
- Equality: `===` ↔ `!==`, `==` ↔ `!=`.
- Arithmetic: binary `+` ↔ `-`.
- Boolean operators: `&&` ↔ `||`.
- Boolean literals: `true` ↔ `false`.
- Logical not removal: replace unary `!` with one space, preserving lexical
  separation in compact code such as `return!value`. Candidates with a line
  terminator between `!` and the operand are conservatively omitted: removing
  `!` there can expose automatic semicolon insertion or invalid `throw` syntax.
- Numeric literals whose numeric value is 0 or 1: replace with `1` or `0`.
  Noncomputed member receivers use `(1)` or `(0)` so a valid expression such as
  `0x1.toString()` remains parseable. Byte spans still cover only the literal.

No bigint mutations are emitted. Noncomputed property labels, type literals,
regex text and JSX text are excluded. Real operator tokens are found through
Babel tokens, so an identical operator in an intervening comment is not mutated.

Inline callbacks supplied to `test`, `describe`, `it`, common suite/hooks, and member
variants such as `.only`, `.skip`, `.each` (including tagged tables) are excluded
from mutation sites along with their descendants. Namespaced calls such as
`globalThis.test` and **`helpers.test`** are excluded conservatively. A production
API with a method named `test` can therefore suppress inline callback mutations;
this is a deliberate boundary of the conservative v1 policy. These callbacks
still have complexity findings. Arbitrarily aliased testing functions and named
callback references (`const body = () => true; test("case", body)`) are not resolved;
the subject's configuration/imports are never executed. Consumers should also
apply explicit source/test path selection.

The package does not run tests or decide whether a mutant is valid, killed,
survived, timed out or failed infrastructure. Those are the consuming execution
service's responsibilities. Type checking and type-invalid mutation accounting
remain separate from test detection.

## Verification

`npm test` runs the syntax, ownership, byte-custody, mutation and CLI fixtures.
The shared Elixir bridge and its process-lifecycle controls are documented in
[elixir/README.md](elixir/README.md). Both consumers use this package; no scanner
installs dependencies or executes subject configuration.

Parser options are grounded in the [Babel parser documentation](https://babeljs.io/docs/babel-parser).
