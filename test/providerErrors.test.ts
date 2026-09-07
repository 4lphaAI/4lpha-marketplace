/**
 * Offline tests for classification against REALISTIC provider payloads.
 *
 * The existing suite in `errors.test.ts` covers the sanitizer and the happy
 * shapes. This one covers the failure mode that actually bites: viem and the
 * Altana relay hand us a multi-line blob with the JSON-RPC request body in the
 * middle and the node's real revert reason at the bottom, and the classifier
 * used to read the whole thing. A `wallet_prepareCalls` body names the session
 * key's `expiry` on every single call, so classifying the raw text made
 * unrelated failures look like expired sessions — and "your session expired"
 * sends a user to re-hire an agent when the truth was an HTTP 429.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapProviderError, sanitizeMessage } from "../src/core/errors.js";
import {
  CapExceededError,
  InfrastructureError,
  NotAllowedError,
  ProviderError,
  SessionExpiredError,
} from "../src/core/types.js";

/**
 * The shape viem's `InternalRpcError` actually produces: header, URL, request
 * body, then `Details:` carrying the node's message. Note the ORDER — the
 * useful part comes last, after the part that must be stripped.
 */
function viemRpcError(header: string, details: string, body = SESSION_BODY): Error {
  return new Error(
    [
      header,
      "",
      "URL: https://testnet-relay.altana.network/rpc",
      `Request body: ${body}`,
      "",
      `Details: ${details}`,
      "Version: viem@2.55.11",
    ].join("\n"),
  );
}

/** A real `wallet_prepareCalls` body. It mentions "expiry" and a spend limit. */
const SESSION_BODY = JSON.stringify({
  method: "wallet_prepareCalls",
  params: [
    {
      capabilities: {
        permissions: {
          expiry: 1_800_003_600,
          permissions: {
            calls: [{ to: "0x000000000000000000000000000000000000dEaD" }],
            spend: [{ limit: "0x2386f26fc10000", period: "hour" }],
          },
        },
      },
      calls: [{ to: "0x000000000000000000000000000000000000dEaD", value: "0x5af3107a4000" }],
    },
  ],
});

describe("mapProviderError on realistic relay payloads", () => {
  it("does not read the request body's 'expiry' as an expired session", () => {
    const mapped = mapProviderError(
      viemRpcError(
        "An internal error was received.",
        "insufficient funds for gas * price + value",
      ),
    );

    assert.notEqual(mapped.code, "SESSION_EXPIRED");
    assert.equal(mapped.message.includes("wallet_prepareCalls"), false);
  });

  it("does not read the request body's 'spend' fields as a cap rejection", () => {
    const mapped = mapProviderError(
      viemRpcError("Execution reverted.", "execution reverted"),
    );

    assert.notEqual(mapped.code, "CAP_EXCEEDED");
    assert.ok(mapped instanceof ProviderError, `got ${mapped.name}`);
  });

  it("keeps the revert reason that sits AFTER the stripped request body", () => {
    const safe = sanitizeMessage(
      viemRpcError("An internal error was received.", "reverted: ExceededSpendLimit()")
        .message,
    );

    assert.match(safe, /ExceededSpendLimit/);
    assert.equal(safe.includes("wallet_prepareCalls"), false);
    assert.equal(safe.includes("altana.network"), false);
  });

  it("classifies a real ExceededSpendLimit revert, reason intact", () => {
    const mapped = mapProviderError(
      viemRpcError("An internal error was received.", "reverted: ExceededSpendLimit()"),
    );

    assert.ok(mapped instanceof CapExceededError, `got ${mapped.name}`);
    assert.match(mapped.message, /ExceededSpendLimit/);
  });

  it("classifies an undecoded revert by its 4-byte selector", () => {
    // Nodes that cannot decode a custom error return the raw selector. It is
    // the only unambiguous evidence in the whole payload.
    const mapped = mapProviderError(
      viemRpcError(
        "An internal error was received.",
        "execution reverted, unrecognized custom error 0x907e849a",
      ),
    );

    assert.ok(mapped instanceof CapExceededError, `got ${mapped.name}`);
  });

  it("finds a selector on a nested cause, not just the top message", () => {
    const inner = new Error("execution reverted: 0x7bf6a16f");
    const outer = new Error("The contract function reverted.", { cause: inner });

    assert.ok(mapProviderError(outer) instanceof NotAllowedError);
  });

  it("does not match a selector buried inside calldata", () => {
    const mapped = mapProviderError(
      new Error("call failed with data 0xdeadbeef907e849a00000000"),
    );

    assert.ok(mapped instanceof ProviderError, `got ${mapped.name}`);
  });

  it("files an HTTP 401 as infrastructure, not as a policy rejection", () => {
    const mapped = mapProviderError(
      new Error("HTTP request failed. Status: 401 Unauthorized"),
    );

    assert.ok(mapped instanceof InfrastructureError, `got ${mapped.name}`);
    assert.equal(mapped.code, "INFRASTRUCTURE_ERROR");
  });

  it("files an HTTP 429 as infrastructure", () => {
    const mapped = mapProviderError(
      new Error("HTTP request failed. Status code: 429 Too Many Requests"),
    );

    assert.equal(mapped.code, "INFRASTRUCTURE_ERROR");
  });

  it("files a 503 as infrastructure", () => {
    const mapped = mapProviderError(
      new Error("HTTP request failed. Status: 503 Service Unavailable"),
    );

    assert.equal(mapped.code, "INFRASTRUCTURE_ERROR");
  });

  it("files a relay internal error as infrastructure", () => {
    const mapped = mapProviderError(
      viemRpcError("An internal error was received.", "internal server error"),
    );

    assert.equal(mapped.code, "INFRASTRUCTURE_ERROR");
  });

  it("still prefers a revert selector over an infrastructure-looking wrapper", () => {
    // The relay reports policy rejections through a 500. The revert is the
    // truth; the status code is how it was delivered.
    const mapped = mapProviderError(
      viemRpcError(
        "An internal error was received.",
        "execution reverted: custom error 0x7bf6a16f",
      ),
    );

    assert.ok(mapped instanceof NotAllowedError, `got ${mapped.name}`);
  });

  it("classifies a genuine KeyExpired revert as an expired session", () => {
    const mapped = mapProviderError(
      viemRpcError("An internal error was received.", "reverted: KeyExpired()"),
    );

    assert.ok(mapped instanceof SessionExpiredError, `got ${mapped.name}`);
  });

  it("never leaks calldata or endpoints out of a classified error", () => {
    const mapped = mapProviderError(
      viemRpcError(
        "An internal error was received.",
        `signing failed for 0x${"ab".repeat(32)}`,
      ),
    );

    assert.equal(mapped.message.includes("abab"), false);
    assert.equal(mapped.message.includes("altana.network"), false);
    assert.ok(mapped.message.length <= 280);
  });
});
