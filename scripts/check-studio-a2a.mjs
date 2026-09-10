// Fixed public mainnet sellers; local cache/API only. No task calls, keys or production configuration.
import { studioConfig } from '../../4lphaDATA-marketplace/src/studio/config.ts';
import { studioJob } from '../../4lphaDATA-marketplace/src/studio/catalog.ts';
import { MemoryStore } from '../../4lphaDATA-marketplace/src/core/store.ts';
import { createScheduler } from '../../4lphaDATA-marketplace/src/core/scheduler.ts';
import { createServer } from '../../4lphaDATA-marketplace/src/server.ts';
import { readStudioCatalog } from './studio-catalog.ts';

const targets = [
  { id: '269223', a2aCardUrl: 'https://agents.chainhelix.io/rebalancer/.well-known/agent-card.json' },
  { id: '269228', a2aCardUrl: 'https://agents.chainhelix.io/healthmon/.well-known/agent-card.json' },
  { id: '269226', a2aCardUrl: 'https://agents.chainhelix.io/yieldopt/.well-known/agent-card.json' },
];
const config = studioConfig({ STUDIO_DISCOVERY_ENABLED: 'true', STUDIO_DISCOVERY_RPC_URL: 'https://bsc-dataseed.binance.org/',
  STUDIO_DISCOVERY_TARGETS_JSON: JSON.stringify(targets) });
const store = new MemoryStore();
const previousToken = process.env.DP_AUTH_TOKEN;
try {
  if (!config) throw Error('invalid_fixture');
  await studioJob(store, config).run(AbortSignal.timeout(60000));
  process.env.DP_AUTH_TOKEN = 'local-discovery-fixture';
  const app = createServer({ store, scheduler: createScheduler(store), studio: config });
  const catalog = await readStudioCatalog({ DATA_PLANE_URL: 'https://local-fixture.example/', DATA_PLANE_TOKEN: 'local-discovery-fixture' },
    (url, init) => app.request(url.toString(), init));
  const passed = catalog.data.length === 3 && catalog.data.every(a => a.connected && a.a2a?.protocolVersion === '0.3.0');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), result: passed ? 'A2A_DISCOVERY_PASSED' : 'A2A_DISCOVERY_FAILED',
    agents: catalog.data.map(a => ({ id: a.id, name: a.name, connected: a.connected, cardUrl: a.a2aCardUrl,
      protocolVersion: a.a2a?.protocolVersion ?? null, skills: a.a2a?.skills.map(s => s.id) ?? [], errorCode: a.errorCode })),
    note: 'Discovery only. No A2A messages, jobs, payment, signing or production writes.' }, null, 2));
  if (!passed) process.exitCode = 1;
} catch { console.error('A2A discovery check failed; retry after checking public endpoint availability.'); process.exitCode = 1; }
finally {
  if (previousToken === undefined) delete process.env.DP_AUTH_TOKEN; else process.env.DP_AUTH_TOKEN = previousToken;
  await store.close();
}
