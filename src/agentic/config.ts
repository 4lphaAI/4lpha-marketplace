import { isAbsolute } from "node:path";

export type AgenticConfig = { enabled: false } | { enabled: true; cli: string; rpcUrls: readonly string[]; dca: boolean; rfq: boolean; meme: boolean; earn: boolean };

/** AGENTIC_DCA_ENABLED: exactly "true" enables, empty or "false" is off, anything else refuses boot (AGENTIC-DCA-SPEC 3.15). The lane re-reads it each cycle through this helper, so a gate process and a worker answer from their own environment. */
export function agenticDcaEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env["AGENTIC_DCA_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new Error("AGENTIC_DCA_ENABLED must be true or false.");
  return true;
}

/** AGENTIC_RFQ_STOCKS_ENABLED (AGENTIC-RFQ-STOCKS-SPEC 4.1): exactly "true" enables, empty or "false" is off, anything else refuses boot. Read by execution-api (the hire pin variant), the trade-worker (RFQ entries) and the gate tool, each from its own environment. */
export function agenticRfqEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env["AGENTIC_RFQ_STOCKS_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new Error("AGENTIC_RFQ_STOCKS_ENABLED must be true or false.");
  return true;
}

/** AGENTIC_MEME_STOCKS_ENABLED (AGENTIC-MEME-STOCKS-SPEC 9.5): exactly "true" enables, empty or "false" is off, anything else refuses boot. Read by execution-api (paper hires) and the trade-worker (paper entries; exits and close-out run regardless). */
export function agenticMemeEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env["AGENTIC_MEME_STOCKS_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new Error("AGENTIC_MEME_STOCKS_ENABLED must be true or false.");
  return true;
}

/** AGENTIC_MEME_DECISION_LOG_PUBLIC (local debug, operator hotfix 2026-10-06): exactly "true" adds the paper meme hire's decision log to its public view; anything else is off and never refuses boot. Off in production until the operator rules. */
export function agenticMemeDecisionLogPublic(env: NodeJS.ProcessEnv): boolean {
  return env["AGENTIC_MEME_DECISION_LOG_PUBLIC"] === "true";
}

/** AGENTIC_EARN_ENABLED (AGENTIC-EARN-SPEC 3.1): exactly "true" enables, empty or "false" is off, anything else refuses boot. Read by execution-api (earn hire bodies), the trade-worker (deposits; redeems and the sign-out guard run regardless) and the gate tool. */
export function agenticEarnEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env["AGENTIC_EARN_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new Error("AGENTIC_EARN_ENABLED must be true or false.");
  return true;
}

export function resolveAgenticConfig(env: NodeJS.ProcessEnv, input: {
  hireEnabled: boolean; tradeAgentEnabled: boolean; rpcUrls: readonly string[];
}): AgenticConfig {
  const flag = env["AGENTIC_WALLET_ENABLED"];
  const dca = agenticDcaEnabled(env);
  const rfq = agenticRfqEnabled(env);
  const meme = agenticMemeEnabled(env);
  const earn = agenticEarnEnabled(env);
  if (flag === undefined || flag === "" || flag === "false") {
    if (dca) throw new Error("AGENTIC_DCA_ENABLED requires AGENTIC_WALLET_ENABLED=true.");
    if (rfq) throw new Error("AGENTIC_RFQ_STOCKS_ENABLED requires AGENTIC_WALLET_ENABLED=true.");
    if (meme) throw new Error("AGENTIC_MEME_STOCKS_ENABLED requires AGENTIC_WALLET_ENABLED=true.");
    if (earn) throw new Error("AGENTIC_EARN_ENABLED requires AGENTIC_WALLET_ENABLED=true.");
    return { enabled: false };
  }
  if (flag !== "true") throw new Error("AGENTIC_WALLET_ENABLED must be true or false.");
  const cli = env["AGENTIC_BAW_CLI"] ?? "";
  if (!input.hireEnabled || !input.tradeAgentEnabled || !env["DATABASE_URL"] || !env["EXECUTION_MASTER_KEY"]
    || input.rpcUrls.length < 3 || !isAbsolute(cli)) throw new Error("AGENTIC_BOOT_REQUIREMENTS");
  // The first check of every live gate: a process whose line says dca=false must not be used for a DCA step (AGENTIC-DCA-SPEC R23.1).
  // The rfq token is printed only when on: the line of an RFQ-off process stays byte-for-byte what test/agentic.dca.store.test.ts pins.
  // The meme token likewise, after the rfq token (AGENTIC-MEME-STOCKS-SPEC 9.5).
  // The earn token likewise, last (AGENTIC-EARN-SPEC 3.1).
  console.log(`agentic-flags wallet=true dca=${dca}${rfq ? " rfq=true" : ""}${meme ? " meme=true" : ""}${earn ? " earn=true" : ""}`);
  return { enabled: true, cli, rpcUrls: input.rpcUrls, dca, rfq, meme, earn };
}
