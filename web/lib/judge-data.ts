/**
 * Content of the unlisted judge guide at `/judge` (BNB Hack, Tokenized Stocks
 * Edition). Nothing in the app links here: the URL is handed to judges only, and
 * the page carries `noindex`.
 *
 * Every claim must be checkable by a judge from outside: a BscScan tx, an
 * 8004scan id, a live endpoint or a path in the public GitHub repo. Every tx hash
 * below was checked for `status: 0x1` on BSC mainnet on 2026-10-09. Internal
 * specs and notes are not public, so they are never cited here.
 *
 * Naming: the user creates the Agentic Wallet in Binance Wallet (not the Binance
 * exchange app), and pairs and signs out there.
 *
 * Writing rule: no em dash anywhere (pinned by judge-data.test.ts).
 */

export const SITE = "https://4lpha.tech";
export const REPO = "https://github.com/4lphaAI/4lpha-marketplace";
export const DATA_REPO = "https://github.com/4lphaAI/4lpha-market-data";
export const MCP_URL = `${SITE}/mcp`;
export const DESK_URL = "https://desk.4lpha.tech";
export const DEPLOY_URL = `${SITE}/deploy/trading`;

export const tx = (hash: string) => `https://bscscan.com/tx/${hash}`;
export const addr = (a: string) => `https://bscscan.com/address/${a}`;
export const erc8004 = (id: string) => `https://8004scan.io/agents/bsc/${id}`;
export const src = (path: string) => `${REPO}/blob/main/${path}`;
export const agentPage = (wallet: string) => `${SITE}/agentic/${wallet}`;

const AI_TRADE_WALLET = "0xb258F9c10C5dF49b13495E2ABf6ed3286B5DfD93";
const DCA_WALLET = "0xEBeBC695EABCF856aC8D86c1e54e9171212BE148";
const MEME_WALLET = "0x13d683ef6d8f9f8dc8dda0a09e885ec05f61c11c";

export type Status = "live" | "beta";

export const STATUS_LABEL: Record<Status, string> = {
  live: "Live on mainnet",
  beta: "Beta, not public yet",
};

export interface Evidence { label: string; href: string }

export interface Feature {
  id: string;
  title: string;
  status: Status;
  what: string;
  see?: Evidence[];
  evidence: Evidence[];
  note?: string;
}

export interface FeatureGroup { id: string; title: string; sub: string; features: Feature[] }

export interface LiveAgent { mode: string; status: Status; wallet: string; erc8004: string | null; note: string; shot: string }

/** Public agents a judge can open without a wallet (operator-owned, cleared for public display 2026-10-09). */
export const LIVE_AGENTS: LiveAgent[] = [
  {
    mode: "Agentic AI Trade",
    status: "live",
    wallet: AI_TRADE_WALLET,
    erc8004: "364199",
    shot: "/judge/agent-page.webp",
    note: "30-day term. Picks bStocks with indicator rules, CMC data and an LLM, then buys and sells on its own.",
  },
  {
    mode: "Agentic Auto DCA",
    status: "live",
    wallet: DCA_WALLET,
    erc8004: "368707",
    shot: "/judge/dca-page.webp",
    note: "SPCXB ladder: a base order, four DCA levels below it and a take profit, each filled as a market swap.",
  },
  {
    mode: "Meme stocks (paper)",
    status: "beta",
    wallet: MEME_WALLET,
    erc8004: null,
    shot: "/judge/meme-page.webp",
    note: "Trades Flap and Four.meme memes quoted in a bStock on paper: live data, no swap, no payment.",
  },
];

export interface Video { mode: string; title: string; id: string; url: string }

/**
 * Tutorial videos, operator-supplied 2026-10-09; URLs kept exactly as given.
 * Titles checked against YouTube oEmbed the same day.
 */
export const VIDEOS: Video[] = [
  { mode: "AI Trade", title: "TradFi AI Trade Tutorial", id: "492pKiwdfYk", url: "https://youtu.be/492pKiwdfYk?si=YzGtEN9kSJ6HdcI4" },
  { mode: "Schedule buy", title: "TradFi Schedule Buy Tutorial", id: "YXEfzrv2OtY", url: "https://youtu.be/YXEfzrv2OtY?si=yke7kI34JMo-RLty" },
  { mode: "Auto DCA", title: "TradFi Auto DCA Tutorial", id: "iEZrA_xwxpE", url: "https://youtu.be/iEZrA_xwxpE?si=vt_RiClSsptgLRug" },
  { mode: "Smart Portfolio", title: "TradFi Smart Portfolio Tutorial", id: "laCmUvOra7w", url: "https://youtu.be/laCmUvOra7w?si=E9D1uSYw9YgEXkNu" },
];

export const GROUPS: FeatureGroup[] = [
  {
    id: "agentic",
    title: "Agents on a Binance Agentic Wallet",
    sub: "Hosted agents trade bStocks from the user's own Agentic Wallet, 24/7. One pairing in Binance Wallet at hire time; no passkey, no extension.",
    features: [
      {
        id: "agentic-ai-trade",
        title: "AI Trade",
        status: "live",
        what: "Scores the bStock universe with indicator rules, a market regime read and paid CMC data, then lets an LLM pick entries and exits inside hard limits: caps, max open positions and a cost band.",
        see: [{ label: "Live agent page", href: agentPage(AI_TRADE_WALLET) }],
        evidence: [
          { label: "Buy tx (SPCXB)", href: tx("0x365c4734fac9d4f6bf9af9fc7fb5d3335cbca91310cb53ac4c8afde1cfb552aa") },
          { label: "ERC-8004 #364199", href: erc8004("364199") },
        ],
      },
      {
        id: "agentic-schedule",
        title: "Schedule buy",
        status: "live",
        what: "Buys a fixed USDT amount of one bStock on a fixed schedule and keeps the holdings at term end.",
        evidence: [
          { label: "Scheduled buy tx (SPCXB)", href: tx("0xf4b5de3a3c7058015513419a32eae2ece37f100b48d562aad1ad7fdd624fff7c") },
          { label: "Scheduled buy tx (NVDAB)", href: tx("0x6a9f533b162a9309a98106e278c8c7e47453e911edbd0877b4f85c4520816f17") },
        ],
      },
      {
        id: "agentic-dca",
        title: "Auto DCA",
        status: "live",
        what: "Buys a fixed amount at set price steps below the start price, with a take profit. A stop loss pauses the agent without selling.",
        see: [{ label: "Live agent page", href: agentPage(DCA_WALLET) }],
        evidence: [
          { label: "Base order tx (SPCXB)", href: tx("0x37af3d7df0319644fca77f48eeeca38fc0da91326e5b83aec16f4b96bf80af61") },
          { label: "ERC-8004 #368707", href: erc8004("368707") },
        ],
      },
      {
        id: "agentic-portfolio",
        title: "Smart Portfolio",
        status: "live",
        what: "Holds a weighted basket of up to 5 bStocks and rebalances back to target on a drift trigger or a timer, 24/7.",
        evidence: [
          { label: "Rebalance sell tx (QQQB)", href: tx("0x71dc875605ebc664f8bd6d8172ba329ca6f8a24bb23dd438b5867d88a8e2de22") },
          { label: "Rebalance buy tx (SKHYB)", href: tx("0xde6e69a60ca5a72d63588f74ec5bfb4ca82dc752d91fcbd9e930477f4c80fd34") },
        ],
      },
      {
        id: "agentic-earn",
        title: "Earn on idle USDT",
        status: "live",
        what: "Opt-in for Schedule buy, AI Trade and Auto DCA: part of the idle USDT is lent to whichever of Venus or Aave v3 pays more, and redeemed when the strategy needs it or the term ends.",
        evidence: [
          { label: "Venus deposit tx", href: tx("0x630f66ff541e47f3876bb60efcc60ef63def59c3f54ee2dcee7d540fd7232eba") },
          { label: "Aave v3 deposit tx", href: tx("0x74e460d9ecf663f734f2a7cf412971c51ea0af674b0f741a176fbe8ad5c5837a") },
        ],
        note: "At hackathon sizes the interest is a few cents and can be below the gas.",
      },
      {
        id: "agentic-rfq",
        title: "RFQ-only bStocks",
        status: "live",
        what: "AI Trade can also buy bStocks that have no AMM pool, through Binance market-maker quotes, with indicators built from a per-share reference price recorded every 60 s.",
        evidence: [{ label: "Source: src/agentic/rfq.ts", href: src("src/agentic/rfq.ts") }],
      },
    ],
  },
  {
    id: "tradfi",
    title: "Agents on an Altana passkey wallet",
    sub: "The same strategies without a Binance wallet. One passkey signature grants an on-chain session (per-token caps, call allowlist, expiry) on an EIP-7702 wallet. Swaps go through our verified guard contract.",
    features: [
      {
        id: "tradfi-guard",
        title: "TradFiSwapGuard contract",
        status: "live",
        what: "Wraps each aggregator swap in one atomic balance check: pinned router and entry selector, USDT on one side, and a revert if the wallet receives less than the minimum output.",
        evidence: [
          { label: "Contract (verified)", href: addr("0x16B24723aCE1Adc87243338d0A32C50BeC259650") },
          { label: "Deploy tx", href: tx("0xccdfe078b94850806941366386b53a7ac076885a26b32724ca7f2cae35e45457") },
          { label: "Source", href: src("contracts/TradFiSwapGuard.sol") },
        ],
      },
      {
        id: "tradfi-trade",
        title: "AI Trade",
        status: "live",
        what: "LLM entries and exits over a rule-scored bStock universe, inside the on-chain session caps.",
        evidence: [
          { label: "Buy tx via the guard (INTCB)", href: tx("0x26dcb8aabb2493af42b9a65b41bd12e964d6eab7b0bebfa6af44ab8904e9e7a0") },
          { label: "Sell tx (+3.2 %)", href: tx("0xcb23a31d138f78ac9a15b16b9f8e643812c143182dab66cc1d1330a05df23c65") },
          { label: "Entry tx (SPYB)", href: tx("0x100ea403720c541f2c2a6fc391c006b86a4c8556b410ad80b5578a3099817769") },
        ],
      },
      {
        id: "tradfi-schedule",
        title: "Schedule buy",
        status: "live",
        what: "Recurring buy of one bStock at a fixed amount.",
        evidence: [
          { label: "Scheduled buy tx (LITEB)", href: tx("0x6871efbdca3bacf6545e5afedc4ca99311776b04454472d3e6b5a6a2f5767769") },
          { label: "Scheduled buy tx (SPCXB)", href: tx("0xfbbfad0ec2b88bd0c6c057ffb9aa86fed6b7216fa607b77287dec24a818988c8") },
        ],
      },
      {
        id: "tradfi-dca",
        title: "Auto DCA",
        status: "live",
        what: "Range-order DCA ladder with take profit and stop loss.",
        evidence: [{ label: "DCA start tx (NVDAB)", href: tx("0x50852f7c9c696254be55f1d4f3065959ead7bfc3df727c08ac4724af54162dcc") }],
      },
      {
        id: "tradfi-portfolio",
        title: "Smart Portfolio",
        status: "live",
        what: "Weighted basket of bStocks with drift or timed rebalancing.",
        evidence: [{ label: "Basket buy tx (GOOGLB)", href: tx("0x3a536050254f2f8b9e867fdd2bf8f87a6808fc83d96a2538e2651ae52f8fb951") }],
      },
    ],
  },
  {
    id: "safety",
    title: "Data and safety layers",
    sub: "What stands between an LLM and a bad fill on a tokenized stock.",
    features: [
      {
        id: "rwa-guard",
        title: "Stale-price and market-hours guard",
        status: "live",
        what: "Refuses an entry when the reference price is stale, the issuer is not trading, the venue price is stale, or the premium over the real share price is unknown or too high.",
        evidence: [{ label: "Source: src/trade/rwa.ts", href: src("src/trade/rwa.ts") }],
      },
      {
        id: "cmc-x402",
        title: "CoinMarketCap data, paid per call (x402)",
        status: "live",
        what: "Agents pay for CMC market data per call over x402. AI Trade on an Agentic Wallet always uses it.",
        evidence: [
          { label: "Agentic payment tx", href: tx("0xfbe912c5eb5366fce77abfc1630c31f7eff9c14d704a32d9f4a74db34966306c") },
          { label: "Data budget setup tx", href: tx("0xacb9ae6d6033ba78e26ec22209d11f156ea74bd04fffa5a459e0215b72c0ba02") },
          { label: "Paid call tx", href: tx("0x481e692ca56e177dbe0b8cc9615776030f08b779fb7516ad27b4fa21531e5028") },
        ],
      },
      {
        id: "preflight",
        title: "Pre-flight simulation",
        status: "live",
        what: "Each swap is simulated before it is sent. On direct routes a failed buy simulation blocks the buy; on the guard route the result is logged.",
        evidence: [{ label: "Source: src/", href: `${REPO}/tree/main/src` }],
      },
      {
        id: "stock-compare",
        title: "bStock vs Ondo compare",
        status: "live",
        what: "For one US stock and a USDT size: shares received from each tokenized version, cost against the real share price, exit cost, session state and a verdict. Refreshed about every 15 minutes.",
        evidence: [{ label: "Run it above", href: "#run" }],
      },
      {
        id: "meme-stocks",
        title: "Meme stocks (paper)",
        status: "beta",
        what: "Meme tokens on Flap and Four.meme quoted in a bStock. An AI Trade option runs them on paper with live data: deterministic filters plus an LLM arbiter, no swap and no payment.",
        see: [{ label: "Paper agent page", href: agentPage(MEME_WALLET) }],
        evidence: [{ label: "Source: src/agentic/memeLane.ts", href: src("src/agentic/memeLane.ts") }],
      },
    ],
  },
];

export interface PrizeItem { name: string; body: string }
export interface DeskJob { id: string; what: string; fund: string; submit: string; report: string; extra?: Evidence }

export interface Prize {
  id: string;
  title: string;
  tagline: string;
  points: string[];
  /** Right-hand list (skills, services). */
  itemsTitle: string;
  items: PrizeItem[];
  links: Evidence[];
  jobs?: DeskJob[];
  jobsNote?: string;
}

const ipfs = (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`;

/** Special prize tracks. */
export const PRIZES: Prize[] = [
  {
    id: "wallet",
    title: "Agentic Wallet / Wallet Skills",
    tagline: "Our agents run on the user's own Binance Agentic Wallet, and any AI assistant can reach them through skills.",
    points: [
      "Four strategies (AI Trade, Schedule buy, Auto DCA, Smart Portfolio) run on the user's own Agentic Wallet, hired with one pairing in Binance Wallet.",
      "Funds never move to 4lpha. To stop, the user signs out of the session in Binance Wallet; holdings stay in the wallet.",
      "Idle USDT can earn on Venus or Aave v3 while the agent waits, and every Agentic agent gets its own ERC-8004 identity.",
      "Five read-only Agent Skills plus a public MCP server at 4lpha.tech/mcp: no login, no key, and they never sign or trade.",
    ],
    itemsTitle: "The five skills",
    items: [
      { name: "4lpha-hire", body: "Picks the right agent, checks what the wallet needs and hands over the Deploy link." },
      { name: "4lpha-agent-status", body: "Status, positions, results, Earn position and ERC-8004 identity of the agent on a wallet." },
      { name: "4lpha-bstock-analysis", body: "The indicators AI Trade reads, the US market regime, premium over the share price, pool depth." },
      { name: "4lpha-stock-compare", body: "bStock vs Ondo token for the same USDT: shares received, cost, exit cost, verdict." },
      { name: "4lpha-meme-stocks", body: "Memes quoted in a bStock, grouped by stock, with lifecycle labels and risk flags." },
    ],
    links: [
      { label: "Skills page", href: `${SITE}/skills` },
      { label: "skills/ in the repo", href: `${REPO}/tree/main/skills` },
      { label: "MCP server source", href: src("web/lib/mcp/server.ts") },
    ],
  },
  {
    id: "studio",
    title: "BNB Agent Studio",
    tagline: "4lpha bStock Desk: a paid research agent built with the Studio CLI and live on mainnet.",
    points: [
      "Built with bag: scaffolded with bag init, registered as ERC-8004 agent #369195, sold and bought through ERC-8183 jobs. Live at desk.4lpha.tech with a public A2A card.",
      "A free negotiate returns a signed price quote; the buyer funds an ERC-8183 job, the desk delivers the report to IPFS and submits it on chain.",
      "Pays for its own data: the desk buys CoinMarketCap data per call over x402 from its own wallet.",
      "Money moves only through fixed code: quotes, submit and settle are signed outside any LLM tool. The model only writes the summary, and a sentence with a number that is not in the facts is dropped.",
    ],
    itemsTitle: "Services, 0.10 U each",
    items: [
      { name: "stock_report", body: "Price, premium to NAV, indicators, market regime, where to buy at a given USDT size, and the risks." },
      { name: "dca_plan", body: "An Auto DCA ladder or a Schedule buy plan for one bStock over 7 or 30 days." },
      { name: "rebalance_plan", body: "A Smart Portfolio check: allocations for a capital and target weights." },
    ],
    links: [
      { label: "A2A card", href: `${DESK_URL}/.well-known/agent-card.json` },
      { label: "ERC-8004 #369195", href: erc8004("369195") },
      { label: "Registration tx", href: tx("0x1e1aeebce9f723f44f9e1afa2efbf88ee22c9614f921ac3d65332ad162ac76a8") },
      { label: "Source", href: `${REPO}/tree/main/studio/fourlphadesk` },
    ],
    jobs: [
      {
        id: "56947", what: "First paid job: NVDA stock report",
        fund: tx("0xcd2318c443f829b4fa88dedf476c326d62a6db7e3b1a5849d305a20720d410f4"),
        submit: tx("0x7ffb017bdcfd51c981cd3273d97d2d81f050bb303a75caddc84d4c72590c0079"),
        report: ipfs("QmUavw4evR5nNzWfcHHTr2myHHhBL3mUPk9tnEXrH7TbrN"),
      },
      {
        id: "56948", what: "NVDA report with CoinMarketCap data the desk bought over x402",
        fund: tx("0x0189cdaa512eb368e045b4fd679e19db49c9f23a3d36407fc2b2db20f62cf0b9"),
        submit: tx("0x818cdaee7a4e21046ab2d73747d673ad2e226938d5347b5d1f94561b6a172d0e"),
        report: ipfs("QmShGXmDkuQbwu4KRysXYftgH7FbK8Ab5t67WCSYqPARsa"),
        extra: { label: "x402 payment", href: tx("0x47f38e358558a7f3115f18e568ecfaadc64ff9823f8e5e7a8f29d32c7f05bb44") },
      },
      {
        id: "56950", what: "NVDA report; the number check refused a model sentence with a figure not in the facts",
        fund: tx("0x0fe541d0b809ea6417113955b2066a9aefdd3eb193c9ad14e13c0e3d6c6a4479"),
        submit: tx("0x357debe897a6e1246aedb324e3eb389b1cf57bc8e9001182cdfddc16946fd1f7"),
        report: ipfs("QmU85qWJES4AB3KGj5V7829h8Ki9AkMzDwyo2gbem1fwq7"),
      },
    ],
    jobsNote: "Funded by a separate buyer wallet. Settlement is optimistic: payment releases after the 7-day dispute window.",
  },
];

/**
 * A command a judge can copy. `run` marks the ones the page can also run in the
 * browser: same-origin public endpoints only (the MCP server and the read-only
 * Agentic JSON), sent as the exact request the curl line shows. The desk agent
 * sends no CORS headers, so its commands stay copy-only.
 */
export interface RunSpec { method: "GET" | "POST"; path: string; body?: unknown }
export interface Command { id: string; title: string; note?: string; cmd: string; run?: RunSpec }

const mcpBody = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const mcpCommand = (id: string, title: string, body: unknown): Command => ({
  id,
  title,
  cmd: `curl -s -X POST ${MCP_URL} -H "content-type: application/json" -d '${JSON.stringify(body)}'`,
  run: { method: "POST", path: "/mcp", body },
});
const mcpCall = (n: number, title: string, name: string, args: Record<string, unknown>) =>
  mcpCommand(`mcp-${name}`, title, mcpBody(n, "tools/call", { name, arguments: args }));

/** Every command here was run against production on 2026-10-09. */
export const COMMANDS: Command[] = [
  mcpCall(2, "Compare NVDAB and the Ondo NVDA token for 500 USDT", "stock_compare", { ticker: "NVDA", usdt: 500 }),
  mcpCall(3, "Indicators, market regime and premium for NVDAB", "bstock_analysis", { token: "NVDAB" }),
  mcpCall(4, "Status of the live AI Trade agent", "agent_status", { wallet: AI_TRADE_WALLET }),
  mcpCall(5, "Meme stocks grouped by the stock they are quoted in", "meme_stocks", { limit: 5 }),
  {
    id: "agentic-json",
    title: "Public JSON behind the AI Trade agent page",
    cmd: `curl -s ${SITE}/api/agentic/wallets/${AI_TRADE_WALLET}`,
    run: { method: "GET", path: `/api/agentic/wallets/${AI_TRADE_WALLET}` },
  },
  mcpCommand("mcp-list", "List every MCP tool", mcpBody(1, "tools/list")),
];

/** The desk agent sends no CORS headers, so these stay terminal commands. */
export const DESK_COMMANDS: Command[] = [
  {
    id: "desk-card",
    title: "Health check and A2A card",
    cmd: `curl -s ${DESK_URL}/ping && curl -s ${DESK_URL}/.well-known/agent-card.json`,
  },
  {
    id: "desk-negotiate",
    title: "Free negotiate: returns a signed price quote",
    cmd: `curl -s -X POST ${DESK_URL}/ -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"judge-1","role":"user","parts":[{"kind":"data","data":{"skill":"negotiate","task_description":"{\\"type\\":\\"stock_report\\",\\"ticker\\":\\"NVDA\\",\\"usdt\\":500}","terms":{"deliverables":"stock report JSON","quality_standards":"numbers computed by code"}}}]}}}'`,
  },
];

export const ASSISTANT_COMMANDS: Command[] = [
  { id: "skills", title: "Install the five skills (Node.js 22+)", cmd: "npx skills add 4lphaAI/4lpha-marketplace" },
  { id: "claude-mcp", title: "Or add the MCP server to Claude Code", cmd: `claude mcp add --transport http 4lpha ${MCP_URL}` },
];

export const CODE_COMMANDS: Command[] = [
  { id: "clone", title: "Clone", cmd: `git clone ${REPO}.git && cd 4lpha-marketplace` },
  { id: "web-tests", title: "Web app and MCP server tests (vitest)", cmd: "cd web && npm ci && npx vitest run app/mcp lib/mcp" },
  { id: "desk-tests", title: "Studio desk agent tests", cmd: "cd studio/fourlphadesk/app/agent && pnpm install && pnpm test" },
  { id: "skill-cli", title: "Run a skill by hand", cmd: "node skills/4lpha-stock-compare/scripts/cli.mjs stock-compare ticker=NVDA usdt=500" },
];

export interface GuideStep {
  title: string;
  body: string;
  /** A prerequisite shown as a highlighted callout under the body. */
  before?: string;
  links?: Evidence[];
  image?: { src: string; alt: string; width: number; height: number };
}

/**
 * Visual hire guide for the Binance Agentic Wallet. Screenshots are of the live
 * app (4lpha.tech, 2026-10-09). Steps 4 to 6 open a real pairing, so they are
 * described without a screenshot.
 */
export const AGENTIC_GUIDE: GuideStep[] = [
  {
    title: "Pick a strategy",
    body: "Open Deploy on a desktop browser, keep the TradFi model and choose AI Trade, Schedule buy, Auto DCA or Smart Portfolio. Set the capital and limits, then press the deploy button.",
    links: [{ label: "Open Deploy", href: DEPLOY_URL }],
    image: { src: "/judge/deploy-trading.webp", alt: "Deploy screen with the TradFi model and the four modes", width: 2880, height: 1800 },
  },
  {
    title: "Choose the wallet",
    body: "Every hire can run on an Altana passkey wallet or on a Binance Agentic Wallet. Pick Agentic Wallet.",
    image: { src: "/judge/custody-choice.webp", alt: "Choose a wallet: Altana or Agentic Wallet", width: 2400, height: 1424 },
  },
  {
    title: "Set the term",
    body: "7 or 30 days; Stocks, or Meme stocks on paper; sell all to USDT or keep holdings at term end; optional Earn on idle USDT. AI Trade always buys its CMC data, with a 2 USDT budget.",
    image: { src: "/judge/agentic-term.webp", alt: "Agentic Wallet term: term, strategy, CMC budget, term end, Earn", width: 2400, height: 2312 },
  },
  {
    title: "Pair with Binance Wallet",
    body: "Scan the QR with Binance Wallet and tap Confirm, then type the 6-character code it shows. That is the only approval: no passkey, no browser extension.",
    before: "Create an Agentic Wallet in Binance Wallet first. It lives in Binance Wallet, not in a Binance exchange account.",
  },
  {
    title: "Fund the wallet",
    body: "The page shows the Agentic Wallet address, the USDT the strategy needs and a little BNB for gas, and re-reads the balances every 10 s.",
  },
  {
    title: "Binance checks, then deploy",
    body: "4lpha checks the wallet's settings and lists any fix needed. When every check passes, deploy starts the agent.",
  },
  {
    title: "Watch it work",
    body: "The agent gets a public read-only page and its own ERC-8004 identity. To stop it, sign out of the session in Binance Wallet; holdings stay in the wallet.",
    links: [{ label: "Open a live agent page", href: agentPage(AI_TRADE_WALLET) }],
    image: { src: "/judge/agent-page.webp", alt: "Public page of a running Agentic AI Trade agent", width: 2880, height: 1800 },
  },
];

export const LIMITS = [
  "Real money, BSC mainnet only. There is no testnet mode. Nothing here is investment advice.",
  "Agentic Wallet: funds stay in the user's own wallet, but while the agent runs 4lpha's server holds the session and can swap within the wallet's limits. Use a dedicated wallet.",
  "Altana passkey: the hire creates a new wallet address that the user funds. It is not the user's existing wallet.",
  "On the passkey AI Trade, trailing and stale exit rules are logged, not enforced yet. Meme stocks are a paper-only beta.",
  "Marketplace cards show sample numbers for layout. The agent pages and the transactions on this page are the real data.",
  "The app is built for desktop; this page and every command work anywhere. The MCP server allows 10 tool calls per minute per IP.",
  "Terminal commands are for bash, zsh or Git Bash. In Windows PowerShell 5.1 use curl.exe and escape the JSON quotes.",
];

/**
 * Sigma's speech bubble in the hero: short lines it cycles through on its own
 * (and on a click). Display only: no model, no input, no request.
 */
export interface SigmaLine { text: string; state: "idle" | "waving" | "jumping" | "review" | "running" | "waiting" }

export const SIGMA_LINES: SigmaLine[] = [
  { text: "Hi judges! I'm Sigma, the 4lpha pet. Welcome to the tour.", state: "waving" },
  { text: "Three of our agents are trading on mainnet right now. Their pages are just below.", state: "running" },
  { text: "Press Run on any command and I'll fetch live data from 4lpha.tech for you.", state: "jumping" },
  { text: "Every hire can use an Altana passkey or a Binance Agentic Wallet. You pick at step 2.", state: "review" },
  { text: "Each claim on this page links to a real BSC transaction. Go ahead, click one.", state: "idle" },
  { text: "Studio judges: our desk agent pays for its own CoinMarketCap data over x402.", state: "jumping" },
  { text: "Meme stocks are still in beta, so they trade on paper only. No real orders.", state: "waiting" },
];
