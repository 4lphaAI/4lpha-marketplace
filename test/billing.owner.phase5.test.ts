import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signPaidBytes } from "../src/billing/canonical.js";
import { MemoryBillingStore } from "../src/billing/store.js";
import type { BillingAccount } from "../src/billing/types.js";
import { billingAccountId } from "../src/billing/serviceSession.js";
import {
  AGENT_ID,
  CHAIN_ID,
  NETWORK,
  NOW_SEC,
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";

const BILLING_ACCOUNT_ID = billingAccountId(ownerAccount.address, ownerAccount.address);

function ed25519() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

async function fixture(options: { readonly accountReadSession?: boolean } = {}) {
  const store = new MemoryBillingStore();
  const account: BillingAccount = {
    accountId: BILLING_ACCOUNT_ID,
    ownerAddress: ownerAccount.address.toLowerCase(),
    walletAddress: ownerAccount.address.toLowerCase(),
    status: "active",
    sessionFactsBytes: "billing-session-v1",
    encryptedSessionKey: "ciphertext-only",
    maxDailyUsdMicros: 5_000_000n,
    maxUnpaidExposureUsdMicros: 2_000_000n,
    thresholdUsdMicros: 100_000n,
    grantExpiresAt: NOW_SEC + 3_600,
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
  };
  await store.createAccount(account);
  const ticketKeys = ed25519();
  const issuerKeys = ed25519();
  const harness = await createHarness({
    ...(options.accountReadSession !== true ? {} : {
      config: {
        accountReadSession: {
          key: parseAccountReadSessionSecret("cd".repeat(32))!,
          chainId: CHAIN_ID,
          environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
        },
      },
    }),
    billingOwner: {
      store,
      executionTicketKeyId: "ticket-key-1",
      signExecutionTicket: async (bytes) => signPaidBytes(ticketKeys.privateKey, bytes),
      async onChainSessionExpiresAt() { return NOW_SEC + 3_600; },
      async actualUsdMicros() { return 0n; },
    },
  });
  return { store, harness, issuerKeys };
}

function grantParams(publicKey: string) {
  return {
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    accountId: BILLING_ACCOUNT_ID,
    agentId: AGENT_ID,
    grantId: "billing-grant-1",
    generation: "1",
    issuerKeyId: "issuer-key-1",
    issuerPublicKey: publicKey,
    operations: ["paid.0g.chat"],
    templateIds: ["0g.chat.v1"],
    maxAtomic0gPerInference: "1000000000000000000",
    maxUsdMicrosPerRequest: "1000000",
    maxRolling24hUsdMicros: "5000000",
    maxTokensPerInference: 1024,
    notBefore: NOW_SEC,
    expiresAt: NOW_SEC + 1_800,
  };
}

test("owner billing grant and service session are owner-signed, scoped, and portable", async () => {
  const { harness, issuerKeys, store } = await fixture();
  const grant = await signOwnerAction("billingGrant", grantParams(issuerKeys.publicKey));
  const granted = await call(harness, `/agents/${AGENT_ID}/billing/grant`, { method: "POST", body: grant });
  assert.equal(granted.status, 200);
  const storedGrant = await store.getGrant("billing-grant-1", 1n);
  assert.equal(storedGrant?.issuerKeyId, "issuer-key-1");

  const params = {
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    accountId: BILLING_ACCOUNT_ID,
    agentId: AGENT_ID,
    grantId: "billing-grant-1",
    generation: "1",
    operations: ["paid.0g.chat"],
    templateIds: ["0g.chat.v1"],
    allowedModelIds: ["0gm-1.0-35b-a3b"],
    maxTokensPerInference: 128,
    maxSessionUsdMicros: "500000",
    issuedAt: NOW_SEC,
    expiresAt: NOW_SEC + 600,
    chainId: 56,
  };
  const envelope = await signOwnerAction("billingServiceSession", params);
  const response = await call(harness, `/agents/${AGENT_ID}/billing/service-session`, { method: "POST", body: envelope });
  assert.equal(response.status, 200);
  const ticket = ((response.body["data"] as Record<string, unknown>)["sessionTicket"] as Record<string, unknown>);
  assert.equal(ticket["generation"], "1");
  assert.equal(ticket["maxSessionUsdMicros"], "500000");
  assert.equal(typeof ticket["signature"], "string");
  assert.equal((ticket["signature"] as string).includes("="), false);
});

test("billing account lifecycle is account-wide and close cannot silently reopen", async () => {
  const { harness, issuerKeys, store } = await fixture();
  await call(harness, `/agents/${AGENT_ID}/billing/grant`, {
    method: "POST",
    body: await signOwnerAction("billingGrant", grantParams(issuerKeys.publicKey)),
  });
  const accountParams = {
    ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address,
    accountId: BILLING_ACCOUNT_ID,
    agentId: AGENT_ID,
  };
  assert.equal((await call(harness, `/agents/${AGENT_ID}/billing/pause`, { method: "POST", body: await signOwnerAction("billingPause", accountParams) })).status, 200);
  assert.equal((await store.getAccount(BILLING_ACCOUNT_ID))?.status, "paused");
  assert.equal((await call(harness, `/agents/${AGENT_ID}/billing/resume`, { method: "POST", body: await signOwnerAction("billingResume", accountParams) })).status, 200);
  assert.equal((await call(harness, `/agents/${AGENT_ID}/billing/close`, { method: "POST", body: await signOwnerAction("billingClose", accountParams) })).status, 200);
  assert.equal((await store.getAccount(BILLING_ACCOUNT_ID))?.status, "closing");
  await assert.rejects(store.setAccountStatus(BILLING_ACCOUNT_ID, "active", NOW_SEC + 1));
});

test("billing owner read is authenticated and never returns encrypted session material", async () => {
  const { harness } = await fixture();
  const read = await signOwnerAction("read", {});
  const response = await call(harness, `/agents/${AGENT_ID}/billing`, {
    method: "GET",
    headers: { "x-owner-action": toReadHeader(read) },
  });
  assert.equal(response.status, 200);
  const rendered = JSON.stringify(response.body);
  assert.equal(rendered.includes("ciphertext-only"), false);
  assert.equal(rendered.includes("billing-session-v1"), false);
  assert.equal((response.body["data"] as Record<string, unknown>)["thresholdUsdMicros"], "100000");
});

test("billing grant rejects cross-agent and unknown-field mutation without storing a grant", async () => {
  const { harness, issuerKeys, store } = await fixture();
  const mutated = { ...grantParams(issuerKeys.publicKey), agentId: "another-agent", surprise: true };
  const response = await call(harness, `/agents/${AGENT_ID}/billing/grant`, {
    method: "POST",
    body: await signOwnerAction("billingGrant", mutated),
  });
  assert.equal(response.status, 400);
  assert.equal(await store.getGrant("billing-grant-1", 1n), null);
});

test("a valid account-read bearer changes no configured billing owner route", async () => {
  const { harness } = await fixture({ accountReadSession: true });
  const issued = await call(harness, "/owner-read-session", {
    method: "POST",
    body: await signOwnerAction("createAccountReadSession", {}, { agentId: "*" }),
  });
  const token = (issued.body["data"] as { token: string }).token;
  const paths = [
    { path: `/agents/${AGENT_ID}/billing`, options: {} },
    { path: `/agents/${AGENT_ID}/billing/grant`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/issuer/rotate`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/pause`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/resume`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/revoke`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/close`, options: { method: "POST" as const, body: {} } },
    { path: `/agents/${AGENT_ID}/billing/service-session`, options: { method: "POST" as const, body: {} } },
  ];
  for (const probe of paths) {
    const control = await call(harness, probe.path, probe.options);
    const bearer = await call(harness, probe.path, { ...probe.options, headers: { authorization: `Bearer ${token}` } });
    assert.equal(bearer.status, control.status, probe.path);
    assert.equal(bearer.text, control.text, probe.path);
  }
  assert.equal(harness.provider.executeCalls.length, 0);
});
