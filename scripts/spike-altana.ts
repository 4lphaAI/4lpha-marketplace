/**
 * Phase 0 live spike — Altana SDK on BNB Chain.
 *
 * Answers the Phase 0 design questions with running proof rather than prose.
 * Every step prints PASS / FAIL / BLOCKED plus evidence (addresses, tx hashes)
 * and records its verdict in `.spike-state[.mainnet].json`, so a run that stops
 * for funding resumes exactly where it left off.
 *
 *   npm run spike
 *
 * `SPIKE_NETWORK=mainnet` spends REAL BNB and additionally requires
 * `SPIKE_CONFIRM_MAINNET=i-understand-real-funds`.
 *
 * Secrets: generated keys are written to `.env` and never printed. Addresses,
 * public keys, and tx hashes are printed — all are public on-chain data.
 */
import { signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import {
  formatEther,
  getAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isSessionExpired, validateSessionSpec } from "../src/core/session.js";
import {
  ExecutionPlaneError,
  type ExecutionErrorCode,
  type SessionRef,
  type SessionSpec,
} from "../src/core/types.js";
import {
  AltanaProvider,
  agentAuthorityFromPrivateKey,
  ownerAuthorityFromPrivateKey,
} from "../src/wallet/altana.js";
import { readEnvValue, writeEnvValue } from "./spike/env.js";
import {
  IS_MAINNET,
  NETWORK,
  RPC_URLS,
  SPIKE_NETWORK,
  UNIT,
  assertMainnetConfirmed,
} from "./spike/network.js";
import { describeError, explorerTx, heading, info, verdict } from "./spike/report.js";
import { openSpikeState, type SpikeStateStore } from "./spike/state.js";
import {
  revokeWithOwnerKeyOnly,
  withdrawWithOwnerKeyOnly,
  type DrillInputs,
} from "./spike/serverDeathDrill.js";

/* -------------------------------------------------------------------------- */
/* Spike parameters                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Cap probe amounts.
 *
 * Mainnet values are scaled so the over-cap probe is FALSIFIABLE at the funding
 * level we actually accept: if `OVER_CAP_VALUE` exceeded the wallet balance,
 * step 5b would be rejected for insufficient funds and we would record "the cap
 * held" on evidence that says nothing about caps at all. Hence the startup
 * assertion below.
 */
const CAP = IS_MAINNET ? parseEther("0.0005") : parseEther("0.005");
const CAP_PERIOD = "hour" as const;

/** Within cap and on the allowlist. Step 4 must succeed. */
const IN_SCOPE_VALUE = IS_MAINNET ? parseEther("0.0001") : parseEther("0.0001");

/** Above the cap, and affordable. Step 5b must be rejected for the AMOUNT. */
const OVER_CAP_VALUE = IS_MAINNET ? parseEther("0.001") : parseEther("0.01");

/** Room for a grant, a few executes, two revokes, and a sweep. */
const GAS_HEADROOM = IS_MAINNET ? parseEther("0.0008") : parseEther("0.005");

/** Enough to fund the over-cap probe AND the gas the run costs. */
const MIN_BALANCE = IS_MAINNET ? parseEther("0.002") : parseEther("0.02");

const SESSION_TTL_SECONDS = 60 * 60;

/** `SPIKE_OWNER_KEY_VAR` overrides which env var supplies the owner key. */
const OWNER_KEY_VAR =
  readEnvValue("SPIKE_OWNER_KEY_VAR") ??
  (IS_MAINNET ? "USER1_PRIVATE_KEY" : "OWNER_TEST_KEY");
const SESSION_KEY_VAR = IS_MAINNET ? "AGENT_SESSION_MAIN_KEY" : "AGENT_SESSION_TEST_KEY";

/**
 * Fail before spending anything if the probe amounts cannot prove what the
 * step claims to prove.
 */
function assertProbeAmountsAreFalsifiable(): void {
  if (OVER_CAP_VALUE <= CAP) {
    throw new Error(
      `Spike misconfigured: OVER_CAP_VALUE (${formatEther(OVER_CAP_VALUE)}) must exceed CAP (${formatEther(CAP)}), or step 5b proves nothing.`,
    );
  }
  if (IN_SCOPE_VALUE >= CAP) {
    throw new Error(
      `Spike misconfigured: IN_SCOPE_VALUE (${formatEther(IN_SCOPE_VALUE)}) must be under CAP (${formatEther(CAP)}), or step 4 is expected to fail.`,
    );
  }
  if (MIN_BALANCE <= OVER_CAP_VALUE + GAS_HEADROOM) {
    throw new Error(
      `Spike misconfigured: MIN_BALANCE (${formatEther(MIN_BALANCE)} ${UNIT}) must exceed OVER_CAP_VALUE + gas headroom (${formatEther(OVER_CAP_VALUE + GAS_HEADROOM)} ${UNIT}). At the accepted funding level the over-cap probe would be rejected for insufficient balance, not for the cap.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a key from `.env`, generating and persisting one on first run. */
function loadOrCreateKey(varName: string): Hex {
  const existing = readEnvValue(varName);
  if (existing !== undefined && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    return existing as Hex;
  }
  const created = generatePrivateKey();
  writeEnvValue(varName, created);
  return created;
}

/**
 * The user's real key is operator-provided and must never be generated: a
 * silently generated stand-in would make every "mainnet" result meaningless.
 */
function loadRequiredKey(varName: string): Hex {
  const existing = readEnvValue(varName);
  if (existing === undefined || !/^0x[0-9a-fA-F]{64}$/.test(existing)) {
    throw new Error(
      `${varName} is missing or malformed in .env.local — required for SPIKE_NETWORK=mainnet`,
    );
  }
  return existing as Hex;
}

function buildSpec(allowedTarget: Address, expiresAt: number): SessionSpec {
  return {
    allowedCalls: [{ to: allowedTarget }],
    spendCaps: [{ limit: CAP, period: CAP_PERIOD }],
    expiresAt,
  };
}

/**
 * Rebuild the SDK `Session` from the session key plus persisted public facts.
 *
 * Permissions and expiry must be byte-exact with what was granted or the
 * on-chain key hash will not match, which is exactly why the spike derives
 * them from fixed constants rather than from whatever a previous run returned.
 */
function rebuildSession(
  sessionKey: Hex,
  walletAddress: Address,
  spec: SessionSpec,
): SessionRef {
  const signer = signerFromPrivateKey(sessionKey);
  // `minSessionSeconds: 0` because this is a RECONSTRUCTION, not a grant. A
  // session with 30 seconds left is one we still need to be able to rebuild in
  // order to revoke it; refusing here would abort the run before the cleanup
  // steps. The permissions this produces are identical either way.
  const permissions = validateSessionSpec(spec, { minSessionSeconds: 0 });
  const session: Session = {
    walletAddress,
    signer,
    publicKey: signer.publicKey,
    permissions,
    expiry: spec.expiresAt,
  };
  return {
    walletAddress,
    chainId: NETWORK.chainId,
    publicKey: signer.publicKey,
    spec,
    handle: { session },
  };
}

/** An out-of-scope probe, with the rejection it must produce to count. */
type OutOfScopeProbe = {
  readonly name: string;
  readonly to: Address;
  readonly value: bigint;
  /** The classified code a correct rejection maps to. */
  readonly expectedCode: ExecutionErrorCode;
  /** Revert names/text that also count as the right reason. */
  readonly expectedReason: RegExp;
  readonly why: string;
};

/**
 * Did the rejection happen for the RIGHT reason?
 *
 * "The call was rejected" is not the finding. An out-of-scope call rejected
 * because the relay was down, or because the wallet ran dry, tells us nothing
 * about session scoping — and would quietly turn step 5 into a step that
 * passes no matter what the account contract does.
 */
function rejectionMatches(cause: unknown, probe: OutOfScopeProbe): boolean {
  if (cause instanceof ExecutionPlaneError && cause.code === probe.expectedCode) {
    return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return probe.expectedReason.test(message);
}

/* -------------------------------------------------------------------------- */
/* Spike                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  assertMainnetConfirmed();
  assertProbeAmountsAreFalsifiable();

  heading(
    `4lpha execution plane — Altana spike on ${NETWORK.chain.name} (chain ${NETWORK.chainId})`,
  );
  info(`network    ${SPIKE_NETWORK}`);
  info(`keystore   ${NETWORK.keyStore}`);
  info(`relay      configured: ${NETWORK.relayUrl !== undefined ? "yes" : "no"}`);
  info(`rpc        ${RPC_URLS.length} endpoint(s) configured`);

  const provider = new AltanaProvider({ network: NETWORK, rpcUrls: RPC_URLS });

  /* ---------------------------------------------------------------- step 0 */
  heading("Step 0 — keypairs and funding");

  const ownerKey = IS_MAINNET ? loadRequiredKey(OWNER_KEY_VAR) : loadOrCreateKey(OWNER_KEY_VAR);
  const sessionKey = loadOrCreateKey(SESSION_KEY_VAR);
  const owner = ownerAuthorityFromPrivateKey(ownerKey);
  const agent = agentAuthorityFromPrivateKey(sessionKey);
  const sessionAddress = getAddress(privateKeyToAccount(sessionKey).address);

  // State is opened only once the owner is known, so a state file written for
  // a different key is rejected before any of its verdicts are believed.
  const store: SpikeStateStore = openSpikeState({
    network: SPIKE_NETWORK,
    ownerAddress: owner.address,
  });
  const state = store.state;

  // Mainnet: dust goes to the session's own EOA (its key is in .env, so the
  // dust is recoverable). Testnet: the classic burn address is fine.
  const ALLOWED_TARGET = IS_MAINNET
    ? sessionAddress
    : getAddress("0x000000000000000000000000000000000000dead");

  // Step 5a needs a target that is NOT on the allowlist. On mainnet it must
  // also be recoverable, because "rejected" is the expected outcome and a bug
  // that let the call through would otherwise burn real BNB at 0x…d3ad1
  // forever. The owner's own address is off-allowlist and costs nothing to be
  // wrong about.
  const BLOCKED_TARGET = IS_MAINNET
    ? owner.address
    : getAddress("0x00000000000000000000000000000000000d3ad1");

  store.save();

  info(`OWNER address        ${owner.address}`);
  info(`AGENT session key    ${sessionAddress}`);
  info(`keys stored in .env (${OWNER_KEY_VAR}, ${SESSION_KEY_VAR}); values never printed`);

  const balance = await provider.getBalance({ address: owner.address });
  info(`OWNER balance        ${formatEther(balance)} ${UNIT}`);

  /* ---------------------------------------------------------------- step 1 */
  // Deliberately ahead of the funding gate: createWallet is counterfactual, so
  // the single most important Phase 0 question — can the user's own EOA be the
  // root authority? — is answerable with no gas and no transaction.
  heading("Step 1 — create the agent wallet (who can be root owner?)");

  const wallet = await provider.resolveOwnerWallet({ owner });
  const ownerIsWallet = wallet.address === owner.address;

  // The naive topology: a wallet created from the AGENT's own key. Also free
  // to check, and the result decides whether per-agent wallets are viable.
  const naiveAgentWallet = await provider.resolveOwnerWallet({ owner: agent });
  const naiveAddress = naiveAgentWallet.address;

  state.walletAddress = wallet.address;
  state.naiveAgentWalletAddress = naiveAddress;
  store.save();

  const step1Evidence = [
    `wallet address         ${wallet.address}`,
    `owner EOA address      ${owner.address}`,
    `wallet == owner EOA?   ${ownerIsWallet ? "YES" : "NO"}`,
    `naive agent-key wallet ${naiveAddress} (== agent EOA; owner has no authority over it)`,
    "no transaction required: createWallet is counterfactual",
  ];

  if (ownerIsWallet) {
    store.record(
      "1-create-wallet",
      "PASS",
      "Wallet address equals the owner EOA: the owner IS the root authority.",
      step1Evidence,
    );
    verdict("Step 1", "PASS", "owner EOA is the wallet's root authority", step1Evidence);
  } else {
    store.record(
      "1-create-wallet",
      "FAIL",
      "Wallet address diverged from the owner EOA; custody model assumption broken.",
      step1Evidence,
    );
    verdict("Step 1", "FAIL", "wallet is not the owner EOA", step1Evidence);
    return;
  }

  heading("Funding gate");

  if (balance < MIN_BALANCE) {
    store.record(
      "0-keys-and-funding",
      "BLOCKED",
      "Owner wallet is not funded; every subsequent step needs gas.",
      [`owner ${owner.address}`, `balance ${formatEther(balance)} ${UNIT}`],
    );
    verdict("Step 0", "BLOCKED", `owner wallet needs ${UNIT}`);
    heading("RESUME INSTRUCTIONS");
    info(`1. Fund this address with at least ${formatEther(MIN_BALANCE)} ${UNIT}:`);
    info(`      ${owner.address}`);
    if (IS_MAINNET) {
      info("2. This is BNB MAINNET: send real BNB from your exchange or wallet.");
    } else {
      info("2. Faucet: https://testnet.bnbchain.org/faucet-smart  (CAPTCHA required)");
      info("   Alternatives: https://faucet.chainstack.com/bnb-testnet-faucet");
      info("                 https://faucets.chain.link/bnb-chain-testnet");
    }
    info("3. Re-run `npm run spike`. It resumes from this step; nothing is repeated.");
    info("");
    info("Note: the SDK's fundNative() helper does NOT work for native BNB on");
    info("chain 97 — it calls mint() on address(0) and silently succeeds. See");
    info("FINDINGS.md (f).");
    heading("Summary");
    for (const [step, record] of Object.entries(state.steps)) {
      verdict(step, record.status, record.note);
    }
    return;
  }

  store.record("0-keys-and-funding", "PASS", "Owner key present and funded.", [
    `owner ${owner.address}`,
    `balance ${formatEther(balance)} ${UNIT}`,
  ]);
  verdict("Step 0", "PASS", `owner funded with ${formatEther(balance)} ${UNIT}`);

  /* ---------------------------------------------------------------- step 2 */
  heading("Step 2 — fund the agent wallet from the owner");

  const step2Evidence = [
    `wallet ${wallet.address} is the owner's own EOA`,
    `balance ${formatEther(await provider.getBalance({ address: wallet.address }))} ${UNIT}`,
  ];
  store.record(
    "2-fund-wallet",
    "SKIPPED",
    "Not applicable: an Altana wallet IS the owner's EOA, so there is no separate account to fund.",
    step2Evidence,
  );
  verdict(
    "Step 2",
    "SKIPPED",
    "no separate agent account exists to fund",
    step2Evidence,
  );

  /* ---------------------------------------------------------------- step 3 */
  heading("Step 3 — grant a scoped session to the agent key");

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  if (!store.isDone("3-grant-session")) {
    try {
      // The agent key is supplied, not generated: the spike must be able to
      // rebuild this exact session after a restart.
      const granted = await provider.grantSession({
        wallet,
        owner,
        agent,
        spec: buildSpec(ALLOWED_TARGET, expiresAt),
      });
      state.session = {
        publicKey: granted.publicKey,
        address: sessionAddress,
        expiresAt,
        allowedTarget: ALLOWED_TARGET,
        capWei: CAP.toString(),
        capPeriod: CAP_PERIOD,
      };
      store.save();
      const evidence = [
        `session public key ${granted.publicKey}`,
        `session EOA        ${sessionAddress}`,
        `allowlist          [${ALLOWED_TARGET}]`,
        `cap                ${formatEther(CAP)} ${UNIT} per ${CAP_PERIOD}`,
        `expiry             ${new Date(expiresAt * 1000).toISOString()}`,
        "owner signatures required: 1 (single admin-signed relay intent)",
      ];
      store.record("3-grant-session", "PASS", "Session granted.", evidence);
      verdict("Step 3", "PASS", "session granted with one owner signature", evidence);
    } catch (cause) {
      const detail = describeError(cause);
      store.record("3-grant-session", "FAIL", detail);
      verdict("Step 3", "FAIL", detail);
      return;
    }
  } else {
    verdict("Step 3", "PASS", "already granted in an earlier run (resumed)");
  }

  const sessionFacts = state.session;
  if (sessionFacts === undefined) {
    verdict("Step 3", "FAIL", "session facts missing from state");
    return;
  }

  // A resumed run can arrive here with a session that expired while the
  // operator was funding the wallet. Rebuilding it would throw inside
  // validation and abort the run BEFORE the revoke and sweep steps — the two
  // that clean up real money. The expired case therefore skips straight to
  // them, on the persisted public facts alone.
  const persistedSpec = buildSpec(sessionFacts.allowedTarget, sessionFacts.expiresAt);
  const sessionUsable = !isSessionExpired(persistedSpec);
  const session = sessionUsable
    ? rebuildSession(sessionKey, wallet.address, persistedSpec)
    : undefined;

  if (session === undefined) {
    info("");
    info(
      `Persisted session expired at ${new Date(sessionFacts.expiresAt * 1000).toISOString()};`,
    );
    info("skipping the execute-based steps and going straight to revoke + sweep.");
  }

  /* ---------------------------------------------------------------- step 4 */
  heading("Step 4 — execute within the session's limits (must succeed)");

  if (session === undefined) {
    store.record("4-in-scope-execute", "SKIPPED", "Persisted session already expired.");
    verdict("Step 4", "SKIPPED", "persisted session already expired");
  } else if (!store.isDone("4-in-scope-execute")) {
    try {
      const receipt = await provider.executeViaSession({
        session,
        calls: [{ to: ALLOWED_TARGET, value: IN_SCOPE_VALUE }],
      });
      const evidence = [
        `target ${ALLOWED_TARGET} (allowlisted)`,
        `value  ${formatEther(IN_SCOPE_VALUE)} ${UNIT} (under the ${formatEther(CAP)} cap)`,
        `status ${receipt.status}`,
        receipt.transactionHash !== undefined
          ? explorerTx(NETWORK.explorer, receipt.transactionHash)
          : "no transaction hash returned",
      ];
      if (receipt.status === "CONFIRMED") {
        store.record("4-in-scope-execute", "PASS", "In-scope call confirmed.", evidence);
        verdict("Step 4", "PASS", "in-scope call confirmed", evidence);
      } else {
        store.record("4-in-scope-execute", "FAIL", `Status ${receipt.status}.`, evidence);
        verdict("Step 4", "FAIL", `in-scope call returned ${receipt.status}`, evidence);
      }
    } catch (cause) {
      const detail = describeError(cause);
      store.record("4-in-scope-execute", "FAIL", detail);
      verdict("Step 4", "FAIL", detail);
    }
  } else {
    verdict("Step 4", "PASS", "already confirmed in an earlier run (resumed)");
  }

  /* ---------------------------------------------------------------- step 5 */
  heading("Step 5 — out-of-scope attempts (must FAIL; success here is critical)");

  const probes: readonly OutOfScopeProbe[] = [
    {
      name: "5a target not on allowlist",
      to: BLOCKED_TARGET,
      value: IN_SCOPE_VALUE,
      expectedCode: "NOT_ALLOWED",
      expectedReason: /unauthorized(call)?|not allowed|not permitted/i,
      why: "allowlist",
    },
    {
      name: "5b value above spend cap",
      to: ALLOWED_TARGET,
      value: OVER_CAP_VALUE,
      expectedCode: "CAP_EXCEEDED",
      expectedReason: /exceededspendlimit|spend ?limit|exceeds? (the )?spend/i,
      why: "spend cap",
    },
  ];

  for (const probe of probes) {
    if (session === undefined) {
      store.record(probe.name, "SKIPPED", "Persisted session already expired.");
      verdict(probe.name, "SKIPPED", "persisted session already expired");
      continue;
    }

    let rejected = false;
    let rightReason = false;
    let detail = "";
    try {
      // The local pre-flight is bypassed on purpose: the claim under test is
      // that the CHAIN rejects this, not that our own client-side copy of the
      // policy does.
      const receipt = await provider.executeViaSession({
        session,
        calls: [{ to: probe.to, value: probe.value }],
        bypassLocalPolicyCheck: true,
      });
      rejected = receipt.status === "FAILED";
      // A bare FAILED status carries no reason, so it cannot establish WHY.
      detail = `status ${receipt.status}${
        receipt.transactionHash !== undefined ? ` ${receipt.transactionHash}` : ""
      } (no reason available from a status-only rejection)`;
    } catch (cause) {
      // A throw is also a valid rejection: the relay refuses to simulate a
      // call the account's validator would revert.
      rejected = true;
      rightReason = rejectionMatches(cause, probe);
      detail = describeError(cause);
    }

    const evidence = [
      `target ${probe.to}`,
      `value ${formatEther(probe.value)} ${UNIT}`,
      `expected rejection: ${probe.expectedCode} (${probe.why})`,
      detail,
    ];

    if (rejected && rightReason) {
      store.record(probe.name, "PASS", `Rejected by the ${probe.why}, as required.`, evidence);
      verdict(probe.name, "PASS", `rejected by the ${probe.why}`, evidence);
    } else if (rejected) {
      store.record(
        probe.name,
        "FAIL",
        `Rejected, but not demonstrably by the ${probe.why}: the failure did not map to ${probe.expectedCode}.`,
        evidence,
      );
      verdict(
        probe.name,
        "FAIL",
        `rejected for an unproven reason (wanted ${probe.expectedCode})`,
        evidence,
      );
    } else {
      store.record(probe.name, "FAIL", "CRITICAL: out-of-scope call was NOT rejected.", evidence);
      verdict(
        probe.name,
        "FAIL",
        "CRITICAL — out-of-scope call succeeded; session scoping is not enforced",
        evidence,
      );
    }
  }

  /* ---------------------------------------------------------------- step 6 */
  heading("Step 6 — server death: revoke with the OWNER key alone");
  info("The drill runs in scripts/spike/serverDeathDrill.ts, whose inputs carry");
  info("no session signer. It uses viem against a public RPC; the Altana relay");
  info("and the 4lpha server are treated as gone.");

  const drill: DrillInputs = {
    ownerPrivateKey: ownerKey,
    walletAddress: wallet.address,
    chainId: NETWORK.chainId,
    sessionAddress: sessionFacts.address,
    sessionPublicKey: sessionFacts.publicKey,
  };

  if (!store.isDone("6-owner-only-revoke")) {
    try {
      const result = await revokeWithOwnerKeyOnly(provider, drill);
      const evidence = [
        `account revoke   ${result.accountRevoke.status} ${
          result.accountRevoke.transactionHash ?? ""
        }${result.accountKeyAbsent ? " (KeyDoesNotExist: no account-level entry)" : ""}`,
        result.keyStoreRevoke !== undefined
          ? `keystore revoke  ${result.keyStoreRevoke.status} ${result.keyStoreRevoke.transactionHash ?? ""}`
          : "keystore revoke  skipped (key was not registered)",
        `KeyStore.isValidKey after revoke: ${result.keyStoreRegistered}`,
        `account key still listed: ${result.accountKeyPresent ?? "unreadable"}`,
      ];
      // The provider read the post-condition back off the chain and decided.
      // The spike does not second-guess it.
      const ok = result.revoked;
      store.record(
        "6-owner-only-revoke",
        ok ? "PASS" : "FAIL",
        ok
          ? "Owner key alone revoked the session with no relay and no agent key."
          : "Owner-only revocation did not fully land.",
        evidence,
      );
      verdict(
        "Step 6",
        ok ? "PASS" : "FAIL",
        ok ? "owner key alone killed the session" : "owner-only revoke incomplete",
        evidence,
      );
    } catch (cause) {
      const detail = describeError(cause);
      store.record("6-owner-only-revoke", "FAIL", detail);
      verdict("Step 6", "FAIL", detail);
    }
  } else {
    verdict("Step 6", "PASS", "already revoked in an earlier run (resumed)");
  }

  /* ---------------------------------------------------------------- step 7 */
  heading("Step 7 — revoked session must no longer execute");

  if (session === undefined) {
    store.record(
      "7-post-revoke-denied",
      "SKIPPED",
      "Persisted session already expired; expiry, not revocation, would be doing the rejecting.",
    );
    verdict("Step 7", "SKIPPED", "persisted session already expired");
  } else {
    let denied = false;
    let denialDetail = "";
    try {
      const receipt = await provider.executeViaSession({
        session,
        calls: [{ to: ALLOWED_TARGET, value: IN_SCOPE_VALUE }],
        bypassLocalPolicyCheck: true,
      });
      denied = receipt.status === "FAILED";
      denialDetail = `status ${receipt.status}`;
    } catch (cause) {
      denied = true;
      denialDetail = describeError(cause);
    }

    store.record(
      "7-post-revoke-denied",
      denied ? "PASS" : "FAIL",
      denied ? "Revoked session rejected." : "CRITICAL: revoked session still executed.",
      [denialDetail],
    );
    verdict(
      "Step 7",
      denied ? "PASS" : "FAIL",
      denied ? "revoked session rejected" : "CRITICAL — revoked session still executes",
      [denialDetail],
    );
  }

  /* ---------------------------------------------------------------- step 8 */
  heading("Step 8 — server death: withdraw everything with the OWNER key alone");

  if (!store.isDone("8-owner-only-withdraw")) {
    try {
      const before = await provider.getBalance({ address: wallet.address });
      // Mainnet sweeps back to the owner itself: the mechanism is proven by the
      // owner-signed transfer landing, and the only real cost is gas. Testnet
      // keeps the historical burn target.
      const receipt = await withdrawWithOwnerKeyOnly(
        provider,
        drill,
        IS_MAINNET ? undefined : ALLOWED_TARGET,
      );
      const after = await provider.getBalance({ address: wallet.address });
      const evidence = [
        `balance before ${formatEther(before)} ${UNIT}`,
        `balance after  ${formatEther(after)} ${UNIT}`,
        `status ${receipt.status}`,
        receipt.transactionHash !== undefined
          ? explorerTx(NETWORK.explorer, receipt.transactionHash)
          : "no transaction hash returned",
      ];
      const ok = receipt.status === "CONFIRMED" && after < before;
      store.record(
        "8-owner-only-withdraw",
        ok ? "PASS" : "FAIL",
        ok
          ? "Owner key alone swept the wallet with no relay involved."
          : "Owner-only withdrawal did not move funds.",
        evidence,
      );
      verdict(
        "Step 8",
        ok ? "PASS" : "FAIL",
        ok ? "owner key alone swept the wallet" : "owner-only sweep failed",
        evidence,
      );
    } catch (cause) {
      const detail = describeError(cause);
      store.record("8-owner-only-withdraw", "FAIL", detail);
      verdict("Step 8", "FAIL", detail);
    }
  } else {
    verdict("Step 8", "PASS", "already swept in an earlier run (resumed)");
  }

  /* ------------------------------------------------------------- summary   */
  heading("Summary");
  for (const [step, record] of Object.entries(state.steps)) {
    verdict(step, record.status, record.note);
  }
  info("");
  info(`Full record: ${store.path.pathname}`);
}

try {
  await main();
} catch (cause) {
  // Nothing above this line is allowed to end the run with a raw stack trace:
  // provider errors carry calldata and endpoint URLs, and this script runs
  // with real keys in its environment.
  heading("SPIKE ABORTED");
  info(describeError(cause));
  process.exitCode = 1;
}
