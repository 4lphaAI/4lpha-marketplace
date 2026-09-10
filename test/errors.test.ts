/**
 * Offline tests for upstream-error sanitization and classification.
 *
 * The sanitizer is a security control, not a formatting nicety: relay errors
 * routinely embed full calldata and endpoint URLs, and anything shaped like a
 * private key must never survive into a log line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  classifyFailureCode,
  mapProviderError,
  sanitizeMessage,
} from "../src/core/errors.js";
import {
  CapExceededError,
  InvalidSessionSpecError,
  NotAllowedError,
  ProviderError,
  SessionExpiredError,
} from "../src/core/types.js";

describe("sanitizeMessage", () => {
  it("redacts 32-byte-and-longer hex blobs", () => {
    const secret = `0x${"ab".repeat(32)}`;
    const output = sanitizeMessage(`failed with ${secret}`);

    assert.equal(output.includes(secret), false);
    assert.match(output, /0x\[redacted]/);
  });

  it("redacts long calldata", () => {
    const calldata = `0x${"11".repeat(200)}`;
    const output = sanitizeMessage(`bad call ${calldata}`);

    assert.equal(output.includes("1111"), false);
  });

  it("keeps plain addresses, which are safe and useful in diagnostics", () => {
    const address = "0x000000000000000000000000000000000000dEaD";
    assert.match(sanitizeMessage(`target ${address} rejected`), /0x0{36}dEaD/);
  });

  it("strips endpoint URLs", () => {
    const output = sanitizeMessage(
      "relay error contacting https://testnet-relay.example.network/rpc?key=abc",
    );

    assert.equal(output.includes("example.network"), false);
    assert.match(output, /\[url]/);
  });

  it("drops an appended request body wholesale", () => {
    const output = sanitizeMessage(
      'An internal error was received. Request body: {"method":"wallet_prepareCalls","params":[{"secret":1}]}',
    );

    assert.equal(output.includes("wallet_prepareCalls"), false);
    assert.match(output, /internal error/);
  });

  it("collapses whitespace and bounds the length", () => {
    const output = sanitizeMessage(`x${"y ".repeat(500)}`);

    assert.ok(output.length <= 280, `length was ${output.length}`);
    assert.equal(output.includes("\n"), false);
  });

  it("falls back to a generic message when nothing survives", () => {
    assert.equal(
      sanitizeMessage("   "),
      "Wallet provider request failed.",
    );
  });
});

describe("mapProviderError", () => {
  it("classifies expiry failures", () => {
    assert.ok(
      mapProviderError(new Error("key expired at block 42")) instanceof
        SessionExpiredError,
    );
  });

  it("classifies spend-cap failures", () => {
    assert.ok(
      mapProviderError(new Error("ExceededSpendLimit()")) instanceof
        CapExceededError,
    );
  });

  it("classifies allowlist failures", () => {
    assert.ok(
      mapProviderError(new Error("UnauthorizedCall()")) instanceof
        NotAllowedError,
    );
  });

  it("classifies a revoked key as not allowed", () => {
    assert.ok(
      mapProviderError(new Error("key has been revoked")) instanceof
        NotAllowedError,
    );
  });

  it("falls back to ProviderError for anything unrecognized", () => {
    // WAS `socket hang up`, which PHASE3.1-FIXREVIEW F1 established is not
    // "unrecognized" at all but the single most common transient failure an
    // HTTP JSON-RPC client produces — see the CONNECTION_PATTERNS block below,
    // which pins its new verdict. The fallback itself is unchanged and is still
    // asserted here, on a string that genuinely carries no signal.
    const mapped = mapProviderError(new Error("the frobnicator disagreed"));

    assert.ok(mapped instanceof ProviderError);
    assert.equal(mapped.code, "PROVIDER_ERROR");
  });

  it("handles non-Error throws", () => {
    assert.ok(mapProviderError("boom") instanceof ProviderError);
    assert.ok(mapProviderError(undefined) instanceof ProviderError);
  });

  it("passes our own errors through without reclassifying", () => {
    const original = new InvalidSessionSpecError("expiresAt must be in the future.");
    const mapped = mapProviderError(original);

    assert.equal(mapped, original);
    assert.equal(mapped.code, "INVALID_SESSION_SPEC");
  });

  it("sanitizes the message it carries forward", () => {
    const mapped = mapProviderError(
      new Error(`session expired; key 0x${"cd".repeat(32)}`),
    );

    assert.ok(mapped instanceof SessionExpiredError);
    assert.equal(mapped.message.includes("cdcd"), false);
  });

  it("exposes a stable code for every error class", () => {
    assert.equal(new SessionExpiredError().code, "SESSION_EXPIRED");
    assert.equal(new CapExceededError().code, "CAP_EXCEEDED");
    assert.equal(new NotAllowedError().code, "NOT_ALLOWED");
    assert.equal(new ProviderError().code, "PROVIDER_ERROR");
  });

  it("names errors after their class for log readability", () => {
    assert.equal(new SessionExpiredError().name, "SessionExpiredError");
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.1-FIXREVIEW F1 — the connection-level half of the transport class   */
/* -------------------------------------------------------------------------- */

describe("mapProviderError: transport failures that never got an HTTP status", () => {
  /**
   * THE FINDING. `INFRASTRUCTURE_ERROR` used to mean "an HTTP server answered,
   * and the answer was an outage". Every failure BELOW that — the connection
   * reset, the refused socket, the DNS lookup that never resolved, the request
   * that timed out — fell through to `PROVIDER_ERROR`, which every caller that
   * retries transient failures treats as permanent. So the rarest blips were
   * retried and the commonest ones were not.
   *
   * The vocabulary here is Node's, undici's and viem's verbatim, including the
   * two viem shapes the reviewer measured: an `HttpRequestError` with no status
   * line (the server never answered) and a `TimeoutError`.
   */
  const TRANSPORT: readonly (readonly [string, string])[] = [
    ["socket hang up", "socket hang up"],
    ["read ECONNRESET", "ECONNRESET"],
    ["connect ECONNREFUSED 127.0.0.1:8545", "ECONNREFUSED"],
    ["connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"],
    ["getaddrinfo EAI_AGAIN bsc-dataseed.example", "EAI_AGAIN"],
    ["getaddrinfo ENOTFOUND bsc-dataseed.example", "ENOTFOUND"],
    ["HTTP request failed. Details: fetch failed", "viem network-level failure"],
    [
      "The request took too long to respond. Details: The request timed out.",
      "viem TimeoutError",
    ],
    ["Premature close", "undici premature close"],
    ["terminated", "undici bare terminated"],
    ["Client network socket disconnected", "network socket"],
  ];

  for (const [message, label] of TRANSPORT) {
    it(`classifies ${label} as INFRASTRUCTURE_ERROR, not a permanent provider failure`, () => {
      const mapped = mapProviderError(new Error(message));

      assert.equal(
        mapped.code,
        "INFRASTRUCTURE_ERROR",
        `${message} classified ${mapped.code}`,
      );
    });
  }

  it("still classifies the status-bearing failures it always did", () => {
    for (const message of [
      "HTTP request failed. Status: 429",
      "HTTP request failed. Status: 500",
      "rate limit exceeded",
      "503 Service Unavailable",
    ]) {
      assert.equal(mapProviderError(new Error(message)).code, "INFRASTRUCTURE_ERROR");
    }
  });

  it("does NOT reclassify a PRODUCT refusal — the order still puts reverts first", () => {
    // The trap R2 and FINDINGS (al) are about: an outage must never masquerade
    // as a policy rejection, and the widening must not make policy rejections
    // masquerade as outages either. Revert selectors and decoded revert NAMES
    // are still checked before any prose pattern, so these are unmoved.
    assert.equal(
      mapProviderError(new Error("execution reverted: ExceededSpendLimit()")).code,
      "CAP_EXCEEDED",
    );
    assert.equal(
      mapProviderError(new Error("execution reverted: KeyExpired()")).code,
      "SESSION_EXPIRED",
    );
    assert.equal(
      mapProviderError(new Error("execution reverted: UnauthorizedCall()")).code,
      "NOT_ALLOWED",
    );
    assert.equal(
      mapProviderError(new Error("the session key has been revoked")).code,
      "NOT_ALLOWED",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* PHASE3.1-FIXREVIEW2 G2 — the six shapes that flipped, and which now do not */
/* -------------------------------------------------------------------------- */

/**
 * THE FINDING. Erratum E9 claimed normatively that "revert selectors and decoded
 * revert NAMES are still classified first, SO a real on-chain refusal can never
 * be reclassified as an outage". The reviewer measured six shapes for which the
 * clause after "so" was false, and every one of them is reproduced here as a
 * test rather than as a sentence, so the label and the code can never drift
 * again in either direction.
 *
 * The six split cleanly in two, and the split is the whole of the fix:
 *
 *   - ONE of them carried STRUCTURED evidence that a node had answered and the
 *     call had reverted (`execution reverted: Timeout()` — an ordinary custom
 *     error name that happens to be a transport word). That is now classified
 *     from its evidence, not from its vocabulary: `REVERT_EVIDENCE` suppresses
 *     the transport patterns entirely, so the failure is PERMANENT, which is
 *     what a revert is. This is real behaviour: the LP saga's optional step
 *     retries `INFRASTRUCTURE_ERROR` six times before skipping;
 *   - the other FIVE are PROSE-ONLY refusals that also carry a genuine
 *     transport phrase (`socket hang up` is not ambiguous English). No ordering
 *     rule can adjudicate two contradictory signals in one string, so these are
 *     pinned as an ACCEPTED, DOCUMENTED residue rather than "fixed", and E9 now
 *     says so. The direction is deliberate: the class drives exactly one
 *     decision (retry or skip), the decision site is above every submit, so the
 *     cost of being wrong this way is six free round trips, and the cost of
 *     being wrong the other way is A1 — a stop-loss permanently abandoning the
 *     volatile leg because one socket reset was called permanent.
 */
describe("mapProviderError: G2 — structured revert evidence beats transport prose", () => {
  it("a decoded custom error NAMED like a transport failure is a revert, not an outage", () => {
    // The counter-example E9's normative clause was refuted by. BEFORE: this
    // measured `INFRASTRUCTURE_ERROR`, so the LP exit's swap was held and
    // retried six times against a contract that will revert identically every
    // time. AFTER: a permanent classification, taken on the first attempt.
    assert.equal(
      mapProviderError(new Error("execution reverted: Timeout()")).code,
      "PROVIDER_ERROR",
    );
  });

  it("suppresses transport prose for every shape a node uses to report a revert", () => {
    for (const message of [
      "execution reverted: Insufficient liquidity for TIMEOUT/WBNB",
      "execution reverted: NetworkError()",
      'The contract function "exactInputSingle" reverted with the following reason: Timeout',
      "reverted with custom error 'ConnectionReset()'",
    ]) {
      assert.equal(
        mapProviderError(new Error(message)).code,
        "PROVIDER_ERROR",
        `${message} classified as an outage`,
      );
    }
  });

  it("finds the revert on a NESTED cause under a generic top message", () => {
    // viem hangs the revert on a cause as often as on the top message, so the
    // evidence check has the same reach `mentionsRevertSelector` already had.
    const outer = new Error("Execution failed; request timed out");
    (outer as unknown as { cause: unknown }).cause = new Error(
      "execution reverted: Timeout()",
    );

    assert.equal(mapProviderError(outer).code, "PROVIDER_ERROR");
  });

  it("still classifies the five ACCOUNT-level refusals from their own evidence", () => {
    // Unmoved by the new layer, and the reason the layer can only ever move a
    // verdict OUT of `INFRASTRUCTURE_ERROR`: these are decided two steps
    // earlier, from the selector or the decoded name.
    assert.equal(
      mapProviderError(
        new Error("execution reverted: ExceededSpendLimit() after the request timed out"),
      ).code,
      "CAP_EXCEEDED",
    );
    assert.equal(
      mapProviderError(new Error("execution reverted: KeyExpired(); socket hang up")).code,
      "SESSION_EXPIRED",
    );
    assert.equal(
      mapProviderError(new Error("UnauthorizedCall. Details: fetch failed")).code,
      "NOT_ALLOWED",
    );
  });

  it("does NOT suppress transport prose for an outage that merely mentions retrying", () => {
    // The narrowness of `REVERT_EVIDENCE` is the point: a bare "reverted" is
    // prose an outage can carry, so it is not evidence.
    for (const message of [
      "the relay reverted to its fallback endpoint after socket hang up",
      "HTTP request failed. Details: fetch failed",
      "The request took too long to respond. Details: The request timed out.",
      "Chain pre-flight read timed out.",
    ]) {
      assert.equal(
        mapProviderError(new Error(message)).code,
        "INFRASTRUCTURE_ERROR",
        `${message} lost its transport classification`,
      );
    }
  });

  it("PINS the accepted residue: a PROSE-ONLY refusal plus transport prose reads as an outage", () => {
    // These five are the reviewer's measurement verbatim, and they are asserted
    // as they ARE, not as E9 wished they were. Changing any of these to the
    // refusal class means narrowing `\btimeout\b` / `\bnetwork error\b` /
    // `\bconnection error\b` — which regresses A1, the ship gate — so if a
    // future pass wants that trade it has to come here and argue for it.
    for (const message of [
      "the call exceeds the spend limit; connection error",
      "session has expired and the request timed out",
      "unauthorized: network error",
      "the session key has been revoked; socket hang up",
      "Insufficient liquidity for TIMEOUT/WBNB",
    ]) {
      assert.equal(
        mapProviderError(new Error(message)).code,
        "INFRASTRUCTURE_ERROR",
        `${message} moved class; E9's residue clause needs revisiting`,
      );
    }
  });

  it("classifyFailureCode behaves identically on a whole FAILED body", () => {
    // The reviewer's sixth measurement: the same body with and without a
    // transport line in a nested field. Unchanged by this fix — there is no
    // revert marker anywhere in it — and pinned so the asymmetry is on record.
    assert.equal(
      classifyFailureCode({
        message: "Execution FAILED",
        details: "spend limit reached",
        cause: { message: "upstream request timed out" },
      }),
      "INFRASTRUCTURE_ERROR",
    );
    assert.equal(
      classifyFailureCode({
        message: "Execution FAILED",
        details: "spend limit reached",
      }),
      "CAP_EXCEEDED",
    );
    // ...but ONE revert marker in the body is enough to make it a refusal.
    assert.equal(
      classifyFailureCode({
        message: "Execution FAILED",
        details: "execution reverted: spend limit reached",
        cause: { message: "upstream request timed out" },
      }),
      "CAP_EXCEEDED",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* E9 item 2's tripwire (PHASE3.1-FIXREVIEW3 H1)                              */
/* -------------------------------------------------------------------------- */

/**
 * PHASE3.1-SPEC's erratum **E9 item 2** accepts a residue — a PROSE-ONLY refusal
 * that also carries transport vocabulary classifies as an outage — and pins five
 * samples of it in the suite above. Its acceptability is CONDITIONAL, in the
 * erratum's own words: "if a future phase ever branches on
 * `INFRASTRUCTURE_ERROR` below a submit, this residue stops being acceptable and
 * item 2 must be revisited before that branch ships."
 *
 * That condition had no mechanism, and its antecedent is a count two consecutive
 * review passes got wrong: PHASE3.1-FIXREVIEW2 G5 corrected "exactly one branch
 * site" to two, and PHASE3.1-FIXREVIEW3 H1 found that `isTransientFailure` — one
 * of those two — is itself called from THREE places, which is the number the
 * safety argument actually depends on. A condition whose antecedent its own
 * authors cannot keep accurate does not fire, so it is a test now: this repo pins
 * invariants that matter with mechanisms (golden vectors, `assertNoDuplicateSubmits`,
 * the `audit.*.test.ts` files), not with sentences.
 *
 * These cases assert nothing about behaviour. They FAIL when the set of places
 * that branch on the transport class changes, and the failure message is the
 * pointer to E9 that a `grep` and a good intention were standing in for.
 */
describe("E9 item 2's tripwire — where INFRASTRUCTURE_ERROR is branched on", () => {
  const E9 =
    "PHASE3.1-SPEC.md erratum E9 item 2 makes the accepted transport residue " +
    "conditional on EVERY branch on this class sitting strictly ABOVE a submit " +
    "(being wrong then costs free round trips; below a submit it costs a " +
    "resubmission decision). If your new branch is below one, E9 item 2 must be " +
    "revisited BEFORE it ships. If it is above one, say so here and update the " +
    "count.";

  function sourceFiles(): readonly string[] {
    return readdirSync(new URL("../src/", import.meta.url), {
      recursive: true,
      encoding: "utf8",
    })
      .map((name) => name.replaceAll("\\", "/"))
      .filter((name) => name.endsWith(".ts"))
      .sort();
  }

  function read(relative: string): string {
    return readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");
  }

  /**
   * Comments are not branches (PHASE3.1-FIXREVIEW4 I1).
   *
   * The first version of this tripwire scanned raw source, so a COMMENT naming
   * the symbol inside the submit window false-alarmed while three real branch
   * forms went silent. A tripwire that cries at prose and sleeps through code
   * trains the next author to edit the expectation rather than think about it,
   * which is worse than no tripwire. Crude on purpose — it only has to stop
   * comments and strings from counting as control flow.
   */
  function stripComments(source: string): string {
    return source
      .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
      .replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  }

  it("pins EVERY branch form on the class, not just `===` (I1)", () => {
    // I1: the original scan saw `=== "INFRASTRUCTURE_ERROR"` and nothing else,
    // so `!==`, a `switch`/`case`, and `instanceof InfrastructureError` were all
    // invisible — and two of the three typecheck clean. The likeliest Venus
    // below-submit branch is the `!==` form, i.e. exactly the silent one. So the
    // scan is now CLASS-WIDE: any construct that reads the class to decide
    // something must show up here.
    const forms = [
      /[!=]==\s*"INFRASTRUCTURE_ERROR"/g,
      /case\s+"INFRASTRUCTURE_ERROR"/g,
      /instanceof\s+InfrastructureError/g,
    ] as const;

    const sites = sourceFiles().flatMap((file) => {
      const source = stripComments(read(file));
      const hits = forms.flatMap((form) => source.match(form) ?? []);
      return hits.map(() => file);
    });

    // `core/errors.ts` and `core/types.ts` MENTION the class (its definition and
    // the union it belongs to); neither branches on it, which is why they are
    // absent here rather than exempted.
    //
    // THE SECOND `wallet/altana.ts` SITE IS PHASE2.5, AND E9 ITEM 2 IS
    // SATISFIED — updated deliberately, with the argument written down, because
    // PHASE2.5-REVIEW M4 said this tripwire would fire and must never be routed
    // around.
    //
    // The branch is in `nativeDayMeter`'s catch: an `InfrastructureError`
    // (a deadline, a dead endpoint) is re-thrown as itself, and every other
    // mapped class becomes a `ProviderError`, because a `view` call is not the
    // account refusing anything (FIXREVIEW F4).
    //
    // It sits STRICTLY ABOVE EVERY SUBMIT, on both of its paths:
    //
    //   - `POST /agents/:id/trade` calls it in the exposure-increasing branch
    //     BEFORE `executeViaSession`, and being wrong there costs a refused buy
    //     and a rolled-back journal row — never a resubmission decision;
    //   - `GET /agents/:id/owner-view` is a READ and submits nothing at all.
    //
    // The exit path never reaches it: a sell is not gated by F1 and takes no
    // meter read. So the accepted transport residue E9 item 2 describes is
    // unchanged, and item 2 did not need revisiting.
    //
    // THE THIRD `wallet/altana.ts` SITE IS QUANT-GRID R3.4, and E9 item 2 is
    // satisfied for the same reason as the second — deliberately updated here,
    // with the argument written down, because this tripwire exists precisely so
    // a new branch cannot arrive unexamined.
    //
    // The branch is in `readSpendInfos`'s catch, which is `nativeDayMeter`'s
    // catch copied verbatim for the same reason: a `view` call is not the
    // account refusing anything, so an `InfrastructureError` survives as itself
    // and every other mapped class becomes a `ProviderError`.
    //
    // It sits STRICTLY ABOVE EVERY SUBMIT, and on this path there is only one
    // caller: `checkQuantMeters` (`src/quant/execute.ts`), which runs INSIDE
    // `withJobSession` but BEFORE the `intended → submitted` CAS that precedes
    // `executeViaSession`. Being wrong there yields `meter-unreadable`, which
    // the quant execute path treats as a PRE-SUBMIT failure: `markRolledBack`,
    // the action `failed`, the level restored. It can never produce a
    // resubmission decision, because nothing has been submitted when it runs.
    assert.deepEqual(
      sites,
      ["lp/sagas.ts", "wallet/altana.ts", "wallet/altana.ts", "wallet/altana.ts"],
      E9,
    );
  });

  it("pins the CALL SITES of the LP predicate: exactly three, all in the saga driver", () => {
    // The number the safety argument leans on. `isTransientFailure` is a single
    // literal comparison and three BRANCHES: a throw out of `step.build()`, the
    // `restoreSession`/`preflightExecute` block, and the exit plan's fresh-quote
    // catch — the last of which chooses between a retry and a TERMINAL skip that
    // leaves the owner holding a volatile leg, and which both prior passes missed.
    const source = read("lp/sagas.ts");
    const calls = source.match(/(?<!function )isTransientFailure\(/g) ?? [];

    assert.equal(calls.length, 3, E9);
    // And CALLED nowhere else in the tree: the predicate is module-private on
    // purpose, so the three branches above are the whole set. (`src/core/errors.ts`
    // names it in prose, which is the cross-reference, not a call.)
    for (const file of sourceFiles()) {
      if (file === "lp/sagas.ts") continue;
      assert.doesNotMatch(read(file), /isTransientFailure\(/, E9);
    }
  });

  it("pins the one property the condition is about: the SUBMIT's catch does not consult the class", () => {
    // Mechanically checkable, and the half that would actually be unsafe. The
    // submit's own catch is the one place where "was that an outage?" would
    // decide something about a call that may already have landed; PHASE2.4's
    // positional rule says everything inside that window stays UNKNOWN and is
    // never auto-replayed.
    // Comment-stripped (I1): a comment naming the symbol inside this window used
    // to fail this case, which is a false alarm on prose that explains the very
    // rule being pinned.
    const source = stripComments(read("lp/sagas.ts"));
    const submit = source.indexOf("deps.provider.executeViaSession({");
    const ambiguous = source.indexOf("journal.markUnknown(", submit);

    assert.ok(submit > 0 && ambiguous > submit, "the submit and its catch moved");
    assert.doesNotMatch(
      source.slice(submit, ambiguous),
      /isTransientFailure|INFRASTRUCTURE_ERROR/,
      `${E9} The submit's ambiguity catch must classify NOTHING.`,
    );
  });
});
