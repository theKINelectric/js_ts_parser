#!/usr/bin/env node
import { parseRequest, errorResult, MAX_SOURCE_BYTES } from '../parse.mjs';

// A JSON string can expand a source byte into six bytes (e.g. control escapes).
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 65_536;
let input = Buffer.alloc(0);
let complete = false;

function finish(result) {
  if (complete) return;
  complete = true;
  process.stdin.pause();
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(result.ok ? 0 : 1));
}
function handle(buffer) {
  let request;
  try { request = JSON.parse(buffer.toString('utf8')); }
  catch { finish(errorResult('invalid_json', 'Expected one JSON request line.')); return; }
  finish(parseRequest(request));
}
process.stdin.on('data', chunk => {
  if (complete) return;
  const newline = chunk.indexOf(10);
  const next = newline === -1 ? chunk : chunk.subarray(0, newline);
  if (input.length + next.length > MAX_REQUEST_BYTES) {
    finish(errorResult('request_too_large', 'JSON request exceeds the input limit.', {limit: MAX_REQUEST_BYTES}));
    return;
  }
  input = Buffer.concat([input, next]);
  if (newline !== -1) handle(input);
});
process.stdin.on('end', () => { if (!complete) handle(input); });
process.stdin.on('error', () => finish(errorResult('input_error', 'Could not read the request.')));
