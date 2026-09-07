import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TICKET_SIGNING_BYTES, ticketSigningBytes } from "../src/billing/canonical.js";
import type { PaidServiceSessionTicketV1 } from "../src/billing/types.js";

const id = (prefix: string, index?: number): string =>
  `${prefix}${index === undefined ? "" : String(index).padStart(2, "0")}`.padEnd(64, "x");

describe("AWS Ed25519 ticket byte bound", () => {
  it("keeps the all-maxima valid ticket below the reviewed 3584-byte construction bound", () => {
    const ticket: PaidServiceSessionTicketV1 = {
      domain: "4lpha.paid-service-ticket.v1",
      ticketId: "t".repeat(128), accountId: "a".repeat(128), agentId: "b".repeat(128),
      ownerAddress: `0x${"11".repeat(20)}`, walletAddress: `0x${"22".repeat(20)}`,
      grantId: "g".repeat(128), generation: (1n << 255n) - 1n,
      operations: ["paid.0g.chat", "paid.cmc.quote"],
      templateIds: Array.from({ length: 8 }, (_value, index) => id("template", index)).sort(),
      allowedModelIds: Array.from({ length: 8 }, (_value, index) => id("model", index)).sort(),
      maxTokensPerInference: Number.MAX_SAFE_INTEGER,
      maxSessionUsdMicros: (1n << 255n) - 1n,
      ownerActionParamsHash: `0x${"33".repeat(32)}`,
      issuedAt: Number.MAX_SAFE_INTEGER - 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      executionTicketKeyId: "k".repeat(64), signature: "A".repeat(86),
    };
    const bytes = ticketSigningBytes(ticket);
    assert.ok(bytes.byteLength <= 3_584, `max ticket was ${bytes.byteLength} bytes`);
    assert.ok(bytes.byteLength <= MAX_TICKET_SIGNING_BYTES);
  });

  it("rejects an unbounded template array before signing", () => {
    const ticket: PaidServiceSessionTicketV1 = {
      domain: "4lpha.paid-service-ticket.v1",
      ticketId: "t", accountId: "a", agentId: "b",
      ownerAddress: `0x${"11".repeat(20)}`, walletAddress: `0x${"22".repeat(20)}`,
      grantId: "g", generation: 1n, operations: ["paid.cmc.quote"],
      templateIds: Array.from({ length: 9 }, (_value, index) => `t${index}`),
      maxSessionUsdMicros: 1n, ownerActionParamsHash: `0x${"33".repeat(32)}`,
      issuedAt: 1, expiresAt: 2, executionTicketKeyId: "key", signature: "A".repeat(86),
    };
    assert.throws(() => ticketSigningBytes(ticket), /bounded/);
  });
});
