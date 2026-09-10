import { keccak256 } from "viem";
import type { IdentityConfig } from "./config.js";
import { CURRENT_METADATA_VERSION, metadataUriFor, metadataTemplate } from "./metadata.js";
import { phaseCalldata, registeredId, type RegistryGateway } from "./registry.js";
import { dailyLiability, type IdentityLedger } from "../store/erc8004.js";
import { errorCode, fail, validIdentity, type Erc8004IdentitySummary, type IdentityErrorCode, type IdentityFence, type IdentityJob, type IdentityPhase, type IdentitySources, type IdentitySource, type IdentityTransaction, type LedgerState, type UnsignedIntent } from "./types.js";

const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
function replaceJob(state: LedgerState, job: IdentityJob): void { const index = state.jobs.findIndex((item) => item.publicRef === job.publicRef); if (index < 0) fail("not_found"); state.jobs[index] = job; }
function newJob(source: IdentitySource, config: IdentityConfig, now: number, displayNumber: number): IdentityJob {
  const identity = source.identity;
  if (!validIdentity(identity) || identity.status !== "pending" || source.existingId !== null) fail("invalid_identity");
  return { publicRef: identity.publicRef, sourceId: source.id, owner: source.owner, category: identity.category, displayNumber, metadataVersion: CURRENT_METADATA_VERSION,
    chainId: 56, registry: config.registry, minter: config.minter, createdAt: now, initialUri: metadataUriFor(CURRENT_METADATA_VERSION, identity.category, displayNumber, identity.publicRef), finalUri: null,
    status: "pending", mintedId: null, registrationHash: null, updateHash: null, envelope: null, effectiveCeiling: null,
    updateGasCeiling: null, updatePriceCeiling: null, completedAt: null, error: null };
}
function bindingMatches(job: IdentityJob, config: Pick<IdentityConfig, "chainId" | "registry" | "minter">): boolean { return job.chainId === config.chainId && job.registry.toLowerCase() === config.registry.toLowerCase() && job.minter.toLowerCase() === config.minter.toLowerCase(); }
function assertIntent(job: IdentityJob, tx: IdentityTransaction, config: Pick<IdentityConfig, "chainId" | "registry" | "minter" | "maxGas" | "maxPrice">, enforceCurrentLimits = true): void {
  const intent = tx.intent;
  if (!bindingMatches(job, config) || intent.chainId !== 56 || intent.minter.toLowerCase() !== job.minter.toLowerCase() || intent.to.toLowerCase() !== job.registry.toLowerCase()
    || intent.type !== "legacy" || intent.value !== "0" || intent.data !== phaseCalldata(job, tx.phase)
    || tx.jobRef !== job.publicRef || (tx.phase === "register" ? job.registrationHash : job.updateHash) !== tx.hash
    || enforceCurrentLimits && (BigInt(intent.gas) > config.maxGas || BigInt(intent.gasPrice) > config.maxPrice)
    || job.envelope === null || BigInt(intent.gas) * BigInt(intent.gasPrice) > BigInt(job.envelope)) fail("intent_mismatch");
  if (tx.phase === "update" && (BigInt(intent.gas) > BigInt(job.updateGasCeiling!) || BigInt(intent.gasPrice) > BigInt(job.updatePriceCeiling!))) fail("intent_mismatch");
}
export type IdentityStep = { readonly status: "pending" | "registering" | "updating" | "registered" | "blocked" | "idle"; readonly errorCode?: IdentityErrorCode };
export class IdentityService {
  constructor(readonly config: IdentityConfig, readonly ledger: IdentityLedger, readonly sources: IdentitySources, readonly gateway: RegistryGateway, readonly fence: IdentityFence, readonly now: () => number = Date.now) {}
  async discover(id?: string): Promise<void> {
    this.fence.check();
    let cursor = "";
    do {
    const sources = id === undefined ? await this.sources.enrolled(cursor) : [await this.sources.get(id)]; this.fence.check();
    await this.ledger.atomic(this.fence, (state) => {
      for (const source of sources) {
        if (source === null) { if (id !== undefined) fail("not_found"); continue; }
        if (!validIdentity(source.identity)) { if (id !== undefined) fail(source.identity === null ? "not_enrolled" : "invalid_identity"); continue; }
        const identity = source.identity;
        const old = state.jobs.find((job) => job.publicRef === identity.publicRef);
        if (old) { if (old.sourceId !== source.id || old.owner.toLowerCase() !== source.owner.toLowerCase() || old.category !== identity.category) fail("conflict"); continue; }
        const displayNumber = state.jobs.filter((job) => job.owner.toLowerCase() === source.owner.toLowerCase() && job.category === identity.category)
          .reduce((max, job) => Math.max(max, job.displayNumber ?? 0), 0) + 1;
        state.jobs.push(newJob(source, this.config, this.now(), displayNumber));
      }
    });
    const persisted = await this.ledger.read(); this.fence.check();
    for (const source of sources) {
      if (!source || !validIdentity(source.identity)) continue;
      const ref = source.identity.publicRef;
      const completed = persisted.jobs.find((job) => job.publicRef === ref && job.completedAt !== null);
      if (completed) {
        try { await this.#project(completed); } catch (error) { if (errorCode(error) === "lock_lost") throw error; }
      }
    }
    if (id !== undefined || sources.length < 100) break;
    const next = sources.at(-1)?.id; if (next === undefined || next === cursor) fail("conflict"); cursor = next;
    } while (true);
  }
  async #project(job: IdentityJob): Promise<void> {
    const source = await this.sources.get(job.sourceId); this.fence.check();
    if (source === null || source.owner.toLowerCase() !== job.owner.toLowerCase() || !validIdentity(source.identity) || source.identity.publicRef !== job.publicRef) fail("conflict");
    if (source.existingId !== null && source.existingId !== job.mintedId) fail("conflict");
    const next: Erc8004IdentitySummary = { version: 1, publicRef: job.publicRef, revision: source.identity.revision + 1, category: job.category, status: job.status,
      agentId: job.mintedId, registrationTxHash: job.registrationHash, uriUpdateTxHash: job.updateHash, errorCode: job.error };
    const current = source.identity;
    if ((job.status !== "registered" || source.existingId === job.mintedId)
      && Object.entries(next).every(([key, value]) => key === "revision" || current[key as keyof Erc8004IdentitySummary] === value)) return;
    this.fence.check(); if (!await this.sources.project(source, next, this.fence)) fail("conflict");
  }
  async #block(job: IdentityJob, code: IdentityErrorCode): Promise<IdentityStep> {
    const blocked = await this.ledger.atomic(this.fence, (state) => {
      const old = state.jobs.find((item) => item.publicRef === job.publicRef); if (!old) fail("not_found");
      // Finalized evidence is retained even when its source projection cannot be repaired.
      const next: IdentityJob = old.completedAt === null ? { ...old, status: "blocked", error: code } : old;
      replaceJob(state, next); return next;
    });
    try { await this.#project(blocked); } catch (error) { if (errorCode(error) === "lock_lost") throw error; }
    return { status: "blocked", errorCode: code };
  }
  async #prepare(job: IdentityJob, ceiling?: bigint): Promise<void> {
    const phase: IdentityPhase = job.registrationHash === null ? "register" : "update";
    if (phase === "update" && (job.mintedId === null || job.updateHash !== null)) fail("intent_mismatch");
    if (!this.config.exclusive) fail("exclusive_required");
    const data = phaseCalldata(job, phase);
    await this.gateway.simulate(data); this.fence.check();
    const quote = await this.gateway.fees(data); this.fence.check();
    const nonce = await this.gateway.nonces(); this.fence.check();
    const gas = (quote.estimate * 120n + 99n) / 100n;
    if (gas <= 0n || quote.gasPrice <= 0n || gas > this.config.maxGas || quote.gasPrice > this.config.maxPrice) fail("fee_limit");
    const cost = gas * quote.gasPrice;
    const raw = await this.ledger.atomic(this.fence, async (state) => {
      const current = state.jobs.find((item) => item.publicRef === job.publicRef); if (!current || !bindingMatches(current, this.config)) fail("intent_mismatch");
      if (state.transactions.some((tx) => tx.finalizedAt === null)) fail("other_job_pending");
      if (state.transactions.some((tx) => tx.jobRef === job.publicRef && tx.phase === phase)) fail("conflict");
      if (nonce.latest !== nonce.pending || state.nextNonce !== null && state.nextNonce !== nonce.latest) fail("nonce_conflict");
      const effective = min(this.config.maxInstanceFee, ceiling ?? this.config.maxInstanceFee, current.effectiveCeiling === null ? this.config.maxInstanceFee : BigInt(current.effectiveCeiling));
      const envelope = phase === "register" ? cost + this.config.maxGas * this.config.maxPrice : BigInt(current.envelope!);
      if (envelope > effective || dailyLiability(state, this.now()) + (phase === "register" ? envelope : 0n) > this.config.maxDailyFee) fail("fee_limit");
      if (quote.balance < (phase === "register" ? envelope : cost)) fail("insufficient_balance");
      if (phase === "update") {
        const first = state.transactions.find((tx) => tx.hash === current.registrationHash); if (!first || first.outcome !== "success") fail("intent_mismatch");
        if (gas > BigInt(current.updateGasCeiling!) || quote.gasPrice > BigInt(current.updatePriceCeiling!) || cost + BigInt(first.intent.gas) * BigInt(first.intent.gasPrice) > envelope) fail("fee_limit");
      }
      const intent: UnsignedIntent = { chainId: 56, minter: current.minter, to: current.registry, nonce: nonce.latest, value: "0", data, gas: gas.toString(), gasPrice: quote.gasPrice.toString(), type: "legacy" };
      this.fence.check(); const signed = await this.gateway.sign(intent); this.fence.check(); const hash = keccak256(signed);
      const transaction: IdentityTransaction = { hash, jobRef: job.publicRef, phase, intent, preparedAt: this.now(), finalizedAt: null, blockHash: null, blockNumber: null, outcome: null };
      const next: IdentityJob = { ...current, status: phase === "register" ? "registering" : "updating", error: null,
        registrationHash: phase === "register" ? hash : current.registrationHash, updateHash: phase === "update" ? hash : null,
        envelope: envelope.toString(), effectiveCeiling: effective.toString(), updateGasCeiling: current.updateGasCeiling ?? this.config.maxGas.toString(), updatePriceCeiling: current.updatePriceCeiling ?? this.config.maxPrice.toString() };
      assertIntent(next, transaction, this.config); replaceJob(state, next); state.transactions.push(transaction); state.nextNonce = nonce.latest + 1;
      return signed;
    });
    this.fence.check(); await this.gateway.broadcast(raw); this.fence.check();
  }
  async #reconcile(job: IdentityJob, tx: IdentityTransaction, allowSend: boolean): Promise<void> {
    assertIntent(job, tx, this.config, false);
    const receipt = await this.gateway.receipt(tx.hash); this.fence.check();
    if (receipt === null) {
      if (!allowSend) return;
      assertIntent(job, tx, this.config);
      const nonces = await this.gateway.nonces(); this.fence.check();
      if (nonces.latest > tx.intent.nonce || nonces.pending > tx.intent.nonce + 1) fail("nonce_conflict");
      if (!this.config.exclusive) fail("exclusive_required");
      await this.gateway.simulate(tx.intent.data); this.fence.check();
      const raw = await this.gateway.sign(tx.intent); this.fence.check();
      if (keccak256(raw) !== tx.hash) fail("intent_mismatch");
      this.fence.check(); await this.gateway.broadcast(raw); this.fence.check(); return;
    }
    if (receipt.transactionHash !== tx.hash || receipt.to?.toLowerCase() !== job.registry.toLowerCase() || receipt.from.toLowerCase() !== job.minter.toLowerCase()) fail("invalid_receipt");
    const finalized = await this.gateway.finalized(); this.fence.check();
    if (receipt.blockNumber > finalized) return;
    const blockHash = await this.gateway.blockHash(receipt.blockNumber); this.fence.check();
    if (blockHash !== receipt.blockHash) return;
    if (receipt.status !== "success") {
      const now = this.now();
      await this.ledger.atomic(this.fence, (state) => { const index = state.transactions.findIndex((item) => item.hash === tx.hash); if (index < 0) fail("intent_mismatch"); state.transactions[index] = { ...tx, finalizedAt: now, blockNumber: receipt.blockNumber.toString(), blockHash, outcome: "reverted" }; });
      fail("reverted");
    }
    const id = tx.phase === "register" ? registeredId(receipt, this.config, job.initialUri) : job.mintedId!;
    // Save the actual mint evidence even if the subsequent owner/URI read fails.
    if (tx.phase === "register" && job.mintedId === null) {
      await this.ledger.atomic(this.fence, (state) => { const old = state.jobs.find((item) => item.publicRef === job.publicRef)!; replaceJob(state, { ...old, mintedId: id, finalUri: metadataUriFor(old.metadataVersion, old.category, old.displayNumber, old.publicRef, id), status: old.status === "blocked" ? "blocked" : "updating" }); });
    }
    const identity = await this.gateway.identity(id, receipt.blockNumber); this.fence.check();
    if (identity.owner.toLowerCase() !== job.minter.toLowerCase() || identity.uri !== (tx.phase === "register" ? job.initialUri : job.finalUri)) fail("verification_failed");
    const now = this.now();
    await this.ledger.atomic(this.fence, (state) => {
      const index = state.transactions.findIndex((item) => item.hash === tx.hash); if (index < 0) fail("intent_mismatch");
      state.transactions[index] = { ...tx, finalizedAt: now, blockNumber: receipt.blockNumber.toString(), blockHash, outcome: "success" };
      const old = state.jobs.find((item) => item.publicRef === job.publicRef)!;
      replaceJob(state, { ...old, status: tx.phase === "register" ? old.status === "blocked" ? "blocked" : "updating" : "registered", error: tx.phase === "register" && old.status === "blocked" ? old.error : null, completedAt: tx.phase === "update" ? old.completedAt ?? now : null });
    });
  }
  async step(id?: string, ceiling?: bigint): Promise<IdentityStep> {
    this.fence.check();
    let state = await this.ledger.read(); this.fence.check();
    const outstanding = state.transactions.find((tx) => tx.finalizedAt === null);
    const selected = id === undefined ? null : state.jobs.find((job) => job.sourceId === id);
    if (id !== undefined && !selected) fail("not_enrolled");
    if (outstanding && id !== undefined && outstanding.jobRef !== selected?.publicRef) return { status: "blocked", errorCode: "other_job_pending" };
    let job = outstanding ? state.jobs.find((item) => item.publicRef === outstanding.jobRef) : selected ?? state.jobs.find((item) => item.status !== "registered" && item.status !== "blocked");
    if (!job) return { status: "idle" };
    if (job.status === "blocked" && !outstanding) {
      // A fee-limit refusal before preparation has no nonce, envelope, or
      // transaction evidence. It is safe to retry after the operator raises
      // the explicit daily ceiling; every signed/prepared job remains terminal.
      if (job.error === "fee_limit" && job.registrationHash === null && job.updateHash === null && job.envelope === null) {
        await this.ledger.atomic(this.fence, (current) => {
          const old = current.jobs.find((item) => item.publicRef === job!.publicRef); if (!old) fail("not_found");
          replaceJob(current, { ...old, status: "pending", error: null });
        });
        state = await this.ledger.read(); job = state.jobs.find((item) => item.publicRef === job!.publicRef)!;
      } else { await this.#project(job); return { status: "blocked", ...(job.error === null ? {} : { errorCode: job.error }) }; }
    }
    try {
      if (!bindingMatches(job, this.config)) fail("intent_mismatch");
      let maySend = job.status !== "blocked";
      let spendingBlock: IdentityErrorCode | undefined;
      if (job.envelope !== null && job.status !== "registered") {
        const effective = min(this.config.maxInstanceFee, ceiling ?? this.config.maxInstanceFee, BigInt(job.effectiveCeiling!));
        if (BigInt(job.envelope) > effective || dailyLiability(state, this.now()) > this.config.maxDailyFee) { maySend = false; spendingBlock = "fee_limit"; }
        else if (effective < BigInt(job.effectiveCeiling!)) { await this.ledger.atomic(this.fence, (current) => { const old = current.jobs.find((item) => item.publicRef === job!.publicRef)!; replaceJob(current, { ...old, effectiveCeiling: effective.toString() }); }); }
      }
      if (job.status !== "registered") {
        await this.gateway.probe(); this.fence.check();
        if (outstanding) await this.#reconcile(job, outstanding, maySend);
        else if (spendingBlock) fail(spendingBlock);
        else await this.#prepare(job, ceiling);
      }
      state = await this.ledger.read(); this.fence.check(); job = state.jobs.find((item) => item.publicRef === job!.publicRef)!;
      if (spendingBlock && job.status !== "registered") return this.#block(job, spendingBlock);
      await this.#project(job); return { status: job.status };
    } catch (error) {
      const code = errorCode(error); if (code === "lock_lost") throw error;
      if (code === "rpc_unavailable") return { status: job.status, errorCode: code };
      return this.#block(job, code);
    }
  }
}

/** Report-only helpers never acquire a fence or call ledger.atomic/source.project. */
export async function previewIdentity(config: IdentityConfig, source: IdentitySource, ledger: IdentityLedger, gateway: RegistryGateway) {
  if (source.identity !== null && !validIdentity(source.identity)) fail("invalid_identity");
  const state = await ledger.read();
  const identity = source.identity;
  const job = validIdentity(identity) ? state.jobs.find((item) => item.publicRef === identity.publicRef) : undefined;
  const category = validIdentity(source.identity) ? source.identity.category : source.category;
  if (category === null) return { exact: false, eligible: false, errorCode: "ineligible" as const };
  const publicRef = validIdentity(source.identity) ? source.identity.publicRef : null;
  const initialUri = publicRef === null ? null : job?.initialUri ?? null;
  const updateUpperBound = config.maxGas * config.maxPrice;
  if (initialUri === null || job === undefined) return { exact: false, eligible: source.eligible && source.existingId === null, category, template: metadataTemplate(category), updateUpperBoundWei: updateUpperBound.toString(), sendingBlocked: !config.exclusive };
  await gateway.probe(); const data = phaseCalldata({ initialUri, mintedId: null, finalUri: null }, "register");
  let registerRequirement: bigint;
  if (job?.registrationHash) {
    const tx = state.transactions.find((item) => item.hash === job.registrationHash); if (!tx) fail("intent_mismatch"); registerRequirement = BigInt(tx.intent.gas) * BigInt(tx.intent.gasPrice);
  } else { await gateway.simulate(data); const fees = await gateway.fees(data); registerRequirement = ((fees.estimate * 120n + 99n) / 100n) * fees.gasPrice; }
  return { exact: true, publicRef, category, initialUri, finalUri: job?.finalUri ?? null, status: job?.status ?? source.identity!.status,
    registerRequirementWei: registerRequirement.toString(), updateUpperBoundWei: updateUpperBound.toString(), combinedRequirementWei: (registerRequirement + updateUpperBound).toString(),
    effectiveCeilingWei: job?.effectiveCeiling ?? config.maxInstanceFee.toString(), dailyLiabilityWei: dailyLiability(state, Date.now()).toString(), sendingBlocked: !config.exclusive };
}
export async function verifyIdentity(source: IdentitySource, ledger: IdentityLedger, gateway: RegistryGateway) {
  if (!validIdentity(source.identity)) fail(source.identity === null ? "not_enrolled" : "invalid_identity");
  const enrolledIdentity = source.identity;
  const state = await ledger.read(); const job = state.jobs.find((item) => item.publicRef === enrolledIdentity.publicRef);
  if (!job || job.mintedId === null || job.updateHash === null || job.registrationHash === null) return { verified: false, errorCode: "verification_failed" as const };
  if (job.sourceId !== source.id || job.owner.toLowerCase() !== source.owner.toLowerCase() || job.category !== source.identity.category
    || job.status !== "registered" || job.completedAt === null || job.error !== null
    || source.identity.registrationTxHash !== job.registrationHash || source.identity.uriUpdateTxHash !== job.updateHash
    || source.identity.agentId !== job.mintedId || source.identity.status !== "registered" || source.identity.errorCode !== null
    || source.existingId !== job.mintedId) return { verified: false, errorCode: "verification_failed" as const };
  for (const [hash, phase] of [[job.registrationHash, "register"], [job.updateHash, "update"]] as const) {
    const tx = state.transactions.find((item) => item.hash === hash);
    if (!tx || tx.jobRef !== job.publicRef || tx.phase !== phase || tx.outcome !== "success" || tx.finalizedAt === null) return { verified: false, errorCode: "verification_failed" as const };
    assertIntent(job, tx, { ...job, maxGas: BigInt(tx.intent.gas), maxPrice: BigInt(tx.intent.gasPrice) }, false);
  }
  await gateway.probe();
  const finalized = await gateway.finalized();
  for (const hash of [job.registrationHash, job.updateHash]) {
    const receipt = await gateway.receipt(hash);
    if (!receipt || receipt.transactionHash !== hash || receipt.to?.toLowerCase() !== job.registry.toLowerCase() || receipt.from.toLowerCase() !== job.minter.toLowerCase() || receipt.status !== "success" || receipt.blockNumber > finalized || await gateway.blockHash(receipt.blockNumber) !== receipt.blockHash) return { verified: false, errorCode: "invalid_receipt" as const };
    if (hash === job.registrationHash && registeredId(receipt, job, job.initialUri) !== job.mintedId) return { verified: false, errorCode: "invalid_receipt" as const };
  }
  const identity = await gateway.identity(job.mintedId, finalized);
  return { verified: identity.owner.toLowerCase() === job.minter.toLowerCase() && identity.uri === job.finalUri && source.identity.status === "registered" && source.identity.agentId === job.mintedId && source.existingId === job.mintedId, agentId: job.mintedId, status: job.status };
}
