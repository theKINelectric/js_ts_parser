import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../parse.mjs';

const cli = fileURLToPath(new URL('../bin/parser.mjs', import.meta.url));
const parse = (source, filename = 'fixture.ts', more = {}) => parseRequest({ protocol: 1, source, filename, ...more });
const find = (result, name) => result.functions.find(fn => fn.name === name);
const hash = source => createHash('sha256').update(source).digest('hex');

test('protocol includes exact source custody, parser metadata and byte-exclusive sites', () => {
  const source = '// café 🛸\nexport const eligible = (age: number) => age >= 18;';
  const result = parse(source);
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 1);
  assert.equal(result.policy, 'js-ts-ast-v1');
  assert.equal(result.source_sha256, hash(source));
  assert.equal(result.meta.parser, '@babel/parser');
  assert.equal(result.meta.parser_version, '7.29.9');
  assert.equal(result.meta.package_version, '0.1.0');
  const fn = find(result, 'eligible');
  assert.equal(fn.arity, 1);
  assert.equal(fn.line_start, 2);
  assert.equal(fn.line_end, 2);
  assert.equal(fn.complexity, 1);
  assert.equal(Buffer.from(source).subarray(fn.start_byte, fn.end_byte).toString(), '(age: number) => age >= 18');
  const site = result.sites.find(site => site.original === '>=');
  assert.equal(site.replacement, '>');
  assert.equal(site.function, fn.name);
  assert.equal(site.function_start, 2);
  assert.equal(site.function_end, 2);
  assert.equal(Buffer.from(source).subarray(site.byte_start, site.byte_end).toString(), '>=');
  assert.equal(site.byte_start, Buffer.byteLength(source.slice(0, source.indexOf('>='))));
});

test('strict extension modes support JS/TS, JSX/TSX and module variants', () => {
  for (const filename of ['a.js', 'a.mjs', 'a.cjs']) assert.equal(parse('const f = x => x > 1', filename).ok, true, filename);
  for (const filename of ['a.ts', 'a.mts', 'a.cts']) assert.equal(parse('const f = (x: number) => x > 1', filename).ok, true, filename);
  for (const filename of ['a.jsx', 'a.tsx']) assert.equal(parse('const C = () => <span>{true ? 1 : 0}</span>', filename).ok, true, filename);
  for (const filename of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.mts', 'a.cts']) assert.equal(parse('const C = () => <span />', filename).ok, false, filename);
  assert.equal(parse('const f = (x: number) => x', 'a.js').error.code, 'parse_error');
  assert.equal(parse('const f = x => x', 'a.py').error.code, 'unsupported_extension');
  assert.equal(parse('const f = x => x', 'a.ts', { language: 'javascript' }).error.code, 'language_mismatch');
});

test('declaration files, overloads and type-level functions are not executable findings', () => {
  for (const filename of ['a.d.ts', 'a.d.mts', 'a.d.cts']) {
    const result = parse('declare function only(x: number): boolean;', filename);
    assert.equal(result.ok, true);
    assert.deepEqual(result.functions, []);
    assert.deepEqual(result.sites, []);
    assert.equal(result.skipped[0].reason, 'declaration_file');
  }
  const result = parse(`
    interface Contract { run(x: true): 0 | 1; }
    type Result<T> = T extends true ? 1 : 0;
    declare function declared(x: number): boolean;
    function run(x: string): string;
    function run(x: number): number;
    function run(x: string | number) { return x === 0 ? 1 : 0; }
  `);
  assert.equal(result.ok, true);
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].name, 'run');
  assert.equal(result.functions[0].complexity, 2);
  assert.equal(result.sites.length, 4);
});

test('branches belong only to their innermost function, including expression arrows', () => {
  const result = parse(`
    function outer(items: number[]) {
      if (items.length) {
        return items.map(x => x > 0 && x < 10 ? 1 : 0);
      }
      function inner(x: number) { return x ?? 1; }
      return inner(0);
    }
  `);
  assert.equal(result.ok, true);
  assert.equal(result.functions.length, 3);
  const outer = find(result, 'outer');
  assert.equal(outer.complexity, 2);
  const callback = result.functions.find(fn => fn.name.includes('callback#1'));
  assert.ok(callback.name.startsWith('outer.'));
  assert.equal(callback.complexity, 3);
  assert.equal(find(result, 'outer.inner').complexity, 2);
  assert.deepEqual(callback.branches.map(b => b.kind).sort(), ['&&', 'ternary']);
  assert.equal(new Set(result.functions.map(fn => fn.id)).size, result.functions.length);
});

test('class/object/private/accessor/constructor and assignment functions have unique qualified names', () => {
  const result = parse(`
    class Box {
      constructor(public value: number = 0) {}
      #check(x: number) { return x >= 1; }
      get valueNow() { return this.value || 0; }
      set valueNow(next: number) { if (next) this.value = next; }
      static from = (x: number) => x ? 1 : 0;
    }
    const tools = { run(x: number) { return x < 1; }, check: (x: number) => !x };
    tools.extra = function (x) { return x + 1; };
    export default function () { return true; }
  `);
  assert.equal(result.ok, true);
  assert.deepEqual(result.functions.map(fn => fn.name), [
    'Box.constructor', 'Box.#check', 'Box.get valueNow', 'Box.set valueNow',
    'Box.from', 'tools.run', 'tools.check', 'tools.extra', 'default',
  ]);
  assert.equal(find(result, 'Box.constructor').arity, 1);
  assert.equal(find(result, 'Box.get valueNow').module, 'Box');
  assert.equal(find(result, 'tools.check').module, 'tools');
});

test('anonymous callbacks on the same line and duplicate declarations remain deterministic and unique', () => {
  const source = 'function run(xs) { xs.map(x => x ? 1 : 0); xs.map(x => x ? 0 : 1); { const duplicate = () => true; } { const duplicate = () => false; } }';
  const first = parse(source, 'a.js');
  const second = parse(source, 'a.js');
  assert.deepEqual(first, second);
  assert.equal(first.functions.length, 5);
  assert.equal(new Set(first.functions.map(fn => fn.name)).size, 5);
  assert.equal(first.functions.filter(fn => fn.name.includes('callback#')).length, 2);
  assert.deepEqual(first.functions.map(fn => fn.complexity), [1, 2, 2, 1, 1]);
});

test('documented complexity policy counts loops, arms, conditionals, boolean fallbacks and optional chains', () => {
  const source = `function policy(x) {
    if (x) {}
    for (;;) { break; }
    for (const y in x) {}
    for (const y of x) {}
    while (x) { break; }
    do {} while (x);
    try {} catch (e) {}
    switch (x) { case 0: break; default: break; }
    const a = x && 1, b = x || 1, c = x ?? 1;
    const d = x ? 1 : 0;
    return x?.value?.();
  }`;
  const result = parse(source, 'a.js');
  const fn = result.functions[0];
  assert.equal(result.ok, true);
  assert.equal(fn.complexity, 16);
  assert.deepEqual(fn.branches.reduce((m, b) => ({...m, [b.kind]: (m[b.kind] || 0) + 1}), {}), {
    if: 1, for: 3, while: 1, do: 1, catch: 1, 'switch arm': 2,
    '&&': 1, '||': 1, '??': 1, ternary: 1, 'optional chain': 2,
  });
  assert.equal(fn.complexity, 1 + fn.branches.length);
});

test('comments, regex, strings, template text, JSX text and type literals do not create branches or sites', () => {
  const source = `
    type T = true | false | 0 | 1;
    function render(x: T): JSX.Element {
      // if && >= 0 true
      const r = /true|false|>=|0|1/;
      const text = "if && >= 0 true";
      const template = \`if && >= 0 true \${x ? 1 : 0}\`;
      const object = { 0: text, 1: text };
      return <span title="true false >= 0 1">if &amp;&amp; true 0 1{x === 0 ? true : false}</span>;
    }
  `;
  const result = parse(source, 'a.tsx');
  assert.equal(result.ok, true);
  assert.equal(result.functions[0].complexity, 3);
  assert.deepEqual(result.sites.map(site => site.original), ['1', '0', '===', '0', 'true', 'false']);
});

test('all safe operator mutations preserve exact original bytes even with comments and Unicode', () => {
  const source = `function f(x) { const text = '🛸'; return x >= 2 || x > 2 || x <= 2 || x < 2 || x === 2 || x !== 2 || x == 2 || x != 2 || x /* gap */ + /* gap */ 2 - 2 || true && false || !x || 0 || 1 || 0n || 1n; }`;
  const result = parse(source, 'a.js');
  assert.equal(result.ok, true);
  const sites = result.sites;
  for (const site of sites) {
    assert.equal(Buffer.from(source).subarray(site.byte_start, site.byte_end).toString(), site.original);
    assert.ok(site.byte_start >= 0 && site.byte_end > site.byte_start);
    assert.equal(site.function, 'f');
  }
  const pairs = new Set(sites.map(site => `${site.original}:${site.replacement}`));
  for (const pair of ['>=:>', '>:>=', '<=:<', '<:<=', '===:!==', '!==:===', '==:!=', '!=:==', '+:-', '-:+', 'true:false', 'false:true', '&&:||', '||:&&', '!: ','0:1','1:0']) assert.ok(pairs.has(pair), pair);
  assert.equal(sites.filter(site => site.original.endsWith('n')).length, 0);
});

test('test/describe/it callbacks and their descendants never become mutation candidates', () => {
  const source = `
    function production(x) { return x >= 0; }
    describe('suite', () => {
      function nested(x) { return x >= 0; }
      it.skip('case', function () { return true && false; });
    });
    test.each([1])('case', x => x ? 1 : 0);
    it('case', () => [1].map(x => x + 1));
  `;
  const result = parse(source, 'a.js');
  assert.equal(result.ok, true);
  assert.ok(result.functions.length >= 7);
  assert.deepEqual(new Set(result.sites.map(site => site.function)), new Set(['production']));
  assert.ok(result.functions.find(fn => fn.name.includes('nested')).complexity >= 1);
});

test('TS runtime wrappers retain executable expressions while type-only literals stay excluded', () => {
  const result = parse(`function f(x: number | undefined) {
    const a = ((x ?? 0) as number) satisfies number;
    const b = x!;
    const c = <number>(x ?? 1);
    return a >= 1 ? true : false;
  }`);
  assert.equal(result.ok, true);
  assert.equal(result.functions[0].complexity, 4);
  assert.equal(result.sites.filter(site => site.original === '!').length, 0);
  assert.ok(result.sites.some(site => site.original === '>='));
});

test('invalid protocol, malformed syntax and source limit produce structured errors', () => {
  for (const request of [null, [], {}, { protocol: 2, source: '', filename: 'a.js' }, { protocol: 1, source: 1, filename: 'a.js' }]) {
    const result = parseRequest(request);
    assert.equal(result.ok, false);
    assert.equal(result.protocol, 1);
    assert.equal(result.error.code, 'invalid_request');
  }
  const malformed = parse('function broken( {');
  assert.equal(malformed.error.code, 'parse_error');
  assert.equal(typeof malformed.error.line, 'number');
  assert.equal(parse('🛸'.repeat(400000)).error.code, 'source_too_large');
});

test('CLI consumes one JSON line without waiting for EOF and never executes project files or config', async () => {
  const { spawn } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'js-ts-parser-custody-'));
  try {
    const marker = join(root, 'EXECUTED');
    writeFileSync(join(root, 'babel.config.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'config')`);
    writeFileSync(join(root, 'subject.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'import')`);
    const source = "import './subject.js'; export function f(x) { return x >= 1; }";
    const child = spawn(process.execPath, [cli], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.write(JSON.stringify({protocol: 1, source, filename: join(root, 'fixture.js')}) + '\n');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI waited for EOF')); }, 3000);
      child.on('close', code => { clearTimeout(timer); resolve(code); });
      child.on('error', reject);
    });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).source_sha256, hash(source));
    assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal(stderr, '');
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('CLI errors remain a single JSON line with nonzero exit, including malformed JSON', () => {
  for (const input of ['{bad}\n', JSON.stringify({protocol: 1, source: 'function (', filename: 'a.js'}) + '\n', '']) {
    const child = spawnSync(process.execPath, [cli], {input, encoding: 'utf8'});
    assert.notEqual(child.status, 0);
    assert.equal(child.stderr, '');
    assert.equal(JSON.parse(child.stdout).ok, false);
    assert.equal(child.stdout.trim().split('\n').length, 1);
  }
});

test('CRLF lines, emoji identifiers, optional flags and contextual TS types preserve facts', () => {
  const source = '// 🛸 café\r\nfunction check(你好: true | 1): true {\r\n  return 你好?.value.method?.() || true;\r\n}\r\n';
  const result = parse(source);
  assert.equal(result.ok, true);
  assert.equal(result.functions[0].line_start, 2);
  assert.equal(result.functions[0].line_end, 4);
  assert.equal(result.functions[0].complexity, 4);
  assert.deepEqual(result.sites.map(site => site.original), ['||', 'true']);
  for (const site of result.sites) {
    assert.equal(site.line, 3);
    assert.equal(Buffer.from(source).subarray(site.byte_start, site.byte_end).toString(), site.original);
  }
});

test('type wrappers retain assigned function names and ! removal preserves token boundaries', () => {
  const source = 'const first = ((x: boolean) => {return!x}) satisfies (x: boolean) => boolean; const second = <(x: boolean) => boolean>((x: boolean) => typeof!x);';
  const result = parse(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.functions.map(fn => fn.name), ['first', 'second']);
  for (const site of result.sites.filter(site => site.operator === '!')) {
    assert.equal(site.replacement, ' ');
    const buffer = Buffer.from(source);
    const mutated = Buffer.concat([buffer.subarray(0, site.byte_start), Buffer.from(site.replacement), buffer.subarray(site.byte_end)]).toString();
    assert.equal(parse(mutated).ok, true);
    assert.ok(mutated.includes(site.function === 'first' ? 'return x' : 'typeof x'));
  }
});

test('test member and tagged-each callbacks are excluded including nested descendants', () => {
  const result = parse("test.only('a', () => { function inner() { return true; } }); it.each`x`('b', () => false); globalThis.test('c', () => 1);", 'a.js');
  assert.equal(result.ok, true);
  assert.equal(result.functions.length, 4);
  assert.deepEqual(result.sites, []);
});

test('maximum source bytes apply equally to the importable API and JSON CLI', () => {
  const source = '// ' + 'a'.repeat(1_500_000);
  const request = {protocol: 1, source, filename: 'a.js'};
  const result = parseRequest(request);
  assert.equal(result.error.code, 'source_too_large');
  const child = spawnSync(process.execPath, [cli], {input: JSON.stringify(request) + '\n', encoding: 'utf8'});
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).error.code, 'source_too_large');
  for (const filename of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) assert.equal(parse('', filename, {language: 'typescript'}).error.code, 'language_mismatch');
  for (const filename of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.ts']) assert.equal(parse('', filename, {language: 'javascript'}).error.code, 'language_mismatch');
});

test('runtime TypeScript namespaces preserve functions while ambient namespaces and types remain excluded', () => {
  const result = parse(`
    namespace Service.Inner {
      export function alive(x: number): boolean { return x >= 1; }
      export const ready = (x: number) => x ? true : false;
      export type Signature = (x: true) => 0 | 1;
    }
    declare namespace Ambient { function invisible(x: number): boolean; }
  `);
  assert.equal(result.ok, true);
  assert.deepEqual(result.functions.map(fn => fn.name), ['Service.Inner.alive', 'Service.Inner.ready']);
  assert.equal(result.sites.length, 4);
  assert.ok(result.functions.every(fn => fn.module === 'Service.Inner'));
});

test('class instance fields are not attributed to the containing factory function', () => {
  const result = parse(`function factory(x) {
    class Inner {
      field = x ? 1 : 0;
      arrow = () => x ? 1 : 0;
      [x ? 'a' : 'b']() { return true; }
    }
    return Inner;
  }`, 'a.js');
  assert.equal(result.ok, true);
  assert.equal(find(result, 'factory').complexity, 2);
  assert.equal(find(result, 'factory.Inner.arrow').complexity, 2);
  assert.equal(result.sites.filter(site => site.function === 'factory').length, 0);
});

test('synthetic duplicate suffixes cannot collide with explicit property names', () => {
  for (const source of [
    'const obj = { run(){return true}, run(){return false}, "run#2"(){return true} };',
    'const obj = { "run#2"(){return true}, run(){return true}, run(){return false}, "run#3"(){return true} };',
    'const obj = { "run#2#2"(){return true}, run(){return true}, run(){return false}, "run#2"(){return true} };',
  ]) {
    const result = parse(source, 'a.js');
    assert.equal(result.ok, true);
    assert.equal(new Set(result.functions.map(fn => fn.id)).size, result.functions.length);
    assert.equal(new Set(result.functions.map(fn => fn.name)).size, result.functions.length);
    assert.deepEqual(result, parse(source, 'a.js'));
  }
});

test('unary removal with newline trivia is omitted rather than creating ASI or throw syntax errors', () => {
  for (const source of [
    'function f(){throw!\ntrue}',
    'function f(){return!\ntrue}',
    'function f(){throw!/*\n comment */true}',
    'function f(){return!\u2028true}',
    'function f(){return!\u2029true}',
  ]) {
    const result = parse(source, 'a.js');
    assert.equal(result.ok, true);
    assert.equal(result.sites.filter(site => site.operator === '!').length, 0);
    assert.ok(result.sites.some(site => site.original === 'true'));
  }
});

test('numeric member receivers remain syntactically valid after literal mutation', () => {
  for (const original of ['0x1', '1e0', '0b1', '0o1', '0x0', '0.0', '1.0', '1.']) {
    const source = `function f(){return ${original}.toString()}`;
    const result = parse(source, 'a.js');
    assert.equal(result.ok, true, source);
    assert.ok(result.sites.some(site => site.operator === 'number'), source);
    for (const site of result.sites) {
      const b = Buffer.from(source);
      assert.equal(b.subarray(site.byte_start, site.byte_end).toString(), site.original);
      const mutated = Buffer.concat([b.subarray(0, site.byte_start), Buffer.from(site.replacement), b.subarray(site.byte_end)]).toString();
      assert.equal(parse(mutated, 'a.js').ok, true, mutated);
    }
  }
});

test('T8: unreported runtime module expressions produce one explicit skip and no synthetic function', () => {
  const result = parse('const x = a > 1 ? 2 : 3; const y = false || true; const z = 0;', 'a.js');
  assert.equal(result.ok, true);
  assert.deepEqual(result.functions, []);
  assert.deepEqual(result.sites, []);
  assert.deepEqual(result.skipped, [{reason: 'module_scope'}]);
  const mixed = parse('const ready = true; function inside(x) { return x > 1; }', 'a.js');
  assert.equal(mixed.functions.length, 1);
  assert.equal(mixed.sites.length, 2);
  assert.deepEqual(mixed.skipped, [{reason: 'module_scope'}]);
  const typeOnly = parse('type T = true | false | 0 | 1; interface I { call(): 0 | 1; }');
  assert.deepEqual(typeOnly.skipped, []);
});

test('T9: declaration-file skip explicitly says syntax was not checked, even for malformed text', () => {
  for (const filename of ['broken.d.ts', 'broken.d.mts', 'broken.d.cts']) {
    const result = parse('%%%', filename);
    assert.equal(result.ok, true);
    assert.deepEqual(result.functions, []);
    assert.deepEqual(result.sites, []);
    assert.deepEqual(result.skipped, [{reason: 'declaration_file', syntax_checked: false}]);
  }
});

test('T10: helpers.test inline callback suppression is deliberately conservative', () => {
  const result = parse("helpers.test('c', () => a > 1)", 'a.js');
  assert.equal(result.ok, true);
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].name, 'helpers.test.callback#1');
  assert.deepEqual(result.sites, []);
});

test('T11: exact maximum valid source succeeds through both API and CLI', () => {
  const source = '//' + 'a'.repeat(1_499_998);
  assert.equal(Buffer.byteLength(source), 1_500_000);
  const request = {protocol: 1, source, filename: 'a.js'};
  assert.equal(parseRequest(request).ok, true);
  const result = spawnSync(process.execPath, [cli], {input: JSON.stringify(request) + '\n', encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const over = {...request, source: source + 'a'};
  assert.equal(parseRequest(over).error.code, 'source_too_large');
  const tooLarge = spawnSync(process.execPath, [cli], {input: JSON.stringify(over) + '\n', encoding: 'utf8'});
  assert.equal(tooLarge.status, 1);
  assert.equal(JSON.parse(tooLarge.stdout).error.code, 'source_too_large');
});

test('T12: two JSON lines are a single-shot request, response and exit for the first line only', () => {
  const first = {protocol: 1, source: 'function first() { return true; }', filename: 'first.js'};
  const second = {protocol: 1, source: 'function second() { return false; }', filename: 'second.js'};
  for (const suffix of [JSON.stringify(second), '{malformed}']) {
    const result = spawnSync(process.execPath, [cli], {input: JSON.stringify(first) + '\n' + suffix + '\n', encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.functions.map(fn => fn.name), ['first']);
    assert.equal(parsed.source_sha256, hash(first.source));
  }
});
