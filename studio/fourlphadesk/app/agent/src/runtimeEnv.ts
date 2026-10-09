/**
 * Boot check for env-only hosting (Railway, any container host).
 *
 * The Studio runtime already turns env vars into a running signer: `WALLET_KEYSTORE_JSON` is the encrypted
 * keystore (written once, mode 0600, into the container's private keystore dir by the runtime's own
 * `ensureKeystoreMaterialized`, then removed from the environment) and `WALLET_PASSWORD` unlocks it. This
 * module does NOT touch the signing code and does not write anything: it only checks, before the runtime
 * starts, that everything a production boot needs is present and consistent, and fails with a message that
 * names VARIABLES, never values.
 *
 * It never logs, returns or throws a secret value. Enforced only when NODE_ENV=production (the Docker image
 * sets it); local `bag dev` and the AgentCore path (secrets already loaded into the env by the entrypoint,
 * which calls this after loadRuntimeSecrets) are unaffected when not in production.
 */

import { publicBaseUrl } from "./agentCard.js";
import { callerIdentityProblems } from "./callerIdentity.js";

export interface RuntimeEnvCheck {
  readonly enforced: boolean;
  readonly missing: readonly string[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** Variables the operator pastes into the host as secrets. */
export const SECRET_VARS = ["WALLET_KEYSTORE_JSON", "WALLET_PASSWORD", "PIEVERSE_LLM_API_KEY", "STORAGE_API_KEY"] as const;
/** Variables that are plain configuration. */
export const PLAIN_VARS = ["STORAGE_API_URL", "BNBAGENT_PUBLIC_URL"] as const;

type TomlLike = Record<string, unknown>;

function table(v: unknown): TomlLike {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as TomlLike) : {};
}

function filled(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

const norm = (a: string): string => a.trim().toLowerCase().replace(/^0x/, "");

/** True for an upload endpoint on this machine (a local pinning stub needs no write key). */
function isLocalUrl(raw: string | undefined): boolean {
  try {
    const host = new URL(raw ?? "").hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function checkRuntimeEnv(env: NodeJS.ProcessEnv, cfg: TomlLike): RuntimeEnvCheck {
  const enforced = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  // a conflicting or unknown caller identity setting is refused everywhere; "none set" only in production
  const identity = callerIdentityProblems(env, enforced);
  if (!enforced) return { enforced, missing: [], problems: identity, warnings: [] };
  const missing: string[] = [];
  const problems: string[] = [...identity];
  const warnings: string[] = [];

  for (const name of ["WALLET_KEYSTORE_JSON", "WALLET_PASSWORD", "PIEVERSE_LLM_API_KEY", "STORAGE_API_URL"]) {
    if (!filled(env, name)) missing.push(name);
  }
  if (!filled(env, "STORAGE_API_KEY")) {
    // an empty key only fails at the first pin, after the buyer has paid: refuse at boot for a hosted pinning service
    if (table(cfg.storage).kind === "ipfs" && !isLocalUrl(env.STORAGE_API_URL)) {
      problems.push("STORAGE_API_KEY is required when [storage].kind is ipfs and STORAGE_API_URL is not a local address");
    } else {
      warnings.push("STORAGE_API_KEY is not set (hosted pinning services need a write key)");
    }
  }

  // the advertised URL: https, from BNBAGENT_PUBLIC_URL (or the AgentCore variable)
  const pub = publicBaseUrl(env);
  if (pub === null) missing.push("BNBAGENT_PUBLIC_URL");
  else if (!pub.startsWith("https://")) problems.push("BNBAGENT_PUBLIC_URL must be an https URL");

  // the keystore must be the wallet the config anchors (checked without ever printing it)
  const anchored = table(cfg.wallet).address;
  if (typeof anchored !== "string" || anchored.trim() === "") problems.push("studio.toml has no [wallet].address");
  if (filled(env, "WALLET_KEYSTORE_JSON")) {
    try {
      const ks = JSON.parse(env.WALLET_KEYSTORE_JSON as string) as { address?: unknown };
      if (typeof ks.address !== "string" || ks.address === "") problems.push("WALLET_KEYSTORE_JSON has no address field");
      else if (typeof anchored === "string" && norm(ks.address) !== norm(anchored)) {
        problems.push("WALLET_KEYSTORE_JSON is a different wallet than studio.toml [wallet].address");
      }
    } catch {
      problems.push("WALLET_KEYSTORE_JSON is not valid JSON");
    }
  }

  if (typeof table(table(cfg.llm).pieverse).key_hash !== "string") {
    problems.push("studio.toml has no [llm.pieverse].key_hash (run `bag llm activate` locally and commit studio.toml)");
  }

  const port = env.PORT;
  if (port !== undefined && port !== "" && !(/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    problems.push("PORT is not a valid port number");
  }
  return { enforced, missing, problems, warnings };
}

/** Throw a clear boot error (variable names only) when a production boot cannot work; warn on soft items. */
export function assertRuntimeEnv(env: NodeJS.ProcessEnv, cfg: TomlLike, warn: (msg: string) => void = (m) => console.warn(m)): void {
  const r = checkRuntimeEnv(env, cfg);
  for (const w of r.warnings) warn(`[seller-agent] WARNING ${w}`);
  if (r.missing.length === 0 && r.problems.length === 0) return;
  const parts: string[] = [];
  if (r.missing.length > 0) parts.push(`missing environment variables: ${r.missing.join(", ")}`);
  if (r.problems.length > 0) parts.push(r.problems.join("; "));
  throw new Error(`Cannot start in production: ${parts.join(". ")}. See the Railway runbook in BUILD-REPORT.md.`);
}
