/**
 * A2A AgentCard - the seller agent's outward, discoverable identity.
 *
 * Built by `main.ts` and served at `/.well-known/agent-card.json`. When
 * deployed, `main.ts` overwrites `card.url` at boot with the deployed
 * AgentCore runtime URL (`$AGENTCORE_RUNTIME_URL`), so the `url` here is only
 * a local-dev placeholder.
 *
 * The card advertises a free `preview` skill and the two paid skills `negotiate` and `notify_funded` -
 * and the OAuth2 (Cognito) security scheme buyers must satisfy: AgentCore A2A
 * endpoints require an inbound OAuth2 bearer (there is no anonymous mode).
 * The token URL + scope come from the Cognito user pool
 * `bag deploy provision-cognito` creates (env `OAUTH_TOKEN_URL` /
 * `OAUTH_SCOPE`, injected at deploy); the runtime's inbound JWT authorizer
 * validates the same pool. Locally (no Cognito env) the card omits the scheme
 * so `bag dev` is reachable without a token.
 *
 * You own this file - edit the skill descriptions / card metadata for your
 * seller.
 */

import type { AgentCard, AgentSkill, SecurityScheme } from "@a2a-js/sdk";

const PREVIEW: AgentSkill = {
  id: "preview",
  name: "Free preview of a stock report",
  description:
    'FREE, no payment and nothing on chain. Send a data part {"skill": "preview", "ticker": "NVDA"} ' +
    '(optionally "usdt": 500) and receive the price, premium to NAV and where-to-buy sections of the ' +
    "stock report as Markdown, plus the ready-to-send negotiate envelope for the full 0.10 USD report.",
  tags: ["preview", "free", "tokenized-stocks", "bnb-chain"],
  examples: ['{"skill": "preview", "ticker": "NVDA", "usdt": 500}'],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
};

const NEGOTIATE: AgentSkill = {
  id: "negotiate",
  name: "Negotiate an ERC-8183 job",
  description:
    'Send a data part {"skill": "negotiate", "task_description": "...", ' +
    '"terms": {"deliverables": "...", "quality_standards": "..."}} (both ' +
    "terms keys are REQUIRED) and receive a " +
    "wallet-signed price quote (price, currency, negotiation_hash, provider_sig). " +
    "Put the desk request (one JSON object, see the card description) in task_description. " +
    "Anchor the returned envelope on-chain via createJob + fund, then send the " +
    "`notify_funded` skill with the job_id to request delivery.",
  tags: ["erc8183", "negotiation", "bnb-chain"],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
};

const NOTIFY_FUNDED: AgentSkill = {
  id: "notify_funded",
  name: "Notify the seller a job is funded (request delivery)",
  description:
    'After you fund the job on-chain, send {"skill": "notify_funded", ' +
    '"job_id": <int>} to tell the seller "I funded job X - please deliver". ' +
    "The seller verifies the funded job carries its signed quote and replies " +
    'AT ONCE with {"status": "accepted"|"rejected", "job_id"}; delivery then ' +
    "runs in the background (work takes time). Do NOT wait on this call for " +
    "the result - read the deliverable back from the CHAIN once the job " +
    "reaches SUBMITTED (the `submit` tx carries the deliverable_url; " +
    "ERC-8183 `get_deliverable_url`). The agent serves no job-query endpoint.",
  tags: ["erc8183", "delivery", "bnb-chain"],
  inputModes: ["application/json"],
  outputModes: ["application/json"],
};

/**
 * Card name. Fixed on purpose: studio.toml `[project].name` is the deploy identity (letters and digits
 * only), the public name is the desk's.
 */
export const DESK_NAME = "4lpha bStock Desk";

/** What the desk sells and how to ask for it (also the card description). */
export const DESK_DESCRIPTION =
  "4lpha bStock Desk sells three kinds of data reports on tokenized US stocks (bStocks) on BNB Chain, 0.10 USD each, " +
  "paid through an ERC-8183 job. Put ONE JSON object in the job task_description. " +
  "(1) stock_report: {\"type\":\"stock_report\",\"ticker\":\"NVDA\",\"usdt\":500} - price, premium to NAV, indicators, market regime, where to buy at that size, risks. " +
  "(2) dca_plan: {\"type\":\"dca_plan\",\"ticker\":\"NVDAB\",\"usdt\":200,\"mode\":\"dca\",\"days\":7} - an Auto DCA ladder or a Schedule buy (mode dca or schedule, days 7 or 30). " +
  "(3) rebalance_plan: {\"type\":\"rebalance_plan\",\"capital\":150,\"weights\":{\"NVDA\":40,\"MSFT\":30,\"SPY\":30}} - a Smart Portfolio check with allocations. " +
  "Plain English is mapped to these formats when possible. Every number is computed by code; plans end with the plain 4lpha Deploy link. Data, not investment advice. " +
  "The desk never trades and never holds funds. Free preview: send {\"skill\":\"preview\",\"ticker\":\"NVDA\"} for the price and where-to-buy sections at no cost.";

/**
 * OAuth2 (Cognito client-credentials) scheme from env, or null locally.
 *
 * `bag deploy provision-cognito` emits a Cognito user pool + app client and
 * injects `OAUTH_TOKEN_URL` + `OAUTH_SCOPE`; the AgentCore runtime's inbound
 * JWT authorizer is wired to the same pool. Absent (local `bag dev`) →
 * return null so the card advertises no auth requirement.
 */
function oauth2Scheme(): SecurityScheme | null {
  const tokenUrl = process.env.OAUTH_TOKEN_URL;
  const scope = process.env.OAUTH_SCOPE;
  if (!tokenUrl || !scope) {
    return null;
  }
  return {
    type: "oauth2",
    flows: {
      clientCredentials: {
        tokenUrl,
        scopes: { [scope]: "Invoke the seller agent" },
      },
    },
  };
}

/**
 * The ONE source of the card's advertised URL: BNBAGENT_PUBLIC_URL (set by the operator before the single
 * wallet-mode deploy; Studio also hands it to the runtime as AGENTCORE_RUNTIME_URL). Only an http(s) URL is
 * accepted; no trailing slash. Null means "local run": the caller falls back to localhost.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BNBAGENT_PUBLIC_URL || env.AGENTCORE_RUNTIME_URL || "").trim();
  if (raw === "") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Build the A2A AgentCard, gating ERC-8183 skills on the configured rail. */
export function buildAgentCard(
  opts: { commerceSkills?: boolean } = {},
): AgentCard {
  const name = DESK_NAME;
  const extra: Partial<AgentCard> = {};
  const scheme = oauth2Scheme();
  if (scheme !== null) {
    const scope = process.env.OAUTH_SCOPE as string;
    extra.securitySchemes = { oauth2: scheme };
    extra.security = [{ oauth2: [scope] }];
  }
  return {
    name,
    description: DESK_DESCRIPTION,
    // main.ts overwrites this with $AGENTCORE_RUNTIME_URL at boot.
    // Local-dev fallback: a client-routable localhost URL (not the 0.0.0.0
    // bind address). Host via AGENT_HOST (default localhost); port via the
    // same AGENT_PORT → 9000 resolution main.ts serves on. Do not honor the
    // AgentCore HTTP $PORT=8080 convention for this A2A runtime.
    url: publicBaseUrl() ?? `http://${process.env.AGENT_HOST ?? "localhost"}:${process.env.AGENT_PORT || "9000"}/`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    // Non-streaming: negotiate / notify_funded are request/response
    // (message/send). Do NOT flip this on to satisfy the AgentCore
    // inspector's chat box - that box can't drive a seller agent (it can
    // only send plain text, never the {"skill": ...} DataPart these skills
    // require, and its streaming view expects Task events). Test locally
    // with curl / an A2A client sending a DataPart (see the operating skill).
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills:
      opts.commerceSkills === false ? [PREVIEW] : [PREVIEW, NEGOTIATE, NOTIFY_FUNDED],
    ...extra,
  };
}
