import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Address } from "viem";
import type { AgentStore } from "../store/agents.js";
import { AgentExistsError } from "../store/agents.js";
import type { TradeSettingsStore } from "../store/tradeSettings.js";
import type { CmcBudgetStore } from "../store/tradeCmc.js";
import { isTradeDcaSettings, isTradePortfolioSettings, isTradeScheduleSettings, tradeSettingsDigest } from "../trade/settings.js";
import { dcaPoolForToken, dcaPoolLegs } from "../trade/dca.js";
import { MAX_GRANTED_TOKENS_TRADFI, checkTradfiPortfolioSizing, checkTradfiScheduleSizing, checkTradfiV2Sizing, tradfiV2NativeReserveWei } from "../trade/sizing.js";
import { MAX_UINT256, USDT_56 } from "../trade/settlement.js";
import { AGENTIC_HIRE_REASONS, agenticAddress, agenticDecimal, agenticGate, agenticGateInput, agenticHasCmc, agenticHireBudgetWei, agenticHireIdentity, agenticQuoteDayCapWei, agenticUiString, parseAgenticHireParams, projectAgenticSessionFacts,
  type AgenticHireParams, type AgenticWallet, type AgenticFactsRead, type AgenticFence, type AgenticSession } from "./domain.js";
import { type BawRunner } from "./baw.js";
import { AgenticStore, encryptAgenticSession, decryptAgenticSession } from "./store.js";
import type { AgenticChain } from "./resolve.js";
import type { AgenticInstanceManager } from "./instances.js";
import { acquireAgenticFence } from "./obligations.js";
import { categoryForAgenticHire } from "../identity/types.js";
import { AGENTIC_RFQ_PIN_MAX, agenticRfqFacts, mapWithConcurrency, type AgenticRfqPin } from "./rfq.js";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
export type AgenticRoutesDeps = {
  store: AgenticStore; agents: AgentStore; settings: TradeSettingsStore; cmc: CmcBudgetStore;
  runner: BawRunner; chain: AgenticChain; masterKey: Buffer; instance: AgenticInstanceManager;
  ready(): boolean; origins: readonly string[]; publicView(wallet: Address): Promise<unknown>;
  resumeEnding(row: AgenticWallet): Promise<void>;
  /** AGENTIC_DCA_ENABLED of this process: absent or false refuses every DCA hire (dca-disabled). */
  dcaEnabled?: boolean;
  /** AGENTIC_RFQ_STOCKS_ENABLED of this process (AGENTIC-RFQ-STOCKS E1): absent or false leaves every hire on today's pin and sizing. */
  rfqEnabled?: boolean;
};

export class AgenticPairings {
  readonly deps: AgenticRoutesDeps;
  pin: ((W: Address, min: bigint, slippage: number, mode?: "ai" | "schedule") => Promise<readonly Address[]>) | null = null;
  schedulable: ((amountWei: bigint, slippageBps: number) => Promise<readonly Address[]>) | null = null;
  scheduleCapability: ((token: Address, minEntryAtomic: bigint) => string | null) | null = null;
  /** Present only when PORTFOLIO_ENABLED: one direct buy quote at a stock's initial leg; a throw means no quote. Absent refuses every portfolio hire. */
  portfolioBuyQuote: ((token: Address, amountInAtomic: bigint, slippageBps: number) => Promise<void>) | null = null;
  /** Present only when AGENTIC_RFQ_STOCKS_ENABLED: the Agentic AI pin variant (pooled stocks, then the RFQ-only ones). Absent leaves an AI hire on `pin`. */
  rfqPin: (() => Promise<AgenticRfqPin>) | null = null;
  readonly #waiting = new Map<string, { cancel(): void; task: Promise<void> }>();
  readonly #tasks = new Set<Promise<unknown>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping: Promise<void> | null = null;
  #stopping = false;
  constructor(deps: AgenticRoutesDeps) { this.deps = deps; }
  async start(): Promise<void> {
    for (const row of await this.deps.store.wallets()) if (row.state === "waiting") await this.deps.store.patchWallet(row, { state: "expired", failure: "verifier-restarted" });
    await this.sweep();
    this.#timer = setInterval(() => { if (this.#sweeping === null) {
      this.#sweeping = this.sweep().catch(() => { console.error("agentic_pairing_sweep_failed"); }).finally(() => { this.#sweeping = null; });
    } }, 60_000);
  }
  async close(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    for (const waiting of this.#waiting.values()) waiting.cancel();
    this.deps.runner.killChildren();
    await Promise.allSettled([...this.#tasks, ...[...this.#waiting.values()].map(w => w.task), ...(this.#sweeping === null ? [] : [this.#sweeping])]);
  }
  track<T>(work: Promise<T>): Promise<T> { this.#tasks.add(work); void work.finally(() => this.#tasks.delete(work)).catch(() => undefined); return work; }
  async create(): Promise<{ pairingId: string; urlForWeb: string; expireAtMs: number; pairingSecret: string }> {
    if (this.#stopping || !this.deps.ready()) throw new Error("agentic_not_ready");
    const now = await this.deps.store.now(), pairingId = randomUUID(), secret = randomBytes(32).toString("hex");
    let row: AgenticWallet = { pairingId, state: "waiting", walletAddress: null, ownerAddress: null, pairingSecretHash: digest(secret), qr: null,
      codeHash: "", codeAttempts: 0, codeMatchedAt: null, verifiedAt: null, continuationDeadline: null, sessionCiphertext: null, factsRead: null,
      hireOpId: null, agentId: null, hireParams: null, hireStage: null, acceptedAt: null, hireFacts: null, hireEndMs: null, entryCutoffMs: null,
      termEndAction: null, drainRequestedAt: null, settingsHold: null, entriesStopped: null, probe: null, endReason: null, endBlockers: null,
      endStage: null, logout: null, cleanupReason: null, failure: null, version: 1, createdAt: now, updatedAt: now };
    if (!await this.deps.store.createWallet(row)) throw new Error("pairing_slots_full");
    const command = await this.deps.runner.prepare(["auth", "signin"], null);
    const instanceId = command.environment["BINANCE_INSTANCE_ID"]!;
    let handedOff = false;
    try {
      const result = await command.start();
      if (result.kind !== "ok" || typeof result.data !== "object" || result.data === null) throw new Error("pairing_signin_failed");
      const d = result.data as Record<string, unknown>;
      const expiry = typeof d["expireAt"] === "string" ? (/^\d+$/.test(d["expireAt"]) ? Number(d["expireAt"]) : Date.parse(d["expireAt"])) : NaN;
      if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 330_000 || typeof d["urlForWeb"] !== "string" || typeof d["qrCodeId"] !== "string" || typeof d["pairingCode"] !== "string") throw new Error("pairing_signin_failed");
      const updated = await this.deps.store.patchWallet(row, { qr: { qrCodeId: d["qrCodeId"], urlForWeb: d["urlForWeb"], expireAtMs: expiry }, codeHash: digest(d["pairingCode"].toLowerCase()) });
      if (updated === null) throw new Error("pairing_conflict");
      row = updated;
      let cancelled = false;
      let cancelChild: (() => void) | null = null;
      const task = this.#verify(row, command.directory, instanceId, () => cancelled, cancel => { cancelChild = cancel; if (cancelled) cancel(); }).finally(() => this.#waiting.delete(pairingId));
      this.#waiting.set(pairingId, { cancel: () => { cancelled = true; cancelChild?.(); }, task });
      handedOff = true;
      return { pairingId, urlForWeb: d["urlForWeb"], expireAtMs: expiry, pairingSecret: secret };
    } catch {
      await this.deps.store.patchWallet(row, { state: "failed", failure: "pairing_signin_failed" });
      throw new Error("pairing_signin_failed");
    } finally { if (!handedOff) await command.close(); }
  }
  async #verify(row: AgenticWallet, directory: string, instanceId: string, cancelled: () => boolean, onCancel: (cancel: () => void) => void): Promise<void> {
    const { runner, store, chain, masterKey } = this.deps;
    const verify = await runner.prepareInDirectory(directory, ["auth", "verify", "--qrCodeId", row.qr!.qrCodeId], instanceId, row.qr!.expireAtMs + 15_000);
    onCancel(verify.cancel);
    try {
      const result = await verify.start();
      let failure = "pairing_verify_failed";
      if (result.kind === "ok" && !cancelled()) {
        const address = await runner.prepareInDirectory(directory, ["wallet", "address"], instanceId);
        const response = await address.start();
        if (response.kind === "ok" && typeof response.data === "object" && response.data !== null) {
          const addresses = (response.data as { addresses: { binanceChainId: string; address: string }[] }).addresses;
          const W = agenticAddress(addresses.find(a => a.binanceChainId === "56")?.address ?? "");
          failure = await this.admission(W);
          if (failure === "") {
            for (const [command, status] of [["market-order", "PENDING"], ["limit-order", "PENDING"], ["limit-order", "WORKING"], ["limit-order", "TRIGGERED"]]) {
              const list = await runner.prepareInDirectory(directory, [command!, "list", "--binanceChainId", "56", "--status", status!, "--page", "1", "--pageSize", "100"], instanceId);
              const r = await list.start();
              if (r.kind !== "ok" || typeof r.data !== "object" || r.data === null || (r.data as { total: number }).total !== 0) { failure = command === "market-order" ? "wallet_has_pending_orders" : "wallet_has_limit_orders"; break; }
            }
          }
          if (failure === "" && !cancelled() && await chain.code(W) === "0x") {
            const session: AgenticSession = { v: 1, instanceId, sessionJson: await readFile(join(directory, "baw", "session.json"), "utf8") };
            const current = await store.getWallet(row.pairingId), now = await store.now();
            if (current?.state === "waiting" && await store.patchWallet(current, { state: "verified", walletAddress: W, ownerAddress: W,
              sessionCiphertext: encryptAgenticSession(session, masterKey, row.pairingId, W), verifiedAt: now, continuationDeadline: now + 1_800_000 }) !== null) return;
            failure = "pairing_conflict";
          }
        }
      }
      try { const logout = await runner.prepareInDirectory(directory, ["auth", "signout"], instanceId); await logout.start(); } catch { /* Credential may never have been produced. */ }
      const current = await store.getWallet(row.pairingId);
      if (current?.state === "waiting") await store.patchWallet(current, { state: cancelled() && current.codeAttempts < 5 ? "expired" : "failed",
        failure: cancelled() ? current.codeAttempts >= 5 ? "pairing_code_attempts" : "pairing_expired" : failure || "pairing_verify_failed" });
    } catch {
      try { const logout = await runner.prepareInDirectory(directory, ["auth", "signout"], instanceId); await logout.start(); } catch { /* Cleanup never retains credentials. */ }
      const current = await store.getWallet(row.pairingId);
      if (current?.state === "waiting") await store.patchWallet(current, { state: cancelled() && current.codeAttempts < 5 ? "expired" : "failed",
        failure: cancelled() ? current.codeAttempts >= 5 ? "pairing_code_attempts" : "pairing_expired" : "pairing_verify_failed" });
    } finally { await verify.close(); }
  }
  async admission(W: Address): Promise<string> {
    const rows = await this.deps.store.wallets();
    if (rows.some(r => r.walletAddress === W && ["hiring", "bound", "ending"].includes(r.state))) return "wallet_in_use";
    if (await this.deps.store.walletObligations(W)) return "wallet_obligations";
    if (await this.deps.chain.code(W) !== "0x") return "wallet_has_code";
    return "";
  }
  async code(row: AgenticWallet, code: string): Promise<void> {
    if (row.codeMatchedAt !== null) return;
    const now = await this.deps.store.now();
    if (!["waiting", "verified"].includes(row.state)) throw new Error("pairing_not_ready");
    if (row.codeAttempts >= 5) throw new Error("pairing_code_attempts");
    if (row.verifiedAt !== null && now >= row.verifiedAt + 120_000) throw new Error("pairing_code_expired");
    code = code.trim().replace(/ /g, "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(code)) throw new Error("pairing_code_invalid");
    const matches = timingSafeEqual(Buffer.from(digest(code), "hex"), Buffer.from(row.codeHash, "hex"));
    const updated = await this.deps.store.patchWallet(row, { codeAttempts: row.codeAttempts + 1, ...(matches ? { codeMatchedAt: now } : {}) });
    if (updated === null) throw new Error("pairing_conflict");
    if (!matches && updated.codeAttempts >= 5) {
      if (updated.state === "waiting") {
        const waiting = this.#waiting.get(row.pairingId); waiting?.cancel(); await waiting?.task;
        const current = await this.deps.store.getWallet(row.pairingId);
        if (current !== null) await this.deps.store.patchWallet(current, { state: "failed", failure: "pairing_code_attempts" });
      }
      else await this.cleanup(updated, "pairing_code_attempts");
      throw new Error("pairing_code_attempts");
    }
    if (!matches) throw new Error("pairing_code_mismatch");
  }
  async facts(row: AgenticWallet, fence?: AgenticFence): Promise<AgenticFactsRead> {
    if (row.walletAddress === null) throw new Error("pairing_not_verified");
    if (fence !== undefined && await this.deps.store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
    const status = await this.deps.runner.run(["wallet", "status"], decryptAgenticSession(row, this.deps.masterKey));
    if (fence !== undefined && await this.deps.store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
    const settings = await this.deps.runner.run(["wallet", "settings"], decryptAgenticSession(row, this.deps.masterKey));
    if (status.kind !== "ok" || settings.kind !== "ok" || typeof settings.data !== "object" || settings.data === null) throw new Error("AGENTIC_SETTINGS_UNREADABLE");
    const s = settings.data as Record<string, unknown>;
    return { readAtMs: await this.deps.store.now(), status: (status.data as { status: string }).status,
      tradeAllTokens: s["tradeAllTokens"] as boolean, abnormalTxnHandling: s["abnormalTxnHandling"] as string,
      dailyLimit: s["dailyLimit"] as number, quotaUsed: s["quotaUsed"] as number, x402DailyLimit: s["x402DailyLimit"] as number, x402QuotaUsed: s["x402QuotaUsed"] as number,
      signInMaxTimeMs: typeof s["signInMaxTime"] === "string" && Number.isSafeInteger(Date.parse(s["signInMaxTime"])) ? Date.parse(s["signInMaxTime"]) : null,
      usdtWei: (await this.deps.chain.balance(row.walletAddress, USDT_56)).toString(), bnbWei: (await this.deps.chain.balance(row.walletAddress, null)).toString() };
  }
  async finalize(row: AgenticWallet): Promise<AgenticWallet> {
    // The 10 s balance refresh writes the row, so every finalize starts from the stored version (a caller's copy may be one refresh old).
    row = await this.deps.store.getWallet(row.pairingId) ?? row;
    if (!["verified", "paired"].includes(row.state) || row.codeMatchedAt === null || row.continuationDeadline === null || await this.deps.store.now() >= row.continuationDeadline) throw new Error("pairing_not_ready");
    const now = await this.deps.store.now();
    if (row.state === "paired" && row.factsRead !== null && now - row.factsRead.readAtMs < 60_000) {
      // Binance reads stay cached for a minute; the two chain balances refresh every 10 s so a deposit shows up while the owner waits.
      if (now - (row.factsRead.balancesAtMs ?? row.factsRead.readAtMs) < 10_000 || row.walletAddress === null) return row;
      const usdtWei = (await this.deps.chain.balance(row.walletAddress, USDT_56)).toString(), bnbWei = (await this.deps.chain.balance(row.walletAddress, null)).toString();
      return await this.deps.store.patchWallet(row, { factsRead: { ...row.factsRead, usdtWei, bnbWei, balancesAtMs: await this.deps.store.now() } }) ?? row;
    }
    const updated = await this.deps.store.patchWallet(row, { state: "paired", factsRead: await this.facts(row) });
    if (updated === null) throw new Error("pairing_conflict");
    return updated;
  }
  async cleanup(row: AgenticWallet, reason: string): Promise<void> {
    if (row.state !== "cleaning") {
      const next = await this.deps.store.patchWallet(row, { state: "cleaning", cleanupReason: reason });
      if (next === null) return;
      row = next;
    }
    let fence: AgenticFence | null = null;
    if (row.hireOpId !== null) { fence = await acquireAgenticFence(this.deps.store, row.walletAddress!, this.deps.instance.row.instanceId); if (fence === null) return; }
    try {
      if (row.sessionCiphertext !== null) {
        try { if (fence === null || await this.deps.store.renewFence(fence) !== null) await this.deps.runner.run(["auth", "signout"], decryptAgenticSession(row, this.deps.masterKey)); }
        catch { /* The credential is deleted after the first attempt. */ }
      }
      await this.deps.store.patchWallet(row, { sessionCiphertext: null, state: reason.includes("expired") ? "expired" : "failed", failure: row.failure !== null && AGENTIC_HIRE_REASONS.includes(row.failure) ? row.failure : row.cleanupReason ?? reason });
    } finally { if (fence !== null) await this.deps.store.releaseFence(fence); }
  }
  async hire(row: AgenticWallet, body: unknown): Promise<AgenticWallet> {
    const params = parseAgenticHireParams(body);
    if (params === null || params.pairingId !== row.pairingId) throw new Error("agentic_hire_invalid");
    const identity = agenticHireIdentity(params);
    if (row.state === "hiring" || row.state === "bound") {
      if (row.hireOpId !== identity.hireOpId) throw new Error("agentic_hire_conflict");
    } else {
      if (!this.deps.ready() || row.walletAddress === null || await this.admission(row.walletAddress) !== "") throw new Error("agentic_admission_refused");
      if (isTradeScheduleSettings(params.settings) && row.state === "paired" && row.factsRead !== null) await this.schedulePrecheck(row, params);
      if (isTradePortfolioSettings(params.settings) && row.state === "paired" && row.factsRead !== null) await this.portfolioPrecheck(params);
      if (isTradeDcaSettings(params.settings) && row.state === "paired" && row.factsRead !== null) await this.dcaChecks(params.settings.dcaToken!);
      const accepted = await this.deps.store.acceptHire(row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: params.termEndAction });
      if (accepted === null) throw new Error("agentic_hire_conflict");
      row = accepted;
    }
    try { return await this.resumeHire(row); }
    catch (error) {
      const current = await this.deps.store.getWallet(row.pairingId);
      if (current?.state === "cleaning") await this.cleanup(current, current.cleanupReason ?? "gate-failed");
      throw error;
    }
  }
  /** Read-only, unfenced and before any write: a refused Schedule hire leaves the pairing `paired` so the owner can retry without re-pairing. */
  async schedulePrecheck(row: AgenticWallet, p: AgenticHireParams): Promise<void> {
    const s = p.settings, W = row.walletAddress!, token = s.scheduleToken!.toLowerCase(), minEntry = BigInt(s.minEntryWei!);
    const gate = agenticGate(agenticGateInput(p, row.factsRead!, W, await this.deps.store.now()));
    if (gate.rows.some(r => r.code === "schedule-first-buy" && r.state === "FAIL")) throw new Error("schedule-first-buy-past");
    if (gate.rows.some(r => r.code === "schedule-end-date" && r.state === "FAIL")) throw new Error("schedule-end-past");
    if (this.pin === null || this.schedulable === null) return;
    const has = (list: readonly Address[]): boolean => list.some(address => address.toLowerCase() === token);
    let pinned: readonly Address[];
    try { pinned = await this.pin(W, minEntry, s.slippageBps, "schedule"); } catch { throw new Error("pin-error"); }
    if (!has(pinned)) throw new Error(this.scheduleCapability?.(token as Address, minEntry) === "unknown" ? "schedule-capability-incomplete" : "schedule-token-not-granted");
    let eligible: boolean;
    try { eligible = (await this.deps.chain.metadata(token as Address)).decimals === 18 && await this.deps.chain.multiplier(token as Address) >= 10n ** 18n; }
    catch { throw new Error("schedule-capability-incomplete"); }
    if (!eligible) throw new Error("schedule-token-not-granted");
    let quotable: readonly Address[];
    try { quotable = await this.schedulable(BigInt(s.entryWei), s.slippageBps); } catch { throw new Error("pin-error"); }
    if (!has(quotable)) throw new Error("schedule-token-unquotable");
  }
  /** Read-only, unfenced and before any write, like the Schedule one: a refused portfolio hire leaves the pairing `paired`. The per-stock buy quote at the initial leg is the quote check of the hire. */
  async portfolioPrecheck(p: AgenticHireParams): Promise<void> {
    const s = p.settings, tokens = s.portfolioTokens!;
    if (this.portfolioBuyQuote === null) throw new Error("portfolio-disabled");
    for (const token of tokens) {
      let eligible: boolean;
      try { eligible = (await this.deps.chain.metadata(token as Address)).decimals === 18 && await this.deps.chain.multiplier(token as Address) >= 10n ** 18n; }
      catch { throw new Error("portfolio-capability-incomplete"); }
      if (!eligible) throw new Error("portfolio-token-unsupported");
    }
    for (const [index, token] of tokens.entries()) {
      try { await this.portfolioBuyQuote(token as Address, BigInt(s.capitalQuoteWei!) * BigInt(s.portfolioWeightsBps![index]!) / 10_000n, s.slippageBps); }
      catch { throw new Error("portfolio-token-unquotable"); }
    }
  }
  /** AGENTIC-DCA-SPEC 3.12: the stock decimals and multiplier and the pinned pool identity, read on the chain pair. Read-only: nothing is written, so a refused hire leaves the pairing paired.
   *  renew is the fence renewal the gated stage runs before each read (Schedule LOW-2 shape); the pre-check has no fence. */
  async dcaChecks(dcaToken: string, renew: () => Promise<void> = async () => undefined): Promise<void> {
    if (this.deps.dcaEnabled !== true) throw new Error("dca-disabled");
    const token = agenticAddress(dcaToken), pool = dcaPoolForToken(token);
    if (pool === null) throw new Error("dca-token-unsupported");
    let eligible: boolean;
    try { await renew(); const decimals = (await this.deps.chain.metadata(token)).decimals; await renew(); eligible = decimals === 18 && await this.deps.chain.multiplier(token) >= 10n ** 18n; }
    catch (error) { if (error instanceof Error && error.message === "agentic_wallet_busy") throw error; throw new Error("dca-capability-incomplete"); }
    if (!eligible) throw new Error("dca-token-unsupported");
    let state: Awaited<ReturnType<NonNullable<AgenticChain["poolState"]>>>;
    try {
      await renew();
      if (this.deps.chain.poolState === undefined) throw new Error("no-pool-reader");
      state = await this.deps.chain.poolState(pool.pool);
    } catch (error) { if (error instanceof Error && error.message === "agentic_wallet_busy") throw error; throw new Error("dca-capability-incomplete"); }
    const legs = dcaPoolLegs(pool);
    if (state.token0.toLowerCase() !== legs.token0.toLowerCase() || state.token1.toLowerCase() !== legs.token1.toLowerCase()
      || state.fee !== pool.fee || state.tickSpacing !== pool.tickSpacing) throw new Error("dca-pool-mismatch");
  }
  async resumeHire(row: AgenticWallet): Promise<AgenticWallet> {
    if (row.state === "bound") return row;
    if (row.state !== "hiring" || row.hireParams === null || row.walletAddress === null || row.agentId === null || row.acceptedAt === null) throw new Error("agentic_hire_invalid");
    const { store, runner, masterKey, chain, agents, settings, cmc } = this.deps;
    const p = row.hireParams, s = p.settings, W = row.walletAddress, schedule = isTradeScheduleSettings(s), portfolio = isTradePortfolioSettings(s), dca = isTradeDcaSettings(s);
    const fence = await acquireAgenticFence(store, W, this.deps.instance.row.instanceId);
    if (fence === null) throw new Error("agentic_wallet_busy");
    try {
      const current = await store.getWallet(row.pairingId);
      if (current === null || current.hireOpId !== row.hireOpId || current.acceptedAt === null || !["hiring", "bound"].includes(current.state)) throw new Error("agentic_hire_conflict");
      if (current.state === "bound") return current;
      row = current;
      const acceptedAt = current.acceptedAt;
      if (row.hireFacts === null) {
        let facts: AgenticFactsRead | null = null;
        let reason = "settings-unreadable";
        try {
          facts = await this.facts(row, fence);
          for (const [command, status] of [["market-order", "PENDING"], ["limit-order", "PENDING"], ["limit-order", "WORKING"], ["limit-order", "TRIGGERED"]]) {
            if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            const result = await runner.run([command!, "list", "--binanceChainId", "56", "--status", status!, "--page", "1", "--pageSize", "100"], decryptAgenticSession(row, masterKey));
            if (result.kind !== "ok" || (result.data as { total: number }).total !== 0) throw new Error(command === "market-order" ? "wallet_has_pending_orders" : "wallet_has_limit_orders");
          }
          const gate = agenticGate(agenticGateInput(p, facts, W, acceptedAt));
          reason = gate.rows.some(r => r.code === "sizing" && r.state === "FAIL") ? "sizing" : "gate-rows";
          if (gate.rows.some(r => r.state === "FAIL")) throw new Error("gate-failed");
          // A portfolio grants exactly its signed stocks: no pin is read and the pin-unavailable guard does not apply to it.
          if (portfolio) { reason = "portfolio-disabled"; if (this.portfolioBuyQuote === null) throw new Error("gate-failed"); }
          else if (dca) {
            // A DCA hire grants exactly its signed stock: no pin is read. The pool, the stock and one buy quote are checked again here, each read after a fence renewal.
            const renew = async (): Promise<void> => { if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy"); };
            reason = "dca-disabled"; if (this.deps.dcaEnabled !== true) throw new Error("gate-failed");
            try { await this.dcaChecks(s.dcaToken!, renew); }
            catch (error) { const name = error instanceof Error ? error.message : ""; if (name === "agentic_wallet_busy") throw error; reason = name; throw new Error("gate-failed"); }
            reason = "dca-token-unquotable"; await renew();
            const quote = await runner.run(["market-order", "quote", "--fromToken", agenticAddress(USDT_56), "--toToken", agenticAddress(s.dcaToken!),
              "--fromTokenQty", agenticUiString(BigInt(s.entryWei)), "--binanceChainId", "56"], decryptAgenticSession(row, masterKey));
            const out = quote.kind === "ok" && typeof quote.data === "object" && quote.data !== null ? agenticDecimal((quote.data as Record<string, unknown>)["toCoinAmount"]) : null;
            if (out === null || out <= 0n) throw new Error("gate-failed");
          }
          else { reason = "pin-unavailable"; if (this.pin === null || schedule && this.schedulable === null) throw new Error("gate-failed"); }
          const pinned: Address[] = [];
          reason = "pin-error";
          const chosen = schedule ? s.scheduleToken!.toLowerCase() : "";
          // AGENTIC-RFQ-STOCKS E4: an AI hire with the flag on takes the RFQ pin variant; every other hire runs today's line.
          const rfq: AgenticRfqPin | null = !schedule && !portfolio && !dca && this.rfqPin !== null ? await this.rfqPin() : null;
          let candidates: readonly Address[] = portfolio ? s.portfolioTokens!.map(token => agenticAddress(token)) : dca ? [agenticAddress(s.dcaToken!)] : rfq !== null ? [...rfq.pooled, ...rfq.rfqOnly] : await this.pin!(W, BigInt(s.minEntryWei!), s.slippageBps, schedule ? "schedule" : "ai");
          if (schedule) {
            // The grant is the chosen stock first, then the pin order, cut at the grant ceiling; the lease is renewed after each slow read.
            if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            if (!candidates.some(address => address.toLowerCase() === chosen)) {
              reason = this.scheduleCapability?.(chosen as Address, BigInt(s.minEntryWei!)) === "unknown" ? "schedule-capability-incomplete" : "schedule-token-not-granted";
              throw new Error("gate-failed");
            }
            candidates = [...candidates.filter(address => address.toLowerCase() === chosen), ...candidates.filter(address => address.toLowerCase() !== chosen)].slice(0, MAX_GRANTED_TOKENS_TRADFI);
          }
          if (rfq !== null) {
            // 4.4: the same filter, four reads at a time in candidate order, the lease renewed before and after (today's AI loop never renews; 50 tokens read one by one would roughly double its time), then the ceiling.
            if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            const eligible = await mapWithConcurrency(candidates, 4, async token => { try { return (await chain.metadata(token)).decimals === 18 && await chain.multiplier(token) >= 10n ** 18n; } catch { return false; } });
            if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            for (const [index, token] of candidates.entries()) if (eligible[index] === true && pinned.length < AGENTIC_RFQ_PIN_MAX) pinned.push(agenticAddress(token));
          } else for (const token of candidates) {
            if ((schedule || portfolio || dca) && await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            try { if ((await chain.metadata(token)).decimals === 18 && await chain.multiplier(token) >= 10n ** 18n) pinned.push(agenticAddress(token)); } catch { /* Unsupported or unreadable tokens are excluded. */ }
          }
          if (schedule) {
            // In the cut list but unreadable or filtered: retryable, never the terminal "not granted".
            if (!pinned.includes(agenticAddress(chosen))) { reason = "schedule-capability-incomplete"; throw new Error("gate-failed"); }
            const quotable = await this.schedulable!(BigInt(s.entryWei), s.slippageBps);
            if (await store.renewFence(fence) === null) throw new Error("agentic_wallet_busy");
            if (!quotable.some(address => address.toLowerCase() === chosen)) { reason = "schedule-token-unquotable"; throw new Error("gate-failed"); }
          }
          if (portfolio && pinned.length !== s.portfolioTokens!.length) { reason = "portfolio-capability-incomplete"; throw new Error("gate-failed"); }
          if (dca && pinned.length !== 1) { reason = "dca-capability-incomplete"; throw new Error("gate-failed"); }
          reason = "pinned-empty";
          if (pinned.length === 0) throw new Error("gate-failed");
          // A DCA hire has no sizing call: its capital is base + N x order by the parser rule (AGENTIC-DCA-SPEC 3.12).
          const sizing: { ok: boolean } = dca ? { ok: true } : portfolio
            ? checkTradfiPortfolioSizing({ capDayWei: MAX_UINT256, capitalQuoteWei: BigInt(s.capitalQuoteWei!), tokenCount: pinned.length, intervalSec: s.portfolioIntervalSec as 14400 | 28800 | 43200 | 86400 })
            : schedule
            ? checkTradfiScheduleSizing({ capDayWei: MAX_UINT256, entryWei: BigInt(s.entryWei), capitalQuoteWei: BigInt(s.capitalQuoteWei!), platformFeeBps: 0, grantedTokenCount: pinned.length,
              intervalSec: s.scheduleIntervalSec!, ttlSec: Math.floor((gate.hireEndMs - acceptedAt) / 1_000), endKind: s.scheduleEndKind!, endRuns: s.scheduleEndRuns!, endAtSec: s.scheduleEndAtSec!,
              anchorAtSec: s.scheduleFirstAtSec ?? Math.floor(acceptedAt / 1_000) })
            : checkTradfiV2Sizing({ minEntryWei: BigInt(s.minEntryWei!), maxEntryWei: BigInt(s.entryWei), capitalQuoteWei: BigInt(s.capitalQuoteWei!),
              maxOpenPositions: s.maxOpenPositions, platformFeeBps: 0, grantedTokenCount: rfq !== null ? 1 : pinned.length, capDayWei: tradfiV2NativeReserveWei(s.maxOpenPositions, rfq !== null ? 1 : pinned.length) });
          reason = "sizing";
          if (!sizing.ok) throw new Error("gate-failed");
          const next = await store.patchWallet(row, { hireStage: "gated", factsRead: facts, hireEndMs: gate.hireEndMs, entryCutoffMs: gate.entryCutoffMs,
            hireFacts: { acceptedAtMs: acceptedAt, acceptedDedicatedWalletAtMs: acceptedAt, termSec: p.term * 86_400, termEndAction: p.termEndAction,
              hireEndMs: gate.hireEndMs, entryCutoffMs: gate.entryCutoffMs, signInMaxTimeMs: facts.signInMaxTimeMs!, pinned,
              quoteDayCapWei: agenticQuoteDayCapWei(s).toString(), budgetWei: agenticHireBudgetWei(s, p.term).toString(),
              hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: s.capitalQuoteWei!,
                entryWei: s.entryWei, minEntryWei: s.minEntryWei!, quotePerTradeWei: s.entryWei, cmcNewsEnabled: agenticHasCmc(s),
                ...(agenticHasCmc(s) ? { cmcTotalBudgetWei: agenticHireBudgetWei(s, p.term).toString() } : {}) },
              ...(rfq === null ? {} : { rfq: agenticRfqFacts(rfq, pinned) }) } });
          if (next === null) throw new Error("agentic_hire_conflict");
          row = next;
        } catch (error) {
          const code = error instanceof Error && ["wallet_has_pending_orders", "wallet_has_limit_orders", "AGENTIC_SETTINGS_UNREADABLE", "agentic_wallet_busy"].includes(error.message) ? error.message : "gate-failed";
          reason = ({ wallet_has_pending_orders: "pending-orders", wallet_has_limit_orders: "limit-orders", AGENTIC_SETTINGS_UNREADABLE: "settings-unreadable", agentic_wallet_busy: "wallet-busy" } as Readonly<Record<string, string>>)[code] ?? reason;
          const cleaning = await store.patchWallet(row, { state: "cleaning", cleanupReason: "gate-failed", failure: reason, ...(facts === null ? {} : { factsRead: facts }) });
          if (cleaning !== null) row = cleaning;
          throw new Error(code);
        }
      }
      try { await agents.createAgent({ id: row.agentId!, ownerAddress: W, walletAddress: W, custodyModel: "binance-agentic", status: "armed", httpRuntimeProfile: "unbound-v1" }); }
      catch (error) {
        const existing = await agents.getAgentById(row.agentId!);
        if (!(error instanceof AgentExistsError) || existing?.ownerAddress.toLowerCase() !== W || existing.walletAddress.toLowerCase() !== W || existing.custodyModel !== "binance-agentic") throw new Error("agentic_hire_conflict");
      }
      const staged = await store.patchWallet(row, { hireStage: "agent-created" }); if (staged === null) throw new Error("agentic_hire_conflict"); row = staged;
      if ((await settings.putInitialIfAbsentOrSameDigest({ ownerAddress: W, agentId: row.agentId!, params: s, digest: tradeSettingsDigest(s) })).kind === "conflict") throw new Error("agentic_hire_conflict");
      const stored = await store.patchWallet(row, { hireStage: "settings-stored" }); if (stored === null) throw new Error("agentic_hire_conflict"); row = stored;
      if (agenticHasCmc(s)) {
        const budget = await cmc.putInitial({ agentId: row.agentId!, ownerAddress: W, wallet: W, totalWei: agenticHireBudgetWei(s, p.term) });
        if (await cmc.setSetup({ agentId: row.agentId!, ownerAddress: W, wallet: W, generation: budget.generation,
          sessionPublicKey: projectAgenticSessionFacts(row).publicKey, sessionExpiry: Math.floor(row.hireEndMs! / 1_000), allowanceWei: agenticHireBudgetWei(s, p.term) }) === null) throw new Error("agentic_cmc_setup_failed");
        if (await cmc.setCapability({ agentId: row.agentId!, ownerAddress: W, generation: budget.generation, available: true }) === null) throw new Error("agentic_cmc_setup_failed");
      }
      const initialized = await store.patchWallet(row, { hireStage: "cmc-initialized" }); if (initialized === null) throw new Error("agentic_hire_conflict"); row = initialized;
      const active = await store.patchWallet(row, { state: "bound", hireStage: "active" }); if (active === null) throw new Error("agentic_hire_conflict");
      return active;
    } finally { await store.releaseFence(fence); }
  }
  async sweep(): Promise<void> {
    const now = await this.deps.store.now();
    for (const row of await this.deps.store.wallets()) {
      try {
        if (row.state === "waiting" && (row.qr === null && now - row.createdAt > 60_000 || row.qr !== null && now >= row.qr.expireAtMs + 15_000)) {
          const waiting = this.#waiting.get(row.pairingId); waiting?.cancel(); await waiting?.task;
          const current = await this.deps.store.getWallet(row.pairingId);
          if (current?.state === "waiting") await this.deps.store.patchWallet(current, { state: "expired", failure: "pairing_expired" });
        } else if (row.state === "verified" && row.codeMatchedAt === null && now >= row.verifiedAt! + 120_000
          || ["verified", "paired"].includes(row.state) && now >= row.continuationDeadline!) await this.cleanup(row, "pairing_expired");
        else if (row.state === "cleaning") await this.cleanup(row, row.cleanupReason ?? "pairing_failed");
        else if (row.state === "hiring" && now - row.updatedAt > 60_000) {
          if (row.hireStage === "failed") await this.cleanup(row, "hire-failed");
          else await this.resumeHire(row);
        }
        else if (row.state === "ending") await this.deps.resumeEnding(row);
        else if (row.state === "ended" && row.agentId !== null) {
          const agent = await this.deps.agents.getAgentById(row.agentId);
          if (agent?.status === "armed") await this.deps.agents.transitionAgentStatus({ ownerAddress: agent.ownerAddress, agentId: agent.id, expectedStatus: "armed", expectedRowVersion: agent.rowVersion, status: "revoked" });
        }
        else if (row.state === "bound" && row.hireStage === "active" && row.agentId !== null && row.walletAddress !== null && row.hireParams !== null) {
          const category = categoryForAgenticHire(row.hireParams.settings);
          if (category !== null) await this.deps.agents.enrollAgenticIdentity({ ownerAddress: row.walletAddress, agentId: row.agentId, category });
        }
      } catch {
        const current = await this.deps.store.getWallet(row.pairingId);
        if (current?.state === "cleaning") await this.cleanup(current, current.cleanupReason ?? "gate-failed");
        console.error("agentic_pairing_resume_failed", row.state);
      }
    }
  }
}

export function registerAgenticRoutes(app: Hono, pairing: AgenticPairings,
  pin: (W: Address, min: bigint, slippage: number, mode?: "ai" | "schedule") => Promise<readonly Address[]>,
  schedulable?: (amountWei: bigint, slippageBps: number) => Promise<readonly Address[]>,
  scheduleCapability?: (token: Address, minEntryAtomic: bigint) => string | null,
  portfolioBuyQuote?: (token: Address, amountInAtomic: bigint, slippageBps: number) => Promise<void>,
  rfqPin?: () => Promise<AgenticRfqPin>): void {
  pairing.pin = pin;
  pairing.rfqPin = rfqPin ?? null;
  pairing.schedulable = schedulable ?? null;
  pairing.scheduleCapability = scheduleCapability ?? null;
  pairing.portfolioBuyQuote = portfolioBuyQuote ?? null;
  app.use("/agentic/*", async (c, next) => {
    if (c.req.method === "POST" && (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json" || !pairing.deps.origins.includes(c.req.header("origin") ?? ""))) return c.json({ data: null, error: { code: "forbidden" } }, 403);
    return next();
  });
  const view = (row: AgenticWallet) => ({ state: row.state, walletAddress: row.walletAddress, codeAttemptsLeft: Math.max(0, 5 - row.codeAttempts),
    facts: row.factsRead, continuationDeadlineMs: row.continuationDeadline, failure: row.failure });
  app.all("/agentic/*", async (c) => {
    try {
      const path = c.req.path;
      if (c.req.method === "GET" && /^\/agentic\/wallets\/[^/]+$/.test(path)) return c.json({ data: await pairing.deps.publicView(agenticAddress(path.split("/").at(-1)!)) });
      let body: unknown = null;
      if (c.req.method === "POST") body = await c.req.json<unknown>();
      if (path === "/agentic/pairings" && c.req.method === "POST") {
        if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return c.json({ data: null, error: { code: "invalid_body" } }, 400);
        return c.json({ data: await pairing.track(pairing.create()) }, 201);
      }
      const id = path === "/agentic/hire" && typeof body === "object" && body !== null ? (body as Record<string, unknown>)["pairingId"] : path.split("/")[3];
      if (typeof id !== "string") return c.json({ data: null, error: { code: "not_found" } }, 404);
      const header = c.req.header("x-agentic-pairing");
      if (header === undefined) return c.json({ data: null, error: { code: "unauthorized" } }, 401);
      const [headerId, secret, extra] = header.split(".");
      const row = await pairing.deps.store.getWallet(id);
      if (row === null || headerId !== id || secret === undefined || extra !== undefined || !timingSafeEqual(Buffer.from(digest(secret), "hex"), Buffer.from(row.pairingSecretHash, "hex"))) return c.json({ data: null, error: { code: "not_found" } }, 404);
      if (path === "/agentic/hire" && c.req.method === "POST") {
        const hired = await pairing.track(pairing.hire(row, body));
        return c.json({ data: { walletAddress: hired.walletAddress, hireEndMs: hired.hireEndMs, entryCutoffMs: hired.entryCutoffMs, state: hired.state } });
      }
      if (path === `/agentic/pairings/${id}` && c.req.method === "GET") return c.json({ data: view(row) });
      if (path === `/agentic/pairings/${id}/code` && c.req.method === "POST" && typeof body === "object" && body !== null && Object.keys(body).length === 1 && typeof (body as Record<string, unknown>)["code"] === "string") {
        await pairing.track(pairing.code(row, (body as { code: string }).code)); return c.json({ data: view((await pairing.deps.store.getWallet(id))!) });
      }
      if (path === `/agentic/pairings/${id}/finalize` && c.req.method === "POST" && typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0) return c.json({ data: view(await pairing.track(pairing.finalize(row))) });
      return c.json({ data: null, error: { code: "not_found" } }, 404);
    } catch (error) {
      const allowed = new Set(["agentic_not_ready", "pairing_slots_full", "pairing_signin_failed", "pairing_conflict", "pairing_code_attempts", "pairing_code_expired", "pairing_code_invalid", "pairing_code_mismatch", "pairing_not_ready", "agentic_hire_invalid", "agentic_hire_conflict", "agentic_admission_refused", "gate-failed", "agentic_wallet_busy", "AGENTIC_SETTINGS_UNREADABLE", "agentic_cmc_setup_failed", "wallet_has_pending_orders", "wallet_has_limit_orders",
        "schedule-token-not-granted", "schedule-token-unquotable", "schedule-capability-incomplete", "schedule-first-buy-past", "schedule-end-past", "pin-error",
        "portfolio-disabled", "portfolio-token-unsupported", "portfolio-token-unquotable", "portfolio-capability-incomplete",
        "dca-disabled", "dca-token-unsupported", "dca-capability-incomplete", "dca-pool-mismatch", "dca-token-unquotable"]);
      const code = error instanceof Error && allowed.has(error.message) ? error.message : "agentic_unavailable";
      if (c.req.path === "/agentic/hire") {
        const body = await c.req.json<unknown>();
        const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["pairingId"] : null;
        // Read-only: the hire stage persists its own closed failure. Writing here could race an
        // in-flight hire of the same pairing (a second click answers wallet-busy) and break its CAS.
        const row = typeof id === "string" ? await pairing.deps.store.getWallet(id) : null;
        // A lost lease whose winner already bound this exact hire is a success, not a refusal.
        const requested = parseAgenticHireParams(body);
        if (row?.state === "bound" && requested !== null && row.hireOpId === agenticHireIdentity(requested).hireOpId) {
          return c.json({ data: { walletAddress: row.walletAddress, hireEndMs: row.hireEndMs, entryCutoffMs: row.entryCutoffMs, state: row.state } });
        }
        const reason = row?.failure != null && AGENTIC_HIRE_REASONS.includes(row.failure) ? row.failure
          : ({ wallet_has_pending_orders: "pending-orders", wallet_has_limit_orders: "limit-orders", AGENTIC_SETTINGS_UNREADABLE: "settings-unreadable", agentic_wallet_busy: "wallet-busy", agentic_admission_refused: "wallet-busy",
            "schedule-token-not-granted": "schedule-token-not-granted", "schedule-token-unquotable": "schedule-token-unquotable", "schedule-capability-incomplete": "schedule-capability-incomplete",
            "schedule-first-buy-past": "schedule-first-buy-past", "schedule-end-past": "schedule-end-past", "pin-error": "pin-error",
            "portfolio-disabled": "portfolio-disabled", "portfolio-token-unsupported": "portfolio-token-unsupported", "portfolio-token-unquotable": "portfolio-token-unquotable",
            "portfolio-capability-incomplete": "portfolio-capability-incomplete",
            "dca-disabled": "dca-disabled", "dca-token-unsupported": "dca-token-unsupported", "dca-capability-incomplete": "dca-capability-incomplete",
            "dca-pool-mismatch": "dca-pool-mismatch", "dca-token-unquotable": "dca-token-unquotable" } as Readonly<Record<string, string>>)[code] ?? null;
        console.error("agentic_hire_refused", reason ?? code);
        const params = row?.hireParams ?? parseAgenticHireParams(body);
        if (row?.factsRead != null && params !== null) {
          const gate = agenticGate(agenticGateInput(params, row.factsRead, row.walletAddress!, row.acceptedAt ?? await pairing.deps.store.now()));
          return c.json({ data: null, error: { code }, meta: { reason, gate: gate.rows } }, 409);
        }
        return c.json({ data: null, error: { code }, meta: { reason, gate: [] } }, 409);
      }
      return c.json({ data: null, error: { code } }, 409);
    }
  });
}
