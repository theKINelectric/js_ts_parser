import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);
const parserVersion = require('@babel/parser/package.json').version;
const packageVersion = require('./package.json').version;
export const PROTOCOL = 1;
export const POLICY = 'js-ts-ast-v1';
export const MAX_SOURCE_BYTES = 1_500_000;

const MODES = Object.freeze({
  '.js': {language: 'javascript'}, '.mjs': {language: 'javascript', module: true},
  '.cjs': {language: 'javascript', commonjs: true}, '.jsx': {language: 'javascript', jsx: true},
  '.ts': {language: 'typescript'}, '.mts': {language: 'typescript', module: true, noAmbiguous: true},
  '.cts': {language: 'typescript', commonjs: true, noAmbiguous: true}, '.tsx': {language: 'typescript', jsx: true},
});
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const TYPE_WRAPPERS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression',
  'TSSatisfiesExpression', 'TSInstantiationExpression']);
const TEST_CALLS = new Set(['test', 'describe', 'it', 'suite', 'context', 'specify',
  'before', 'after', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const OPERATOR_REPLACEMENTS = Object.freeze({
  '>=': '>', '>': '>=', '<=': '<', '<': '<=', '===': '!==', '!==': '===',
  '==': '!=', '!=': '==', '+': '-', '-': '+', '&&': '||', '||': '&&',
});
const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'extra', 'tokens', 'comments',
  'leadingComments', 'trailingComments', 'innerComments', 'typeAnnotation', 'returnType',
  'typeParameters', 'typeArguments', 'implements', 'superTypeParameters']);

export function errorResult(code, message, details = {}) {
  return {ok: false, protocol: PROTOCOL, error: {code, message, ...details}};
}

/** Parse only caller-supplied source. This never reads a subject file or loads its config. */
export function parseRequest(request) {
  if (!request || Array.isArray(request) || typeof request !== 'object' || request.protocol !== PROTOCOL ||
      typeof request.source !== 'string' || typeof request.filename !== 'string' || !request.filename ||
      (request.language !== undefined && !['javascript', 'typescript'].includes(request.language))) {
    return errorResult('invalid_request', 'Expected protocol 1, string source, filename and optional javascript/typescript language.');
  }
  const {source, filename} = request;
  const byteLength = Buffer.byteLength(source, 'utf8');
  if (byteLength > MAX_SOURCE_BYTES) return errorResult('source_too_large', `Source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes.`, {limit: MAX_SOURCE_BYTES, bytes: byteLength});
  const mode = MODES[extname(filename)];
  if (!mode) return errorResult('unsupported_extension', 'Expected .js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts filename.');
  if (request.language && request.language !== mode.language) return errorResult('language_mismatch', 'Filename extension and requested language disagree.');
  const result = {
    ok: true, protocol: PROTOCOL, policy: POLICY,
    source_sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    meta: {parser: '@babel/parser', parser_version: parserVersion, package_version: packageVersion, language: mode.language,
      syntax: mode.jsx ? (mode.language === 'typescript' ? 'tsx' : 'jsx') : mode.language},
    functions: [], sites: [], skipped: [],
  };
  if (/\.d\.(?:ts|mts|cts)$/.test(filename)) {
    result.skipped.push({reason: 'declaration_file', syntax_checked: false});
    return result;
  }
  try {
    const plugins = [];
    if (mode.language === 'typescript') plugins.push(['typescript', {disallowAmbiguousJSXLike: !!mode.noAmbiguous}]);
    if (mode.jsx) plugins.push('jsx');
    const ast = parse(source, {
      sourceType: mode.module ? 'module' : mode.commonjs ? 'commonjs' : 'unambiguous',
      sourceFilename: filename, plugins, tokens: true, errorRecovery: false,
      attachComment: false, createImportExpressions: true,
    });
    const state = makeState(source, ast.tokens, result);
    visit(ast.program, {scope: '', owner: null, excluded: false}, null, '', state);
    result.functions.sort((a, b) => a.start_byte - b.start_byte || a.name.localeCompare(b.name));
    result.sites.sort((a, b) => a.byte_start - b.byte_start || a.replacement.localeCompare(b.replacement));
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) return errorResult('parse_error', String(error.message), {
      line: error.loc?.line ?? 1, column: error.loc?.column ?? 0,
    });
    // The public CLI must not print stack traces or source contents on stdout/stderr.
    return errorResult('parser_error', error instanceof RangeError ? 'Parser nesting limit exceeded.' : 'Unable to produce parser facts.');
  }
}

function makeState(source, tokens, result) {
  // Babel offsets count UTF-16 code units. Consumers mutate UTF-8 byte strings.
  // Convert once in linear time, including the interior surrogate offset defensively.
  const offsets = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let i = 0; i < source.length;) {
    offsets[i] = bytes;
    const point = source.codePointAt(i);
    const width = point > 0xffff ? 2 : 1;
    if (width === 2) offsets[i + 1] = bytes;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    i += width;
    offsets[i] = bytes;
  }
  return {source, tokens, result, offsets, names: new Map(), emittedNames: new Set(), anonymous: new Map(), moduleScopeSkipped: false};
}

function visit(node, context, parent, key, state) {
  if (!node || typeof node.type !== 'string') return;
  if (node.declare === true) return;
  if (TYPE_WRAPPERS.has(node.type)) {
    // Type wrappers do not create runtime scopes or erase the binding of an arrow.
    visit(node.expression, context, parent, key, state);
    return;
  }
  if (node.type === 'TSParameterProperty') {
    visit(node.parameter, context, node, 'parameter', state);
    return;
  }
  if (node.type === 'TSModuleDeclaration' && node.id.type === 'Identifier') {
    visit(node.body, {...context, scope: qualify(context.scope, node.id.name), owner: null}, node, 'body', state);
    return;
  }
  if (node.type === 'TSModuleBlock') {
    for (const child of node.body) visit(child, context, node, 'body', state);
    return;
  }
  if (node.type === 'TSEnumDeclaration') {
    const enumContext = {...context, scope: qualify(context.scope, node.id.name)};
    for (const member of node.members) visit(member.initializer, enumContext, member, 'initializer', state);
    return;
  }
  if (node.type === 'TSExportAssignment') {
    visit(node.expression, context, node, 'expression', state);
    return;
  }
  if (node.type.startsWith('TS')) return;
  if (FUNCTION_TYPES.has(node.type)) {
    visitFunction(node, context, parent, key, state);
    return;
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    // A superclass, computed method name and decorator execute in the enclosing scope.
    visit(node.superClass, context, node, 'superClass', state);
    for (const decorator of node.decorators ?? []) visit(decorator, context, node, 'decorators', state);
    const name = node.id?.name ?? bindingName(parent, key, state) ?? anonymousName(context.scope, 'class', state);
    visit(node.body, {...context, scope: qualify(context.scope, name)}, node, 'body', state);
    return;
  }
  if (['ClassProperty', 'ClassPrivateProperty', 'PropertyDefinition'].includes(node.type)) {
    if (node.computed) visit(node.key, context, node, 'key', state);
    for (const decorator of node.decorators ?? []) visit(decorator, context, node, 'decorators', state);
    // Instance initializers run on construction, not when the enclosing factory runs.
    // No synthetic constructor finding is invented; explicit arrow/function fields
    // still create and own their own findings when traversed under this scope.
    visit(node.value, node.static ? context : {...context, owner: null}, node, 'value', state);
    return;
  }
  let nextContext = context;
  if (node.type === 'ObjectExpression') {
    const name = bindingName(parent, key, state);
    if (name) nextContext = {...context, scope: qualify(context.scope, name)};
  }
  if (context.owner) {
    const branch = branchKind(node);
    if (branch) addBranch(node, branch, context.owner, state);
    if (!context.excluded) addSites(node, context.owner, state, parent, key);
  } else if (!state.moduleScopeSkipped && (branchKind(node) || hasCandidateSyntax(node, state))) {
    // Explicitly expose executable syntax excluded by the per-function scope.
    // No synthetic module/initializer function or mutation is introduced.
    state.result.skipped.push({reason: 'module_scope'});
    state.moduleScopeSkipped = true;
  }
  for (const [childKey, value] of Object.entries(node)) {
    if (IGNORED_KEYS.has(childKey)) continue;
    // Property labels are names rather than executable numeric/boolean expressions.
    if (childKey === 'key' && node.computed !== true &&
        ['ObjectProperty', 'ClassProperty', 'ClassPrivateProperty', 'PropertyDefinition'].includes(node.type)) continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, nextContext, node, childKey, state);
    } else if (value && typeof value.type === 'string') visit(value, nextContext, node, childKey, state);
  }
}

function visitFunction(node, context, parent, key, state) {
  if (!node.body) return; // overloads and abstract/ambient signatures have no executable body.
  if (node.computed) visit(node.key, context, node, 'key', state);
  for (const decorator of node.decorators ?? []) visit(decorator, context, node, 'decorators', state);
  let local;
  if (node.type.endsWith('Method')) {
    local = propertyName(node.key, state);
    if (node.kind === 'get' || node.kind === 'set') local = `${node.kind} ${local}`;
  } else {
    local = bindingName(parent, key, state) ?? node.id?.name;
    if (!local) {
      const label = parent?.type === 'CallExpression' || parent?.type === 'OptionalCallExpression'
        ? `${calleeName(parent.callee, state)}.callback` : 'anonymous';
      local = anonymousName(context.scope, label, state);
    }
  }
  const candidate = qualify(context.scope, local);
  let count = state.names.get(candidate) ?? 0;
  let name;
  do {
    count++;
    name = count === 1 ? candidate : `${candidate}#${count}`;
  } while (state.emittedNames.has(name));
  state.names.set(candidate, count);
  state.emittedNames.add(name);
  const fn = {
    id: name, name, module: context.scope,
    line_start: node.loc.start.line, line_end: node.loc.end.line,
    start_byte: state.offsets[node.start], end_byte: state.offsets[node.end],
    arity: node.params.length, complexity: 1, branches: [],
  };
  state.result.functions.push(fn);
  const excluded = context.excluded || isTestCallback(node, parent, key);
  const childContext = {owner: fn, scope: name, excluded};
  for (const parameter of node.params) visit(parameter, childContext, node, 'params', state);
  visit(node.body, childContext, node, 'body', state);
}

function qualify(scope, local) { return scope ? `${scope}.${local}` : local; }
function anonymousName(scope, label, state) {
  const counterKey = qualify(scope, label);
  const ordinal = (state.anonymous.get(counterKey) ?? 0) + 1;
  state.anonymous.set(counterKey, ordinal);
  return `${label}#${ordinal}`;
}
function bindingName(parent, key, state) {
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && key === 'init') return parent.id.type === 'Identifier' ? parent.id.name : null;
  if (parent.type === 'AssignmentExpression' && key === 'right') return expressionName(parent.left, state);
  if (['ObjectProperty', 'ClassProperty', 'ClassPrivateProperty', 'PropertyDefinition'].includes(parent.type) && key === 'value') return propertyName(parent.key, state);
  if (parent.type === 'ExportDefaultDeclaration') return 'default';
  return null;
}
function propertyName(node, state) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'PrivateName') return `#${node.id.name}`;
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return String(node.value);
  return `[${state.source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 100)}]`;
}
function expressionName(node, state) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const object = expressionName(node.object, state);
    const property = propertyName(node.property, state);
    return node.computed ? `${object}[${property}]` : `${object}.${property}`;
  }
  if (node.type === 'ThisExpression') return 'this';
  return 'expression';
}
function calleeName(node, state) {
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return calleeName(node.callee, state);
  if (node.type === 'TaggedTemplateExpression') return calleeName(node.tag, state);
  return expressionName(node, state);
}
function rootCallee(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const property = node.computed ? node.property.value : node.property.name;
    return TEST_CALLS.has(property) ? property : rootCallee(node.object);
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return rootCallee(node.callee);
  if (node.type === 'TaggedTemplateExpression') return rootCallee(node.tag);
  return null;
}
function isTestCallback(_node, parent, key) {
  return key === 'arguments' && ['CallExpression', 'OptionalCallExpression'].includes(parent?.type) && TEST_CALLS.has(rootCallee(parent.callee));
}

function branchKind(node) {
  switch (node.type) {
    case 'IfStatement': return 'if';
    case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': return 'for';
    case 'WhileStatement': return 'while';
    case 'DoWhileStatement': return 'do';
    case 'CatchClause': return 'catch';
    case 'ConditionalExpression': return 'ternary';
    case 'SwitchCase': return 'switch arm';
    case 'LogicalExpression': return node.operator;
    case 'OptionalCallExpression': case 'OptionalMemberExpression': return node.optional ? 'optional chain' : null;
    default: return null;
  }
}
function addBranch(node, kind, owner, state) {
  owner.branches.push({kind, line: node.loc.start.line, start_byte: state.offsets[node.start], end_byte: state.offsets[node.end]});
  owner.complexity++;
}
function hasCandidateSyntax(node, state) {
  if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && OPERATOR_REPLACEMENTS[node.operator]) return true;
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return !/[\n\r\u2028\u2029]/.test(state.source.slice(node.start + 1, node.argument.start));
  }
  return node.type === 'BooleanLiteral' || (node.type === 'NumericLiteral' && (node.value === 0 || node.value === 1));
}
function addSites(node, owner, state, parent, key) {
  if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && OPERATOR_REPLACEMENTS[node.operator]) {
    const token = operatorToken(node, state);
    if (token) addSite(token.start, token.end, node.operator, OPERATOR_REPLACEMENTS[node.operator], owner, state, token.loc.start.line);
  } else if (node.type === 'UnaryExpression' && node.operator === '!') {
    // A blank preserves token boundaries in compact `return!x` and `typeof!x`.
    // If a line terminator separates ! and its operand, removing ! may expose
    // ASI (`return!\nx`) or an illegal throw newline. Omit that candidate.
    if (!/[\n\r\u2028\u2029]/.test(state.source.slice(node.start + 1, node.argument.start))) {
      addSite(node.start, node.start + 1, '!', ' ', owner, state, node.loc.start.line);
    }
  } else if (node.type === 'BooleanLiteral') {
    addSite(node.start, node.end, 'boolean', node.value ? 'false' : 'true', owner, state, node.loc.start.line);
  } else if (node.type === 'NumericLiteral' && (node.value === 0 || node.value === 1)) {
    let replacement = node.value === 0 ? '1' : '0';
    // `0x1.toString()` is legal; replacing 0x1 with bare 0 would make `0.to`
    // an invalid decimal token. Parentheses preserve receiver syntax.
    if (key === 'object' && ['MemberExpression', 'OptionalMemberExpression'].includes(parent?.type) && !parent.computed) {
      replacement = `(${replacement})`;
    }
    addSite(node.start, node.end, 'number', replacement, owner, state, node.loc.start.line);
  }
}
function operatorToken(node, state) {
  // Comments may contain the same operator. Babel tokens identify the real one.
  let low = 0, high = state.tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (state.tokens[mid].start < node.left.end) low = mid + 1; else high = mid;
  }
  for (let i = low; i < state.tokens.length && state.tokens[i].start < node.right.start; i++) {
    const token = state.tokens[i];
    if (token.type && typeof token.type === 'object' && state.source.slice(token.start, token.end) === node.operator) return token;
  }
  return null;
}
function addSite(start, end, operator, replacement, owner, state, line) {
  state.result.sites.push({
    function: owner.name, function_start: owner.line_start, function_end: owner.line_end,
    line, byte_start: state.offsets[start], byte_end: state.offsets[end], operator,
    original: state.source.slice(start, end), replacement,
  });
}
