#!/usr/bin/env node
// 4lpha skill CLI: self-contained, zero-dependency, Node >= 22.
// Calls one tool on the public 4lpha MCP endpoint (one JSON-RPC `tools/call` over HTTP POST).
// Usage: node cli.mjs <command> [key=value ...]
//        node cli.mjs <command> '<json_params>'
// The same file ships in every 4lpha skill folder so each folder stays self-contained.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.FOURLPHA_MCP_URL || 'https://4lpha.tech/mcp';
const TIMEOUT_MS = 10_000;
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'user-agent': '4lpha-skill/1.0',
};

// command -> MCP tool, allowed arguments, required arguments, numeric arguments
const COMMANDS = {
  'list-agents': { tool: 'list_agents', args: [], required: [] },
  'hire-link': { tool: 'get_hire_link', args: ['agent'], required: ['agent'] },
  'explain-strategy': { tool: 'explain_strategy', args: ['agent'], required: ['agent'] },
  'agent-status': { tool: 'agent_status', args: ['wallet'], required: ['wallet'] },
  'bstock-analysis': { tool: 'bstock_analysis', args: ['token', 'interval'], required: ['token'] },
  'meme-stocks': { tool: 'meme_stocks', args: ['limit', 'orderBy'], required: [], numeric: ['limit'] },
};

function usageError(message) {
  return Object.assign(new Error(message), { exitCode: 1 });
}

// Accepts `key=value` pairs (safe in every shell, including PowerShell 5.1) or one JSON object.
function parseArgs(command, rest) {
  const spec = COMMANDS[command];
  if (!spec) throw usageError(`Unknown command: ${command}. Run with --help for the list.`);
  let params = {};
  if (rest.length === 1 && rest[0].trim().startsWith('{')) {
    try { params = JSON.parse(rest[0]); } catch { throw usageError('Invalid JSON params'); }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw usageError('JSON params must be an object');
  } else {
    for (const pair of rest) {
      const at = pair.indexOf('=');
      if (at <= 0) throw usageError(`Expected key=value, got: ${pair}`);
      params[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  for (const key of Object.keys(params)) {
    if (!spec.args.includes(key)) throw usageError(`Unknown argument for ${command}: ${key} (allowed: ${spec.args.join(', ') || 'none'})`);
  }
  for (const key of spec.required) {
    if (params[key] === undefined || params[key] === '') throw usageError(`Missing required argument for ${command}: ${key}`);
  }
  for (const key of spec.numeric ?? []) {
    if (params[key] === undefined) continue;
    const n = Number(params[key]);
    if (!Number.isInteger(n)) throw usageError(`${key} must be an integer`);
    params[key] = n;
  }
  return { tool: spec.tool, arguments: params };
}

function buildRequest({ tool, arguments: args }) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
}

async function call(request, endpoint = ENDPOINT) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: HEADERS, body: JSON.stringify(request), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw Object.assign(new Error(`Network request to ${endpoint} failed or timed out`), { exitCode: 3 });
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body, reported below */ }
  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    throw Object.assign(new Error(`rate_limited: the 4lpha endpoint allows a few calls per minute; retry after ${retry ?? '60'} s`), { exitCode: 1, body });
  }
  if (res.status >= 400 || body === null) {
    throw Object.assign(new Error(`HTTP ${res.status}${body === null ? ' (non-JSON response)' : ''}`), { exitCode: 1, body });
  }
  if (body.error) throw Object.assign(new Error(`${body.error.message ?? 'error'} (code ${body.error.code ?? '?'})`), { exitCode: 1, body: body.error });
  const content = body.result?.content;
  const first = Array.isArray(content) ? content.find((c) => c && c.type === 'text') : undefined;
  let parsed = body.result ?? null;
  if (first) { try { parsed = JSON.parse(first.text); } catch { parsed = first.text; } }
  // A tool that could not answer returns a normal result flagged isError with {"error":{"code":...}}.
  if (body.result?.isError === true) {
    const code = parsed && typeof parsed === 'object' ? parsed.error?.code : undefined;
    throw Object.assign(new Error(`tool error: ${code ?? 'unknown'}`), { exitCode: 1, body: parsed });
  }
  return parsed;
}

function help() {
  const lines = Object.entries(COMMANDS).map(([name, s]) =>
    `  ${name.padEnd(17)} -> ${s.tool}${s.args.length ? `  args: ${s.args.map((a) => (s.required.includes(a) ? a : `[${a}]`)).join(' ')}` : ''}`);
  return [
    'Usage: node cli.mjs <command> [key=value ...]',
    '       node cli.mjs <command> \'{"key":"value"}\'',
    `Endpoint: ${ENDPOINT} (override with FOURLPHA_MCP_URL)`,
    'Commands:',
    ...lines,
    'Exit codes: 0 ok, 1 usage or upstream error, 3 network error.',
  ].join('\n');
}

export { COMMANDS, parseArgs, buildRequest, call, help, ENDPOINT, TIMEOUT_MS };

function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}

if (isMain()) {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(help());
    process.exit(0);
  }
  try {
    const result = await call(buildRequest(parseArgs(command, rest)));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    if (err.body) console.log(JSON.stringify(err.body, null, 2));
    process.exit(err.exitCode || 1);
  }
}
