// Read-only diagnostic of fixed, publicly documented sellers. No wallet/config load.
import { readIdentity } from '../../4lphaDATA-marketplace/src/studio/registry.ts';
import { postJson } from '../../4lphaDATA-marketplace/src/studio/http.ts';

const rpc = 'https://bsc-dataseed.binance.org/';
const candidates = [
  { id: '269223', name: 'ChainHelix Rebalancer', card: 'https://agents.chainhelix.io/rebalancer/.well-known/agent-card.json' },
  { id: '269228', name: 'ChainHelix Health Monitor', card: 'https://agents.chainhelix.io/healthmon/.well-known/agent-card.json' },
  { id: '269226', name: 'ChainHelix Yield Allocator', card: 'https://agents.chainhelix.io/yieldopt/.well-known/agent-card.json' },
];
async function publicJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); return { status: response.status, body: null }; }
  const reader = response.body?.getReader();
  if (!reader) throw Error('empty_response');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) throw Error('response_too_large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
const results = [];
for (const target of candidates) {
  try {
    const identity = await readIdentity(target.id, rpc, AbortSignal.timeout(20000), postJson);
    const prefix = 'data:application/json;base64,';
    if (!identity.agentURI.startsWith(prefix) || identity.agentURI.length > 65536) throw Error('unsupported_metadata');
    const metadata = JSON.parse(Buffer.from(identity.agentURI.slice(prefix.length), 'base64').toString('utf8'));
    if (!Array.isArray(metadata.services) || !metadata.services.some(s => s?.name === 'A2A' && s.endpoint === target.card)) throw Error('endpoint_changed');
    const card = await publicJson(target.card);
    results.push({ seller: target.name, id: target.id, chain: 56, registry: 'PASS',
      cardHttp: card.status, cardName: typeof card.body?.name === 'string' ? card.body.name.slice(0,200) : null,
      currentMcpBackend: metadata.services.some(s => s?.name === 'MCP') ? 'REQUIRES_NEW_MCP_CHECK' : 'UNSUPPORTED_A2A_ONLY' });
  } catch { results.push({ seller: target.name, id: target.id, result: 'READ_FAILED_OR_METADATA_CHANGED' }); }
}
try {
  const response = await publicJson('https://bnbagent-api.bnbchain.world/v1/rt/01M1DKG8MKDB3N17RTMRYDQ9XA/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '4lpha-readonly-diagnostic', version: '1.0.0' },
    } }),
  });
  results.push({ seller: 'Qwibi', documentedId: '2052', documentedChain: 97, initializeHttp: response.status,
    currentMcpBackend: response.status === 401 ? 'UNSUPPORTED_TESTNET_AND_AUTH' : 'UNSUPPORTED_TESTNET' });
} catch { results.push({ seller: 'Qwibi', result: 'ENDPOINT_READ_FAILED' }); }
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), acceptance: 'NOT_PASSED', results,
  note: 'Registry/card availability is not MCP acceptance. No tools, jobs, signing or payments were invoked.' }, null, 2));
process.exitCode = 2;
