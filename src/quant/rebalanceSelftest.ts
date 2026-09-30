/** File-only Quant rebalancer evidence and public wallet-grant exclusion. */
import { createHash, randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { parseConfigBlock, type QuantConfigBlock } from "./termix.js";
import { findExpandedConfigProfile, normalizeExpandedQuantConfig, type QuantExpandedConfigProfile, type QuantRebalanceCapabilityProfile } from "./rebalanceConfig.js";
import { G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID, G2_FINITE_NATIVE_DAY_CAP_WEI, REBALANCE_CAKE, REBALANCE_ETH, REBALANCE_ROUTER, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB } from "./rebalancePolicy.js";
import { rebalancePathKey } from "./rebalanceRoutes.js";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import type { SessionSpec } from "../core/types.js";
import { validateSessionSpec } from "../core/session.js";
import { APPROVE_SIGNATURE, SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE } from "../ops/pancakeTokens.js";
import type { SqlClient } from "../store/sql.js";
import { PostgresQuantJobStore } from "../store/quantJobs.js";
import { PostgresQuantRebalanceStore } from "../store/quantRebalance.js";
import { PostgresQuantWalletClaimStore } from "../store/quantWalletClaims.js";
import { PostgresExecutionJournal } from "../store/journal.js";
import { buildQuantWalletCensus } from "./rebalanceCensus.js";
import type { QuantRebalanceActionRow } from "./rebalanceTypes.js";
import { readSelfTestFile, serializeGrantedSession, type GrantedPermissionsWire, type QuantSelfTestFile } from "./selftest.js";
import { publicKeyEquals, QUANT_ENVELOPE_ALGORITHM, seal, type QuantKeypair } from "./envelope.js";
import { parseSessionPlaintext, permissionsDigest } from "./admission.js";

export const G2_CAPTURE_SHA256 = "7A925003313951FC0480E5A4F6CCD11A9F37D709838D7D23C2D455AE9D76880F";
export const G2_CAPTURE_PROFILE_ID = "g2-file-capture-bf3d32b1-v1";
export const G2_FILE_STRATEGY_ID = "self-test-rebalance-g2";
export const G2_FILE_AGENT_ID = "self-test-rebalance-g2";
export const G2_PROTECTED_U: Address = getAddress("0xcE24439F2D9C6a2289F741120FE202248B666666");
export const FILE_REHEARSAL_ONLY_NO_VENDOR_PROOF: Hex = `0x${"00".repeat(32)}`;

export function appendG2EnvelopeSeed(): void {
  const pathname = resolve(".env.rebalance-g2.local");
  if (!existsSync(pathname) || !lstatSync(pathname).isFile() || lstatSync(pathname).isSymbolicLink()) {
    throw new Error("g2-dedicated-env-missing");
  }
  const original = readFileSync(pathname, "utf8");
  if (/^QUANT_ENVELOPE_KEY\s*=/mu.test(original)) throw new Error("g2-envelope-seed-already-present");
  const fd = openSync(pathname, "a", 0o600);
  try {
    const prefix = original.endsWith("\n") || original.length === 0 ? "" : "\n";
    writeFileSync(fd, `${prefix}QUANT_ENVELOPE_KEY=0x${randomBytes(32).toString("hex")}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "seed-envelope") process.exitCode = 1;
  else {
    try { appendG2EnvelopeSeed(); console.log("g2-envelope-seed-written"); }
    catch { console.error("g2-envelope-seed-refused"); process.exitCode = 1; }
  }
}

export const G2_JOBS = Object.freeze({
  10: { db: "quant_rebalance_g2_low10", job: "self-test-rebalance-g2-low10", file: "scripts/tmp/quant-rebalance-g2-low10.json" },
  30: { db: "quant_rebalance_g2_low30", job: "self-test-rebalance-g2-low30", file: "scripts/tmp/quant-rebalance-g2-low30.json" },
  75: { db: "quant_rebalance_g2_high75", job: "self-test-rebalance-g2-high75", file: "scripts/tmp/quant-rebalance-g2-high75.json" },
} as const);
export const G2_FINITE_JOB = Object.freeze({ db: "quant_rebalance_g2_high75_finite_v2",
  job: "self-test-rebalance-g2-high75-finite-v2",
  file: "scripts/tmp/quant-rebalance-g2-high75-finite-v2.json" } as const);
const allG2Jobs = [...Object.entries(G2_JOBS), ["75", G2_FINITE_JOB] as const] as const;

export function g2Job(allocation: number): typeof G2_JOBS[keyof typeof G2_JOBS] {
  if (allocation !== 10 && allocation !== 30 && allocation !== 75) throw new Error("g2-allocation-invalid");
  return G2_JOBS[allocation];
}

export function g2JobForFile(file: string): { readonly allocation: 10 | 30 | 75;
  readonly mapping: typeof G2_JOBS[keyof typeof G2_JOBS] | typeof G2_FINITE_JOB } {
  const canonical = canonicalG2File(file);
  if (canonicalG2File(G2_FINITE_JOB.file) === canonical) return { allocation: 75, mapping: G2_FINITE_JOB };
  for (const allocation of [10, 30, 75] as const) {
    const mapping = G2_JOBS[allocation];
    if (canonicalG2File(mapping.file) === canonical) return { allocation, mapping };
  }
  throw new Error("g2-file-mapping-invalid");
}

export function g2ProposedFileDigest(allocation: 10 | 30 | 75, file: string): Hex {
  const selected = g2JobForFile(file);
  if (selected.allocation !== allocation) throw new Error("g2-file-allocation-mismatch");
  return keccak256(stringToBytes(`${selected.mapping.job}|${canonicalG2File(file)}|${BigInt(allocation) * 10n ** 18n}`));
}

export function g2SubmissionVerdict(actions: readonly Pick<QuantRebalanceActionRow,
  "preSubmitBlockNumber" | "state" | "side" | "asset" | "path" | "sequence">[], allocation: 10 | 30 | 75):
  Readonly<{ used: number; remaining: number; stop: "budget" | "routes-complete" | "ledger-unreadable" | null }> {
  if (actions.some((action) => action.preSubmitBlockNumber === undefined
    || action.preSubmitBlockNumber !== null && (typeof action.preSubmitBlockNumber !== "bigint" || action.preSubmitBlockNumber < 0n))) {
    return { used: 0, remaining: 0, stop: "ledger-unreadable" };
  }
  const used = 1 + actions.filter((action) => action.preSubmitBlockNumber !== null).length;
  const remaining = Math.max(0, 20 - used);
  if (used >= 20) return { used, remaining, stop: "budget" };
  const assets = allocation === 75 ? ["WBNB", "ETH", "CAKE"] as const : ["WBNB"] as const;
  const completed = assets.every((asset) => {
    const buyPath = asset === "WBNB" ? [REBALANCE_USDC, REBALANCE_WBNB]
      : asset === "ETH" ? [REBALANCE_USDC, REBALANCE_ETH]
        : [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE];
    const buyKey = rebalancePathKey(buyPath);
    const sellKey = rebalancePathKey([...buyPath].reverse());
    const rows = actions.filter((action) => action.asset === asset && action.state === "settled"
      && rebalancePathKey(action.path) === (action.side === "buy" ? buyKey : sellKey));
    return rows.some((sell) => sell.side === "sell" && rows.some((buy) => buy.side === "buy" && buy.sequence > sell.sequence));
  });
  return { used, remaining, stop: completed ? "routes-complete" : null };
}

/** Only the grant branch calls this; parseEnv does not populate process.env. */
export function selectG2OwnerKey(selector: string, fileText: string,
  inherited: Readonly<Record<string, string | undefined>>): Hex {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/u.test(selector) || inherited[selector] !== undefined) {
    throw new Error("g2-owner-selector-invalid");
  }
  const selected = parseEnv(fileText);
  if (!Object.hasOwn(selected, selector)) throw new Error("g2-owner-key-missing");
  const key = selected[selector];
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error("g2-owner-key-invalid");
  return key as Hex;
}

export function loadG2OwnerKey(selector: string): Hex {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/u.test(selector) || process.env[selector] !== undefined) {
    throw new Error("g2-owner-selector-invalid");
  }
  return selectG2OwnerKey(selector, readFileSync(resolve(".env.local"), "utf8"), process.env);
}

export function g2SessionSpec(input: {
  readonly allocation: 10 | 30 | 75;
  readonly finite?: boolean;
  readonly riskCaps: Readonly<Partial<Record<"WBNB" | "ETH" | "CAKE", bigint>>>;
  readonly verifiedPreGrantPaymentMaxWei: bigint | null;
  readonly expiresAt: number;
  readonly nowSeconds: number;
  readonly wallet: Address;
}): SessionSpec {
  const risk = input.allocation === 75 ? ["WBNB", "ETH", "CAKE"] as const : ["WBNB"] as const;
  const addresses = { WBNB: REBALANCE_WBNB, ETH: REBALANCE_ETH, CAKE: REBALANCE_CAKE };
  const caps = risk.map((asset) => {
    const amount = input.riskCaps[asset];
    if (amount === undefined || amount <= 0n) throw new Error("g2-risk-cap-invalid");
    return { token: addresses[asset], limit: amount, period: "day" as const };
  });
  const planning = 45_000_000_000_000n;
  const quoted = input.verifiedPreGrantPaymentMaxWei ?? 0n;
  if (quoted < 0n) throw new Error("g2-fee-quote-invalid");
  const spec: SessionSpec = {
    allowedCalls: [
      { to: REBALANCE_ROUTER, selector: SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE },
      { to: REBALANCE_USDC, selector: APPROVE_SIGNATURE },
      ...risk.map((asset) => ({ to: addresses[asset], selector: APPROVE_SIGNATURE })),
    ],
    spendCaps: [
      { token: REBALANCE_USDC, limit: BigInt(input.allocation) * 2n * 10n ** 18n, period: "day" },
      ...caps,
      { limit: input.finite ? G2_FINITE_NATIVE_DAY_CAP_WEI : 12n * (quoted > planning ? quoted : planning), period: "day" },
    ],
    expiresAt: input.expiresAt,
  };
  validateSessionSpec(spec, { nowSeconds: input.nowSeconds, walletAddress: input.wallet });
  return spec;
}

export function g2RiskCap(initialQuotedWei: bigint): bigint {
  if (initialQuotedWei <= 0n || initialQuotedWei >= (1n << 256n)) throw new Error("g2-risk-quote-invalid");
  const cap = (initialQuotedWei * 202n + 99n) / 100n;
  if (cap >= (1n << 256n)) throw new Error("g2-risk-cap-overflow");
  return cap;
}

export type G2DatabaseIdentity = Readonly<{
  database: string; role: string; server: string; searchPath: string; schemas: readonly string[];
  major: number; conflictingConnections: number; userObjects: number; userSchemas: readonly string[];
}>;
type G2TestIdentity = Readonly<{ database: string; role: string; server: string; guardRoot?: string }>;

function g2PreparationPaths(database: string, root = resolve("scripts/tmp")) {
  if (!/^[a-z0-9_]{1,80}$/u.test(database)) throw new Error("g2-db-name-invalid");
  const base = resolve(root, `quant-rebalance-g2-prepare-${database}`);
  return { guard: `${base}.guard`, complete: `${base}.complete` };
}

function g2PgInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function g2PublicSchemaArray(value: unknown): readonly string[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  return typeof value === "string" && /^\{[a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)*\}$/u.test(value)
    ? value.slice(1, -1).split(",") : null;
}

/** The same pinned connection is passed to every initializer after this check. */
export async function inspectG2Database(sql: SqlClient, allocation: 10 | 30 | 75, expectEmpty: boolean,
  testIdentity?: G2TestIdentity, jobMapping: typeof G2_FINITE_JOB | null = null): Promise<G2DatabaseIdentity> {
  const result = await sql.query<Record<string, unknown>>(`/* g2.identity */ select
    current_database() as database, current_user as role, session_user as session_role,
    host(inet_server_addr()) as server_address, inet_server_port() as server_port,
    current_setting('server_version_num')::int as server_version_num,
    current_setting('search_path') as search_path, current_schemas(false) as schemas,
    (select count(*)::int from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()) as other_connections`);
  const row = result.rows[0];
  const schemas = g2PublicSchemaArray(row?.["schemas"]);
  if (row === undefined || typeof row["database"] !== "string" || typeof row["role"] !== "string"
    || typeof row["session_role"] !== "string" || typeof row["server_address"] !== "string"
    || g2PgInteger(row["server_port"]) === null || g2PgInteger(row["server_version_num"]) === null
    || typeof row["search_path"] !== "string" || schemas === null
    || g2PgInteger(row["other_connections"]) === null) throw new Error("g2-db-identity-unreadable");
  const inventory = await sql.query<Record<string, unknown>>(`/* g2.inventory */ with ns as (
      select oid,nspname from pg_namespace where nspname<>'pg_catalog' and nspname<>'information_schema'
        and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
    ) select array_agg(nspname order by nspname) as user_schemas,
      (select count(*)::int from pg_class where relnamespace in (select oid from ns))
      +(select count(*)::int from pg_proc where pronamespace in (select oid from ns))
      +(select count(*)::int from pg_type where typnamespace in (select oid from ns))
      +(select count(*)::int from pg_extension where extnamespace in (select oid from ns)) as user_objects from ns`);
  const found = inventory.rows[0];
  const userSchemas = g2PublicSchemaArray(found?.["user_schemas"]);
  if (found === undefined || userSchemas === null || g2PgInteger(found["user_objects"]) === null) throw new Error("g2-db-inventory-unreadable");
  const identity: G2DatabaseIdentity = {
    database: row["database"], role: row["role"], server: `${row["server_address"]}:${g2PgInteger(row["server_port"])}`,
    searchPath: row["search_path"], schemas,
    major: Math.floor(g2PgInteger(row["server_version_num"])! / 10000),
    conflictingConnections: g2PgInteger(row["other_connections"])!, userObjects: g2PgInteger(found["user_objects"])!,
    userSchemas,
  };
  const expected = jobMapping ?? g2Job(allocation);
  const selected = testIdentity ?? { database: expected.db, role: expected.db, server: "127.0.0.1:5432" };
  if (identity.database !== selected.database || identity.role !== selected.role || row["session_role"] !== selected.role
    || identity.server !== selected.server || identity.searchPath !== "public"
    || identity.schemas.length !== 1 || identity.schemas[0] !== "public" || identity.major !== 17
    || identity.conflictingConnections !== 0 || identity.userSchemas.length !== 1 || identity.userSchemas[0] !== "public"
    || expectEmpty && identity.userObjects !== 0) throw new Error("g2-db-identity-refused");
  return identity;
}

export async function prepareG2Database(sql: SqlClient, allocation: 10 | 30 | 75, yesLive: boolean,
  testIdentity?: G2TestIdentity, jobMapping: typeof G2_FINITE_JOB | null = null): Promise<G2DatabaseIdentity> {
  const preview = await inspectG2Database(sql, allocation, true, testIdentity, jobMapping);
  const paths = g2PreparationPaths(preview.database, testIdentity?.guardRoot);
  if (existsSync(paths.guard) || existsSync(paths.complete)) throw new Error("g2-db-preparation-already-attempted");
  if (!yesLive) return preview;
  if (sql.transactionScope !== "top-level") throw new Error("g2-db-transaction-unavailable");
  durableWrite(paths.guard, `${preview.database}|${preview.role}|${preview.server}\n`, "wx");
  await sql.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('quant-rebalance-g2-preparation'),hashtext(current_database()))");
    await inspectG2Database(tx, allocation, true, testIdentity, jobMapping);
    await PostgresQuantJobStore.create(tx);
    const rebalancing = new PostgresQuantRebalanceStore(tx);
    await rebalancing.ensureSchema();
    const claims = new PostgresQuantWalletClaimStore(tx);
    await claims.ensureSchema();
    await PostgresExecutionJournal.create(tx);
    const installedAtMs = Date.now();
    const census = buildQuantWalletCensus({ generatedAtMs: installedAtMs, migrationInstalled: false,
      gridJobs: [], gridActions: [], rebalanceJobs: [], rebalanceActions: [], claims: [] });
    const disposition = publicDigest([]);
    await tx.query(`insert into quant_wallet_claim_migration
      (migration_version,census_digest,disposition_digest,installed_at_ms,installed_by)
      values(1,$1,$2,$3::bigint,'g2-file-selftest')`, [census.digest, disposition, installedAtMs]);
  });
  durableWrite(paths.complete, `${JSON.stringify({ database: preview.database, role: preview.role,
    server: preview.server })}\n`, "wx");
  unlinkSync(paths.guard);
  return preview;
}

export async function assertG2PreparedDatabase(sql: SqlClient, allocation: 10 | 30 | 75,
  jobMapping: typeof G2_FINITE_JOB | null = null): Promise<G2DatabaseIdentity> {
  const identity = await inspectG2Database(sql, allocation, false, undefined, jobMapping);
  const paths = g2PreparationPaths(identity.database);
  if (existsSync(paths.guard) || !existsSync(paths.complete)
    || lstatSync(paths.complete).isSymbolicLink()) throw new Error("g2-db-preparation-uncertain");
  const complete = JSON.parse(readFileSync(paths.complete, "utf8")) as unknown;
  if (typeof complete !== "object" || complete === null || Array.isArray(complete)
    || (complete as Record<string, unknown>)["database"] !== identity.database
    || (complete as Record<string, unknown>)["role"] !== identity.role
    || (complete as Record<string, unknown>)["server"] !== identity.server) throw new Error("g2-db-preparation-uncertain");
  const result = await sql.query<Record<string, unknown>>(`/* g2.prepared */ select
    to_regclass('public.quant_jobs') is not null as grid_jobs,
    to_regclass('public.quant_rebalance_jobs') is not null as rebalance_jobs,
    to_regclass('public.quant_rebalance_checks') is not null as rebalance_checks,
    to_regclass('public.quant_rebalance_actions') is not null as rebalance_actions,
    to_regclass('public.quant_wallet_claims') is not null as claims,
    to_regclass('public.execution_journal') is not null as journal,
    to_regclass('public.quant_wallet_claim_migration') is not null as marker`);
  const schema = result.rows[0];
  if (schema === undefined || Object.values(schema).some((value) => value !== true)) throw new Error("g2-db-unprepared");
  const marker = await sql.query<Record<string, unknown>>(`/* g2.marker */ select migration_version,installed_by,census_digest,disposition_digest,installed_at_ms
    from quant_wallet_claim_migration`);
  const installedAtMs = g2PgInteger(marker.rows[0]?.["installed_at_ms"]);
  const expectedCensus = installedAtMs === null ? null : buildQuantWalletCensus({ generatedAtMs: installedAtMs,
    migrationInstalled: false, gridJobs: [], gridActions: [], rebalanceJobs: [], rebalanceActions: [], claims: [] });
  if (marker.rows.length !== 1 || Number(marker.rows[0]?.["migration_version"]) !== 1
    || marker.rows[0]?.["installed_by"] !== "g2-file-selftest"
    || expectedCensus === null || marker.rows[0]?.["census_digest"] !== expectedCensus.digest
    || marker.rows[0]?.["disposition_digest"] !== publicDigest([])) {
    throw new Error("g2-db-marker-invalid");
  }
  const jobs = await sql.query<Record<string, unknown>>(`/* g2.jobs */ select
    (select count(*)::int from quant_jobs) as grid_count,
    (select count(*)::int from quant_rebalance_jobs) as rebalance_count,
    (select count(*)::int from quant_wallet_claims) as claim_count,
    (select min(job_id) from quant_rebalance_jobs) as only_job`);
  const row = jobs.rows[0];
  if (row?.["grid_count"] !== 0 || typeof row["rebalance_count"] !== "number" || row["rebalance_count"] > 1
    || typeof row["claim_count"] !== "number" || row["rebalance_count"] === 0 && row["claim_count"] !== 0
    || row["rebalance_count"] === 1 && row["only_job"] !== (jobMapping ?? g2Job(allocation)).job) throw new Error("g2-db-job-mismatch");
  return identity;
}

function path(...tokens: Address[]): string { return rebalancePathKey(tokens); }

/** Never add either profile to the production registries. */
export function loadG2FileProfiles(finite = false): {
  readonly config: QuantExpandedConfigProfile;
  readonly capability: QuantRebalanceCapabilityProfile;
  readonly block: QuantConfigBlock;
} {
  const fixture = fileURLToPath(new URL("../../test/fixtures/quant/contracts-customization-quant.json", import.meta.url));
  const raw = readFileSync(fixture);
  if (createHash("sha256").update(raw).digest("hex").toUpperCase() !== G2_CAPTURE_SHA256) throw new Error("g2-capture-hash-mismatch");
  const parsed = parseConfigBlock(JSON.parse(raw.toString("utf8")) as unknown);
  if (!parsed.ok) throw new Error("g2-capture-invalid");
  const normalized = normalizeExpandedQuantConfig(parsed.data);
  if (!normalized.ok || normalized.projection.chainId !== 56
    || normalized.projection.u.toLowerCase() !== REBALANCE_USDC.toLowerCase()
    || normalized.projection.uDecimals !== 18) throw new Error("g2-capture-invalid");
  const config: QuantExpandedConfigProfile = {
    id: G2_CAPTURE_PROFILE_ID,
    capturedEvidenceRef: "C:/Users/Pro/Downloads/contracts.customization BF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46; test/fixtures/quant/contracts-customization-quant.json 7A925003313951FC0480E5A4F6CCD11A9F37D709838D7D23C2D455AE9D76880F",
    capturedEvidenceDigest: "0xBF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46",
    expected: normalized.projection, expectedVenueRowCount: 14, expectedUniqueVenueTargetCount: 12,
  };
  if (findExpandedConfigProfile(normalized.projection, [config]) === null) throw new Error("g2-capture-profile-mismatch");
  const capability: QuantRebalanceCapabilityProfile = {
    id: finite ? G2_FINITE_CAPABILITY_ID : G2_FILE_CAPABILITY_ID,
    capturedConfigProfileId: config.id, wireVersion: "quant-job-v1-file",
    grantShapes: ["selector-scoped"], toleratedGrantTargets: [], duplicateWholeGrantTargets: [],
    executionRoutes: [
      path(REBALANCE_USDC, REBALANCE_WBNB), path(REBALANCE_WBNB, REBALANCE_USDC),
      path(REBALANCE_USDC, REBALANCE_ETH), path(REBALANCE_ETH, REBALANCE_USDC),
      path(REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE), path(REBALANCE_CAKE, REBALANCE_WBNB, REBALANCE_USDC),
    ],
    referenceRoutes: [
      path(REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB), path(REBALANCE_WBNB, REBALANCE_USDT, REBALANCE_USDC),
      path(REBALANCE_USDC, REBALANCE_USDT, REBALANCE_ETH), path(REBALANCE_ETH, REBALANCE_USDT, REBALANCE_USDC),
      path(REBALANCE_USDC, REBALANCE_USDT, REBALANCE_CAKE), path(REBALANCE_CAKE, REBALANCE_USDT, REBALANCE_USDC),
    ],
    maximumExitGasUnits: 600_000n,
    indexingEvidenceDigest: FILE_REHEARSAL_ONLY_NO_VENDOR_PROOF,
    reportEvidenceDigest: FILE_REHEARSAL_ONLY_NO_VENDOR_PROOF,
  };
  return { config, capability, block: parsed.data };
}

/** The caller still checks the exact allocation-to-file mapping. */
export function canonicalG2File(input: string): string {
  const root = realpathSync(resolve("scripts/tmp"));
  const absolute = resolve(input);
  if (relative(root, absolute).startsWith("..") || dirname(absolute) !== root || basename(absolute) === "") throw new Error("g2-file-path-invalid");
  if (existsSync(absolute) && (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile())) throw new Error("g2-file-path-invalid");
  return absolute;
}

export type G2GrantClaim = Readonly<{
  version: 1; chainId: 56; wallet: Address; database: string; role: string; server: "127.0.0.1:5432";
  jobId: string; file: string; fileFactsDigest: Hex; publicKey: Hex; keyId: Hex;
  permissionsDigest: Hex; expirySec: number; state: "claiming" | "grant-uncertain" | "ready";
  outputDigest: Hex | null; grantNativeDebitWei: string | null;
  baselineBlock: string; baselineHash: Hex;
  freshWalletProof?: Readonly<{ wallet: Address; blockNumber: string; blockHash: Hex; code: "0x"; registryKeys: 0 }>;
  actualBaseline: Readonly<Record<"USDC" | "WBNB" | "ETH" | "CAKE" | "USDT" | "U" | "BNB", string>>;
  protectedBaseline: Readonly<Record<"USDC" | "WBNB" | "ETH" | "CAKE" | "USDT" | "U" | "BNB", string>>;
  approvedNativeFloatWei: string;
}>;

export function g2ClaimPath(wallet: Address): string {
  return resolve("scripts/tmp", `quant-rebalance-g2-grant-56-${getAddress(wallet).slice(2).toLowerCase()}.json`);
}

function guardPath(wallet: Address): string { return `${g2ClaimPath(wallet)}.guard`; }

function archivedClaims(wallet: Address): readonly string[] {
  const canonical = g2ClaimPath(wallet);
  return readdirSync(dirname(canonical)).filter((name) => name.startsWith(`${basename(canonical)}.`) && name.endsWith(".archive"))
    .map((name) => resolve(dirname(canonical), name));
}

function assertReleasedArchives(wallet: Address): void {
  const archives = archivedClaims(wallet);
  for (const pathname of archives) {
    const archived = readClaim(pathname);
    const completed = JSON.parse(readFileSync(`${pathname}.complete`, "utf8")) as unknown;
    const released = readFileSync(`${pathname}.released`, "utf8").trim();
    if (typeof completed !== "object" || completed === null || Array.isArray(completed)
      || (completed as Record<string, unknown>)["claimDigest"] !== publicDigest(archived)
      || released !== publicDigest(archived)) throw new Error("g2-prior-close-unverified");
  }
}

function durableWrite(pathname: string, bytes: string, flag: "wx" | "w"): void {
  const fd = openSync(pathname, flag, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function publicDigest(value: unknown): Hex { return keccak256(stringToBytes(rebalanceCanonicalEncode(value))); }

export type G2File = QuantSelfTestFile & { readonly grantState: "claiming" | "grant-uncertain" | "ready" };
export function g2FileFactsDigest(file: G2File): Hex {
  return publicDigest({ version: file.version, config: file.config, agentKey: file.agentKey,
    inbox: file.inbox, jobs: file.jobs });
}

export function readG2ReadyFile(filePath: string, allocation: 10 | 30 | 75, keypair: QuantKeypair): G2File {
  const file = readSelfTestFile(canonicalG2File(filePath)) as G2File;
  const selected = g2JobForFile(filePath);
  if (selected.allocation !== allocation) throw new Error("g2-file-allocation-mismatch");
  const mapping = selected.mapping;
  const parsed = normalizeExpandedQuantConfig(file.config);
  const profile = loadG2FileProfiles().config;
  const job = file.jobs[0];
  if (Object.keys(file).sort().join("|") !== "agentKey|config|grantState|inbox|jobs|reports|version"
    || file.reports.some((report) => Object.keys(report).sort().join("|") !== "payload|quantJobId"
      || Object.keys(report.payload).sort().join("|") !== "trades"
      || !Array.isArray(report.payload.trades)
      || report.payload.trades.some((trade) => Object.keys(trade).sort().join("|") !== "note|txHash"
        || !/^0x[0-9a-fA-F]{64}$/u.test(trade.txHash)
        || !/^(buy|sell):(WBNB|ETH|CAKE)$/u.test(trade.note)))
    || file.grantState !== "ready" || !parsed.ok || findExpandedConfigProfile(parsed.projection, [profile]) === null
    || file.jobs.length !== 1 || job?.id !== mapping.job || job.strategyId !== G2_FILE_STRATEGY_ID
    || job.termDays !== 2 || job.allocationUWei !== (BigInt(allocation) * 10n ** 18n).toString(10)
    || job.dailyCapUWei !== (BigInt(allocation) * 2n * 10n ** 18n).toString(10)
    || file.inbox.length !== 1 || file.inbox[0]?.quantJobId !== mapping.job
    || file.agentKey.algorithm !== QUANT_ENVELOPE_ALGORITHM
    || file.agentKey.encryptionPublicKey === null
    || !publicKeyEquals(Buffer.from(file.agentKey.encryptionPublicKey, "base64"), keypair.publicKey)) {
    throw new Error("g2-file-not-ready");
  }
  const claim = readG2GrantClaim(job.tradingWalletAddress);
  if (existsSync(guardPath(claim.wallet)) || claim.state !== "ready" || claim.jobId !== job.id || claim.file !== canonicalG2File(filePath)
    || claim.database !== mapping.db || claim.outputDigest !== g2FileFactsDigest(file)) throw new Error("g2-claim-file-mismatch");
  return file;
}

function readClaim(pathname: string): G2GrantClaim {
  if (lstatSync(pathname).isSymbolicLink()) throw new Error("g2-claim-unreadable");
  const value = JSON.parse(readFileSync(pathname, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("g2-claim-unreadable");
  const claim = value as G2GrantClaim;
  const hash = (item: unknown): item is Hex => typeof item === "string" && /^0x[0-9a-fA-F]{64}$/u.test(item);
  const atomic = (item: unknown): item is string => typeof item === "string" && /^(0|[1-9][0-9]*)$/u.test(item);
  const mapping = allG2Jobs.find(([, item]) => item.db === claim.database && item.job === claim.jobId);
  let wallet: Address | null = null;
  try { wallet = getAddress(claim.wallet); } catch { /* invalid address */ }
  const keys = ["USDC", "WBNB", "ETH", "CAKE", "USDT", "U", "BNB"] as const;
  if (claim.version !== 1 || claim.chainId !== 56 || wallet === null || wallet !== claim.wallet
    || mapping === undefined || claim.role !== claim.database || claim.server !== "127.0.0.1:5432"
    || claim.file !== canonicalG2File(mapping[1].file) || !hash(claim.fileFactsDigest)
    || claim.fileFactsDigest !== g2ProposedFileDigest(Number(mapping[0]) as 10 | 30 | 75, claim.file)
    || typeof claim.publicKey !== "string" || !/^0x04[0-9a-fA-F]{128}$/u.test(claim.publicKey)
    || !hash(claim.keyId) || claim.keyId.toLowerCase() !== keccak256(claim.publicKey).toLowerCase()
    || !hash(claim.permissionsDigest) || !Number.isSafeInteger(claim.expirySec) || claim.expirySec <= 0
    || !atomic(claim.baselineBlock) || !hash(claim.baselineHash)
    || claim.jobId === G2_FINITE_JOB.job && claim.freshWalletProof === undefined
    || claim.freshWalletProof !== undefined && (typeof claim.freshWalletProof !== "object" || claim.freshWalletProof === null
      || claim.freshWalletProof.wallet !== claim.wallet || claim.freshWalletProof.code !== "0x"
      || claim.freshWalletProof.registryKeys !== 0
      || claim.freshWalletProof.blockNumber !== claim.baselineBlock
      || claim.freshWalletProof.blockHash !== claim.baselineHash)
    || typeof claim.actualBaseline !== "object" || claim.actualBaseline === null
    || typeof claim.protectedBaseline !== "object" || claim.protectedBaseline === null
    || keys.some((key) => !atomic(claim.actualBaseline[key]) || !atomic(claim.protectedBaseline[key]))
    || !atomic(claim.approvedNativeFloatWei) || BigInt(claim.approvedNativeFloatWei) <= 0n
    || BigInt(claim.actualBaseline.BNB) !== BigInt(claim.protectedBaseline.BNB) + BigInt(claim.approvedNativeFloatWei)
    || BigInt(claim.actualBaseline.USDC) !== BigInt(claim.protectedBaseline.USDC) + BigInt(mapping[0]) * 10n ** 18n
    || ["WBNB", "ETH", "CAKE", "USDT", "U"].some((key) => claim.actualBaseline[key as keyof typeof claim.actualBaseline]
      !== claim.protectedBaseline[key as keyof typeof claim.protectedBaseline])
    || !["claiming", "grant-uncertain", "ready"].includes(claim.state)
    || claim.state === "ready" && (!hash(claim.outputDigest) || !atomic(claim.grantNativeDebitWei))
    || claim.state === "claiming" && (claim.outputDigest !== null || claim.grantNativeDebitWei !== null)) {
    throw new Error("g2-claim-unreadable");
  }
  return claim;
}

type G2Boundary = "guard-acquired" | "claim-created" | "provider-returned" | "serialized" | "sealed"
  | "output-temp-written" | "output-published" | "ready-temp-written" | "ready-published"
  | "archive-written" | "canonical-removed" | "complete-written" | "guard-released" | "release-recorded";
type G2Fault = (boundary: G2Boundary) => void;

function withGuard<T>(wallet: Address, run: () => T, fault?: G2Fault): T {
  const guard = guardPath(wallet);
  durableWrite(guard, `${Date.now()}:${process.pid}\n`, "wx");
  let completed = false;
  try {
    fault?.("guard-acquired");
    const result = run();
    completed = true;
    return result;
  } finally {
    // A failed or ambiguous mutation retains the guard for supervised recovery.
    if (completed) unlinkSync(guard);
  }
}

export function createG2GrantClaim(claim: G2GrantClaim, fault?: G2Fault): void {
  const selected = g2JobForFile(claim.file);
  if (claim.state !== "claiming" || claim.outputDigest !== null || claim.grantNativeDebitWei !== null || claim.wallet !== getAddress(claim.wallet)
    || claim.database !== claim.role || claim.server !== "127.0.0.1:5432"
    || claim.fileFactsDigest !== g2ProposedFileDigest(selected.allocation, claim.file)
    || !allG2Jobs.some(([, job]) => job.db === claim.database && job.job === claim.jobId && canonicalG2File(job.file) === claim.file)
    || claim.freshWalletProof !== undefined && (claim.freshWalletProof.wallet !== claim.wallet || claim.freshWalletProof.code !== "0x"
      || claim.freshWalletProof.registryKeys !== 0
      || claim.freshWalletProof.blockNumber !== claim.baselineBlock
      || claim.freshWalletProof.blockHash !== claim.baselineHash)) {
    throw new Error("g2-claim-invalid");
  }
  const created = withGuard(claim.wallet, () => {
    const pathname = g2ClaimPath(claim.wallet);
    if (existsSync(pathname)) return false;
    const archives = archivedClaims(claim.wallet);
    if (claim.jobId === G2_FINITE_JOB.job) {
      if (archives.length !== 0 || claim.freshWalletProof === undefined) return false;
    } else if (claim.jobId !== G2_JOBS[10].job
      && !archives.some((archive) => readClaim(archive).jobId === G2_JOBS[10].job)
      && !(claim.jobId === G2_JOBS[75].job && archives.length === 0 && claim.freshWalletProof !== undefined)) return false;
    assertReleasedArchives(claim.wallet);
    durableWrite(pathname, `${JSON.stringify(claim)}\n`, "wx");
    fault?.("claim-created");
    return true;
  }, fault);
  if (!created) throw new Error("g2-wallet-already-claimed");
}

export function readG2GrantClaim(wallet: Address): G2GrantClaim { return readClaim(g2ClaimPath(wallet)); }

export function findG2GrantClaimForFile(file: string): G2GrantClaim | null {
  const target = canonicalG2File(file);
  const root = dirname(target);
  const claims: G2GrantClaim[] = [];
  for (const name of readdirSync(root)) {
    if (!/^quant-rebalance-g2-grant-56-[0-9a-f]{40}\.json$/u.test(name)) continue;
    const claim = readClaim(resolve(root, name));
    if (claim.file === target) claims.push(claim);
  }
  if (claims.length > 1) throw new Error("g2-claim-duplicate");
  return claims[0] ?? null;
}

export function releaseG2PreProviderClaim(expected: G2GrantClaim): void {
  const released = withGuard(expected.wallet, () => {
    const pathname = g2ClaimPath(expected.wallet);
    const current = readClaim(pathname);
    if (current.state !== "claiming" || publicDigest(current) !== publicDigest(expected)) return false;
    if (existsSync(expected.file)) {
      const output = readSelfTestFile(expected.file) as G2File;
      if (output.grantState !== "claiming" || output.inbox.length !== 0 || output.jobs.length !== 0) return false;
      unlinkSync(expected.file);
    }
    unlinkSync(pathname);
    return true;
  });
  if (!released) throw new Error("g2-pre-provider-release-refused");
}

export function markG2GrantUncertain(expected: G2GrantClaim): void {
  withGuard(expected.wallet, () => {
    const pathname = g2ClaimPath(expected.wallet);
    const current = readClaim(pathname);
    if (current.wallet !== expected.wallet || current.file !== expected.file || current.jobId !== expected.jobId
      || current.keyId !== expected.keyId || current.permissionsDigest !== expected.permissionsDigest
      || !(current.state === "claiming" || current.state === "ready")) throw new Error("g2-claim-changed");
    const temp = `${pathname}.${process.pid}.uncertain.tmp`;
    durableWrite(temp, `${JSON.stringify({ ...current, state: "grant-uncertain" })}\n`, "wx");
    renameSync(temp, pathname);
  });
}

export function publishG2ReadyClaim(expected: G2GrantClaim, outputDigest: Hex, grantNativeDebitWei: bigint,
  fault?: G2Fault): G2GrantClaim {
  if (grantNativeDebitWei < 0n) throw new Error("g2-grant-cost-unverified");
  const ready = withGuard(expected.wallet, () => {
    const pathname = g2ClaimPath(expected.wallet);
    if (!existsSync(pathname)) return null;
    const current = readClaim(pathname);
    if (publicDigest(current) !== publicDigest(expected) || current.state !== "claiming") return null;
    const ready: G2GrantClaim = { ...current, state: "ready", outputDigest,
      grantNativeDebitWei: grantNativeDebitWei.toString(10) };
    const temp = `${pathname}.${process.pid}.tmp`;
    durableWrite(temp, `${JSON.stringify(ready)}\n`, "wx");
    fault?.("ready-temp-written");
    renameSync(temp, pathname);
    fault?.("ready-published");
    return ready;
  }, fault);
  if (ready === null) throw new Error("g2-claim-changed");
  return ready;
}

export function publishG2GrantedOutput(input: {
  readonly claim: G2GrantClaim;
  readonly publicKey: Hex;
  readonly permissions: GrantedPermissionsWire;
  readonly privateKey: Hex;
  readonly keypair: QuantKeypair;
  readonly config: QuantConfigBlock;
  readonly job: G2File["jobs"][number];
  readonly grantNativeDebitWei: bigint;
  readonly fault?: G2Fault;
}): G2GrantClaim {
  const { claim, fault } = input;
  const allocation = g2JobForFile(claim.file).allocation;
  if (input.job.id !== claim.jobId || input.job.tradingWalletAddress.toLowerCase() !== claim.wallet.toLowerCase()
    || input.job.strategyId !== G2_FILE_STRATEGY_ID || input.job.termDays !== 2
    || input.job.allocationUWei !== (BigInt(allocation) * 10n ** 18n).toString(10)
    || input.job.dailyCapUWei !== (BigInt(allocation) * 2n * 10n ** 18n).toString(10)) {
    throw new Error("g2-grant-job-mismatch");
  }
  if (input.publicKey.toLowerCase() !== claim.publicKey.toLowerCase()) throw new Error("g2-grant-key-mismatch");
  const placeholder = readSelfTestFile(claim.file) as G2File;
  if (placeholder.grantState !== "claiming" || placeholder.inbox.length !== 0 || placeholder.jobs.length !== 0) {
    throw new Error("g2-output-not-claimed");
  }
  fault?.("provider-returned");
  const plaintext = serializeGrantedSession({ walletAddress: claim.wallet, publicKey: input.publicKey,
    expiry: claim.expirySec, permissions: input.permissions, privateKey: input.privateKey });
  const parsed = parseSessionPlaintext(plaintext);
  if (!parsed.ok || permissionsDigest(parsed.session.permissions) !== claim.permissionsDigest) {
    throw new Error("g2-grant-permissions-mismatch");
  }
  fault?.("serialized");
  const envelope = seal(plaintext, input.keypair.publicKey);
  fault?.("sealed");
  const output: G2File = { version: 1, config: input.config,
    agentKey: { encryptionPublicKey: input.keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
    inbox: [{ envelopeId: `env-${claim.jobId}`, quantJobId: claim.jobId, ...envelope }],
    jobs: [input.job], reports: [], grantState: "ready" };
  const temp = `${claim.file}.${process.pid}.g2.tmp`;
  durableWrite(temp, `${JSON.stringify(output, null, 2)}\n`, "wx");
  fault?.("output-temp-written");
  renameSync(temp, claim.file);
  fault?.("output-published");
  return publishG2ReadyClaim(claim, g2FileFactsDigest(output), input.grantNativeDebitWei, fault);
}

export type G2DeadAuthorityProof = Readonly<{ blockNumber: string; blockHash: Hex; timestampSec: number; keyId: Hex; expired: true }>;

/** The released witness is written only after the guard unlink was acknowledged. */
export function closeG2GrantClaim(expected: G2GrantClaim, proof: G2DeadAuthorityProof, fault?: G2Fault): string {
  if (expected.state !== "ready" || proof.keyId !== expected.keyId || proof.timestampSec < expected.expirySec
    || !/^(0|[1-9][0-9]*)$/u.test(proof.blockNumber)) throw new Error("g2-close-not-proven");
  const pathname = g2ClaimPath(expected.wallet);
  const guard = guardPath(expected.wallet);
  durableWrite(guard, `${Date.now()}:${process.pid}\n`, "wx");
  fault?.("guard-acquired");
  if (!existsSync(pathname)) {
    unlinkSync(guard);
    throw new Error("g2-claim-changed");
  }
  const current = readClaim(pathname);
  if (publicDigest(current) !== publicDigest(expected)) {
    unlinkSync(guard);
    throw new Error("g2-claim-changed");
  }
  const archive = `${pathname}.${expected.jobId}.${publicDigest(expected).slice(2, 18)}.archive`;
  durableWrite(archive, `${JSON.stringify(current)}\n`, "wx");
  fault?.("archive-written");
  if (publicDigest(readClaim(archive)) !== publicDigest(current)) throw new Error("g2-archive-unverified");
  unlinkSync(pathname);
  fault?.("canonical-removed");
  durableWrite(`${archive}.complete`, `${JSON.stringify({ claimDigest: publicDigest(current), proof })}\n`, "wx");
  fault?.("complete-written");
  unlinkSync(guard);
  fault?.("guard-released");
  durableWrite(`${archive}.released`, `${publicDigest(current)}\n`, "wx");
  fault?.("release-recorded");
  return archive;
}
