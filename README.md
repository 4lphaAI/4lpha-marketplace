# 4lpha-execution

The execution plane for the 4lpha BNB Chain agent marketplace.

The marketplace decides *what* an agent should do. This service is the only
component that can make it *happen on-chain* — and the only one that has to be
trustworthy about custody. Phase 0 ships the wallet and session layer plus a
live spike that answers the custody design questions with running proof.

**Status: Phase 1b-api.** Phase 0 (the wallet/session layer plus the live
custody spike) is complete and audited — see [FINDINGS.md](./FINDINGS.md) for
what it established and which claims are verified by transaction. Phase 1a added
the durable **storage substrate** the autonomous service runs on: a v2 provider
interface, a multi-tenant agent store, and an idempotent execution journal.
Phase 1b-core added the **authorization core** — a shared canonical encoder and
paramsHash binding, an EIP-712 owner-action verifier, a single-use nonce store,
a per-agent/global kill switch, and the one execute-authorization decision
function. Phase 1b-api puts an **HTTP service** in front of all of it: three
auth layers, the money path, and the operator controls, with the whole API
surface verified offline.

## The custody problem

A user hires an agent. The agent then needs to move the user's money without
the user approving every trade, and without 4lpha ever being able to take that
money or being required to stay alive for the user to get it back.

The design goal Phase 0 exists to test:

> If our server disappears and the agent's key is lost with it, the user's own
> key alone must still be able to revoke the agent's authority and withdraw
> every remaining fund.

Verified answer: **yes**, and more cheaply than expected — see
[FINDINGS.md](./FINDINGS.md) (a) and (b). An Altana wallet *is* the owner's own
EOA, upgraded in place under EIP-7702. The recovery path in this repo therefore
does not use the Altana SDK at all: it is plain viem against a public RPC.

## Architecture

```
 marketplace / agent runtime
            │
            │  SessionSpec  (allowlist + spend caps + expiry)
            ▼
 ┌────────────────────────────────────────────┐
 │ src/core          provider-agnostic seam   │
 │   types.ts        WalletProvider, errors   │
 │   session.ts      policy validation        │
 │   errors.ts       sanitize + classify      │
 └────────────────────────────────────────────┘
            │  implemented by
            ▼
 ┌────────────────────────────────────────────┐
 │ src/wallet/altana.ts     AltanaProvider    │
 │                                            │
 │  grant / execute / revoke ──► Altana relay │
 │  ownerRecover             ──► public RPC   │◄── no relay, no server,
 │  ownerRevokeSessionDirect ──► public RPC   │    no agent key
 └────────────────────────────────────────────┘
            │
            ▼
   BNB Chain  ·  AltanaKeyStore + IthacaAccount (EIP-7702)
```

Two properties are load-bearing:

- **`src/core` imports no wallet SDK.** Swapping Altana for another provider,
  or adding the vault fallback, means writing one new file behind
  `WalletProvider`.
- **The recovery methods deliberately bypass our own abstraction stack.** They
  talk to the chain directly, because their entire purpose is to work when
  everything else is gone.

### Custody topology

Phase 0 settled on one wallet per **user**, with one scoped session per hired
**agent** — not one wallet per agent. An Altana wallet's address is its admin
signer's EOA address, so a per-agent wallet would be owned by the agent's key,
which is exactly the arrangement that fails the design goal. Budget isolation
between agents comes from per-session spend caps; if hard asset isolation is
ever required, see the HD-derivation option in FINDINGS.md (g).

## Layout

```
src/core/types.ts    WalletProvider interface, SessionSpec, typed errors
src/core/session.ts  policy validation and translation (pure)
src/core/errors.ts   provider-error sanitization and classification (pure)
src/wallet/altana.ts AltanaProvider, plus the relay-independent recovery path
src/wallet/registry.ts  provider-per-chain registry (createProviderRegistry)
src/wallet/abis.ts   KeyStore / account / ERC-20 ABI fragments
src/store/agents.ts  multi-tenant agent store (memory + Postgres)
src/store/journal.ts execution journal + startup reconcile (memory + Postgres)
src/store/crypto.ts  AES-256-GCM envelope for session keys at rest
src/store/codec.ts   bigint-safe jsonb codec
src/store/sql.ts     the narrow SQL seam; runtime-only pg binding
src/store/nonces.ts  single-use owner-action nonces (memory + Postgres)
src/auth/canonical.ts   the one canonical encoder + paramsHash binding
src/auth/ownerAuth.ts   EIP-712 owner-action verifier and domain constructor
src/auth/executeDecision.ts  the execute boundary + idempotency keys
src/killswitch/killswitch.ts per-agent pause and global halt
src/server.ts        the HTTP app — pure createServer(deps), never listens
src/index-server.ts  the process entry: env, stores, reconcile, listen
src/http/wire.ts     request parsing and response views (the wire boundary)
src/http/limits.ts   rate limiter and per-agent execute throttle
src/clients/dataPlane.ts  the ONLY third-party-data dependency (chain state comes from the pinned RPC)
scripts/spike-altana.ts  the Phase 0 live spike
scripts/spike/           spike infrastructure (env, state, reporting, drill)
test/                offline unit tests (node:test, no network)
```

## Storage substrate (Phase 1a)

Three durable layers turn the Phase 0 primitives into something a long-running
service can crash and resume without losing money or double-spending. Each has a
memory implementation (dev/tests) and a Postgres implementation, chosen by
`DATABASE_URL`; the connection string is never logged.

- **Provider v2** (`src/core/types.ts`, `src/wallet/altana.ts`). The interface
  grows the methods durability needs: `restoreSession` rebuilds a live session
  from persisted facts with no gas and no network; `awaitExecution` resolves a
  crashed-mid-execute call by polling the relay instead of re-submitting;
  `isSessionActive` reports registration-and-expiry honestly; `ownerRevokeSession`
  is the relay-independent kill switch with a read-back verdict; and a FAILED
  execute now carries a `failureCode` (the SDK never throws for it). A
  provider-per-chain registry exists so a second chain is a new entry, not a
  rewrite.

- **Agent store** (`src/store/agents.ts`). One row per hired agent, every query
  scoped by a normalized `owner_address` — a cross-tenant read returns `null`,
  never another user's row. The session key lives in its own column, AES-256-GCM
  encrypted under `EXECUTION_MASTER_KEY`, and is returned only by the explicit
  `getAgentSessionKey`; the Postgres store refuses to persist a key with no
  master key configured. `session_facts` holds the byte-exact canonical
  permissions `restoreSession` needs.

- **Execution journal** (`src/store/journal.ts`). The idempotency key is the
  primary key: a repeated `begin` returns the existing row and never re-runs.
  Two golden properties ported from the reference LP journal — outcomes are
  READ BACK from authoritative state (never inferred from a receipt), and any
  ambiguous crash window resolves to **UNKNOWN and is held**, never
  auto-replayed. A startup `reconcile` pass resolves non-terminal rows via
  `awaitExecution` / `isSessionActive` (both pure reads), committing, rolling
  back, or parking each — never submitting anything.

A minimal executor health surface (`putExecutorHealth` / `getExecutorHealth`)
gives 1b's operator controls a liveness signal.

## HTTP service (Phase 1b-api)

`createServer(deps)` is pure — it never binds a port, so the entire API is driven
offline with `app.request(...)` and a frozen clock. `src/index-server.ts` is the
only impure part: it reads the environment, builds the durable stores, runs the
startup `reconcile` pass **before** serving, listens, and shuts down cleanly.

**PRIVATE NETWORK ONLY.** The service ships no CORS handling by design. The
intended path is owner browser → the 4alpha app → this execution plane; it must
never be exposed to the internet, and a browser must never reach it directly.

### Four auth layers, four different questions

| Layer | Credential | Answers |
|---|---|---|
| 1 | `x-exec-token` | *Is the caller one of our own services?* Every route but `/health`. Authenticates a SERVICE, **not** a tenant. |
| 2 | `x-runtime-assertion` | *Which assigned agent, profile, operation and parsed request may the runtime perform?* Short-lived Ed25519, request-bound and replay-consumed. |
| 3 | owner EIP-712 | *Which tenant, and did they really ask?* The owner comes from the RECOVERED signer — never from a body, query or path. |
| 4 | `x-operator-token` | *Is this us, the operator?* Global halt/resume only, which are cross-tenant by definition. Every use is audit-logged. |

| Route | Auth |
|---|---|
| `GET /health` | none (platform probe) |
| `GET /status` | exec token |
| `GET /agents/:id` (runtime read) | exec token + runtime assertion (`agentRead`) |
| `POST /agents/:id/execute` (raw calls) | exec token + runtime assertion (`executeRaw`) — **off by default**, see `EXECUTE_RAW_ENABLED` |
| `POST /agents/:id/trade` | exec token + runtime assertion (`trade`) — no per-trade owner signature |
| `GET /agents`, `GET /agents/:id/owner-view` | exec token + owner sig (`read`) |
| `POST /agents/:id/pause`, `/unpause`, `/change-budget`, `/revoke`, `/runtime-profile` | exec token + owner sig |
| `POST /admin/halt`, `/admin/resume` | exec token + operator token |

Owner reads carry their signed envelope base64url-encoded in an `x-owner-action`
header rather than a query string: a signature is a credential, and query strings
land in access logs, proxy logs and browser history.

### Layer 2 has two backends: private key, and passkey

A wallet owner cannot be a browser EOA — FINDINGS (a): the SDK has no working
injected-signer path — so the two working owners are a raw private key and a
**passkey**. Both sit behind the one `Verifier` seam and the verification logic
above them is identical; dispatch is by shape, `size(signature) === 65` to
secp256k1 and anything else to WebAuthn, so the wire envelope did not change.

A passkey assertion is ABI-encoded into the existing `signature` field and its
**challenge is the EIP-712 digest** (purpose-tagged and versioned), so chainId
separation, env-salt separation, `paramsHash` binding and the per-request nonce
all transfer with no second signing format. Owner identity is DERIVED from the
credential's public key, which the envelope carries, so there is no credential
store on the server — and the ordinary recovered-vs-declared match is what makes
carrying an attacker-supplied key safe.

| Variable | Default | Effect |
|---|---|---|
| `PASSKEY_ENABLED` | `false` | Off means the WebAuthn branch refuses before parsing — Phase 1b behaviour verbatim. A value that is neither `true` nor `false` fails the boot. |
| `PASSKEY_RP_ID` | — | Bare registrable domain. Must be a suffix of every origin's host, or the boot fails. |
| `PASSKEY_ORIGINS` | — | Up to 4 EXACT serialized origins, comma separated. `https://4lpha.app/` (trailing slash) and any `*` fail the boot. |
| `PASSKEY_UV_REQUIRED` | `true` | Requires the signed user-verified flag. `false` logs a custody-downgrade warning. |
| `PASSKEY_ALLOW_INSECURE_ORIGINS` | `false` | Permits `http://localhost:<port>` / `http://127.0.0.1:<port>` for development only. |

Misconfiguration **fails the boot**, never the request. The alternative — a
silent per-request refusal — produces a server that passes `/health`, serves
every private-key owner correctly, and answers every passkey owner with the same
generic error a forgery gets.

**Two boundaries worth reading before you enable it**, both written down in
`src/auth/passkeyVerifier.ts`: the authenticator displays the relying party and
never the action, so script execution on an allowlisted origin is equivalent to
owner authority; and `PASSKEY_RP_ID` must be an RP ID at which no other ceremony
signs a caller-supplied challenge, or that ceremony is a signing oracle for owner
actions here.

A passkey-owned agent's row is created by `npm run register-passkey`, which
derives the owner address from the credential key, writes
`custodyModel: "passkey"`, and performs **no on-chain grant** — the grant is
signed by the passkey in the marketplace UI. A passkey `ownerAddress` is an
IDENTITY, not an account: no secp256k1 key exists for it, `ownerRecoverNative`
refuses that custody model outright, and `owner-view` reports
`ownerAddressIsPayable: false` so a UI cannot render it as a withdrawal target.

### Autonomous runtime authorization

`POST /agents/:id/trade` and enabled raw `/execute` take **no per-request owner
signature**. That is the point of a
scoped session — the owner authorized the agent once, on-chain, and the agent
then runs unattended. The consequence is that the execute path has no signer to
derive tenancy from, so **tenancy comes from the persisted row**: the server
loads the agent by id and treats `row.ownerAddress` as authoritative for the
session-key lookup, the kill-switch scope and the journal. Nothing in the request
can influence it. A second credential, `x-runtime-assertion`, binds that row to
one issuer, audience, owner, HTTP runtime profile, operation, parsed request,
nonce and at most 60-second window. The dedicated replay store consumes the
nonce before journal, throttle, key or provider access.

What a leaked `x-exec-token` **alone can do**: none of the three autonomous
runtime operations. A valid runtime assertion is also required. What it cannot
do remains broader: move funds outside an agent's on-chain policy (the account
contract refuses, and
`bypassLocalPolicyCheck` is hard-coded `false` and unreachable from any request
field); pause, revoke, re-budget or read an owner's full view (all need the
owner's key); halt globally (needs the operator credential); or drain a cap
period in a burst.

`HttpRuntimeProfile` is deliberately one-directional and closed: `trade-v1`
allows read+trade, `raw-v1` read+raw, while `lp-v1`, `venus-v1` and
`unbound-v1` allow only the runtime read. It does not gate owner-signed LP/Venus
routes or their in-process workers. Existing migrated rows default unbound and
can be bound once by their owner to `trade-v1`, `lp-v1` or `venus-v1`; ordinary
binding can never authorize raw.

Every configured runtime verification key is still a global cross-tenant money
authority. The managed issuer must choose claims from authenticated server-side
assignments and must not expose a caller-chosen signing endpoint. That issuer is
a separate public-launch spec/build/audit boundary; this server-side phase
closes the leaked-shared-bearer path, not a malicious or confused issuer.

### The honest caveat: `approve` and the raw route

The trade session template grants `approve(address,uint256)` **with no target
constraint**, because the tokens an agent will trade are not knowable at grant
time. State the consequence plainly, because the natural assumption is the
opposite one: **approvals are not bounded by the spend caps.** A cap limits
value *leaving* the wallet in a call; `approve` moves nothing, it authorizes a
later `transferFrom` executed in a transaction this session is not a party to and
this server never sees. A capped session can hand out an uncapped allowance.

What actually bounds it is a list, and every item has to hold:

1. this server holds the session key and no route hands it out;
2. the trade route **hardcodes the spender** — the venue, from config or from the
   data-plane read, never a request field;
3. `POST /agents/:id/execute`, which accepts raw calldata and therefore *would*
   let a caller choose the spender, is **disabled by default**
   (`EXECUTE_RAW_ENABLED`, an ordinary 404 when off);
4. `assertTargetsAllowed` evaluates the allowlist per call, so a bare-selector
   rule no longer switches the local pre-flight off for everything else;
5. trade sessions expire within 24 hours.

Turning `EXECUTE_RAW_ENABLED=true` on a wallet holding tokens the agent did not
buy removes item 3 for a caller that also holds a valid `raw-v1` assertion. A
leaked shared bearer alone is insufficient, but compromise of the raw-profile
runtime issuer/session remains capable of approving and draining granted
tokens; raw therefore stays an exceptional, default-off surface.

### Venues and caller-supplied routes

`POST /agents/:id/trade` takes `venue: "pancake" | "pancake_v3" | "fourmeme"` and
an optional `route`:

```jsonc
"route": {
  "hops": ["0x…"],   // intermediates between WBNB and `token`, max 2, in order
  "fees": [500, 2500] // V3 ONLY, REQUIRED there: one tier per pool
}
```

Which pool, which fee tier, which intermediate — every one of those is a market
judgement, so every one of them is **supplied by the caller**, exactly as `venue`
already is. This service validates and executes a route; it never searches for a
better one, never picks a fee tier, and never inserts a hop nobody asked for.
There is no default tier for that reason: `pancake_v3` without `fees` is a 400.

The route is given in ONE orientation, `WBNB → …hops → token`, for both sides,
and **a sell is the exact reverse of the buy — tokens and fee tiers together.** A
`route` is legal only on the two pancake venues; on `fourmeme` it is a 400, even
empty, because a field that is accepted and ignored is a field the caller
believes did something. Every hop runs the same address blacklist `token` runs,
and `route` is folded into `paramsHash`: two trades with the same amounts down
different routes are different trades.

Two honest limits:

- **`pancake_v3` does not support fee-on-transfer tokens, in either direction.**
  The V2 builders use the `SupportingFeeOnTransferTokens` variants because meme
  tokens routinely tax transfers. V3 has no such variant — the pool measures its
  own balance delta and reverts on a taxed transfer — so for exactly the token
  class Phase 2 targeted, V3 is unusable. A taxed token is a `pancake` trade or
  no trade; this service does not fall back between venues, because choosing the
  venue is the caller's judgement.
- **V3 does not unblock the graduated-Four.Meme case.** The live example
  `0x964f…ffff` has no V3 pool at any tier, against WBNB or against its quote
  token. Multi-hop **V2** is what reaches it. V3 exists here for the two
  bStocks that have only V3 pools.

### The other honest caveat: `route` widens the sell side

The `approve` blast radius is unchanged by routing — the spender is still the
resolved router, the amount still exact, no new approval exists. The sell side is
what widened. Before, a sell could only go through the canonical `token/WBNB`
pair; now a caller holding `x-exec-token` can name an arbitrary intermediate, so
a real position can be pushed through an attacker-controlled pool in one call,
with the caller's own `minOutWei`/`quotedOutWei` as the only floor. The scan gate
does not run on sells (by design) and does not evaluate hops at all.

The bound is the same one that already bounds a garbage `token` on a buy: this
server holds the session key, the recipient is always the row's wallet, and the
native spend caps bound native outflow. Say the last part exactly:
**native caps do NOT bound token outflow on a sell.**

### The nonce ↔ idempotency contract

Owner mutations follow one order, and it is the order that makes retries and
replays distinguishable without inspecting the request:

1. compute `ownerActionIdempotencyKey(signed)` — pure, no crypto needed;
2. **look the journal up first.** A row means this exact signed action already
   arrived: return its stored outcome, re-verify nothing, touch no nonce;
3. only with no row, `authorizeOwnerAction` — verify, rate-limit the recovered
   owner (`beforeNonceConsume`, so a refusal costs no nonce), then consume;
4. `journal.begin` under that key, act, mark terminal.

A replay of a *different* signature carrying an already-spent nonce hashes to a
different key, finds no row at step 2, reaches step 3, and `consume` refuses it.

`read` is the one owner action that is verified but **not** nonce-consumed: a
replayed read causes no second side effect, while consuming would break a
legitimate retry.

### Revoke is honest about its halves

The server holds no owner key, so it **cannot** revoke on-chain and does not
claim to. `POST /agents/:id/revoke` does the half it can guarantee — sets the
agent revoked, engages the kill switch, journals a `revoke` row so a crash
reconciles — and returns the **unsigned** account-level and KeyStore calls the
owner's client must sign and broadcast, marked
`state: "pending_owner_broadcast"`.

### Error taxonomy

Two ambiguities are deliberate. `not_found` (404) is returned byte-identically
for an unknown agent and for one owned by somebody else, so the endpoint cannot
be used to enumerate agent ids. `owner_auth_failed` (401) is the *only* code any
signature problem produces — forged, expired, replayed, wrong chain, wrong
params, wrong action, malformed — so it cannot be used to learn which check
failed. A policy rejection at execute is not an HTTP error at all: it is a 200
with `ExecutionReceipt{ status: "FAILED", failureCode }`. Every error body passes
through `sanitizeMessage` as its final step.

## Running the spike

```bash
npm install
npm run spike
```

The spike is **resumable**. It records each step's verdict in
`.spike-state.json` (gitignored, public data only) and writes generated test
keys to `.env` (gitignored, never printed). Steps that already passed are
skipped on a re-run.

Resumption is bound to one owner and one network. The state file records the
owner address it was written for, and a run whose owner differs **aborts**
rather than inheriting verdicts about a key it has never touched — "step 6
already revoked that session" is only true of the session that was actually
revoked. Mainnet uses a separate file (`.spike-state.mainnet.json`) for the
same reason.

Generated keys are never silently replaced: writing over a variable that
already holds a value is refused unless `SPIKE_ROTATE_KEY=<VAR>` names it,
because whatever the old address holds would become unreachable. A write that
`.env.local` or a process env var would shadow is reported as an error rather
than leaving a file that looks updated and changes nothing.

Steps 0 and 1 need no gas and run immediately. Everything from step 3 on needs
testnet BNB, so the spike stops at a funding gate, prints the address to fund
and exits 0. Fund the printed address at
<https://testnet.bnbchain.org/faucet-smart> (CAPTCHA required) and re-run.

> The SDK ships a `fundNative()` helper that looks like it automates this. It
> does not work on chain 97 — it returns a successful transaction hash for a
> call that transfers nothing. See FINDINGS.md (f).

| Step | What it proves |
| --- | --- |
| 0 | Keys exist and the owner is funded |
| 1 | Whether the user's own EOA can be the wallet's root authority — no gas |
| 2 | N/A by design: the wallet *is* the owner's EOA, so there is nothing to fund |
| 3 | A scoped session can be granted, and how many owner signatures it costs |
| 4 | An in-scope call executes under the session key |
| 5 | Out-of-scope target and over-cap amount are both rejected on-chain |
| 6 | The owner key **alone** revokes the session, with no relay and no agent key |
| 7 | The revoked session can no longer execute |
| 8 | The owner key **alone** sweeps every remaining fund |

Steps 6 and 8 run in `scripts/spike/serverDeathDrill.ts`, whose input type
carries no session signer and no relay client. The module boundary is the
proof that the drill cannot have cheated.

Step 5 only passes when the rejection maps to the RIGHT reason — `NOT_ALLOWED`
for the off-allowlist target, `CAP_EXCEEDED` for the over-cap amount. A call
rejected because the relay was down or the wallet ran dry says nothing about
session scoping, and a step that accepts any rejection is a step that passes
whatever the account contract does.

### Running against mainnet (real funds)

```bash
SPIKE_NETWORK=mainnet \
SPIKE_CONFIRM_MAINNET=i-understand-real-funds \
npm run spike
```

Everything here is irreversible and paid for in real BNB, so:

- **`SPIKE_CONFIRM_MAINNET` is required verbatim.** Without it the run aborts
  before touching the chain. `SPIKE_NETWORK` alone is one stale shell export
  away from spending money.
- **The owner key must be operator-supplied** in `.env.local`, via
  `USER1_PRIVATE_KEY` or whatever `SPIKE_OWNER_KEY_VAR` names. It is never
  generated: a silently generated stand-in would make every mainnet result
  meaningless.
- **Targets are recoverable, not burn addresses.** The in-scope call sends dust
  to the session key's own EOA (whose key is in `.env`), the out-of-scope probe
  targets the owner's own address, and the step 8 sweep goes back to the owner.
  The only unrecoverable cost is gas.
- **Probe amounts are scaled so the cap probe is falsifiable** at the accepted
  funding level: the over-cap amount must be affordable, or step 5b is rejected
  for insufficient balance and proves nothing about caps. The spike asserts
  this at startup.
- Total cost of a full mainnet run so far: ~0.0017 BNB.

`SPIKE_RPC_URL` overrides the endpoint list for either network. The provider
verifies an endpoint's chain id before signing anything and rotates past ones
that are unreachable or answer for the wrong chain.

## Commands

```bash
npm run typecheck    # tsc --noEmit, strict
npm test             # node:test, offline
npm run build        # emit dist/
npm run serve        # run the HTTP service from source (tsx)
npm start            # run the built HTTP service from dist/
npm run spike        # the Phase 0 live spike
```

`serve` and `start` load `.env` via Node's `--env-file-if-exists`; `.env.local`
is the operator's file and is never read or written by this repo.

## Later phases

Phase 1+ adds trade, LP, and Venus operations as call builders that produce
`WalletCall[]` and run through `executeViaSession`. They inherit session
scoping for free: a strategy is only ever as dangerous as the allowlist and
caps the user granted it.

## Trading universe and market evidence

Blue Chip and Sigma support up to **69 tokens per newly granted session**.
Selection interleaves asset groups instead of letting global daily volume fill
every slot with tokenized equities. Mid-Cap and Degen retain their 25-token
maximum. A session's addresses remain fixed after hire; this is not a daily
permission refresh, and existing sessions gain no additional authority.

Entry and conditional LLM exits can consume the existing data plane's fresh
15-minute and hourly EMA, ATR, ROC and relative-volume evidence. Pool, token,
currency and timestamps are validated before use. Missing or stale evidence
falls back to the existing snapshot prompt. Owner-requested exits, stop-loss,
take-profit and maximum-hold rules run before optional feature reads.

The larger pin retains per-token approve/spend permissions and native exit
reserves. It does not increase an owner's signed cap. Availability of fewer
eligible assets can produce a smaller pin. Feature coverage is limited to the
data plane's existing reference pools, not every granted token.

An offline comparison helper is available:

```bash
node --import tsx scripts/compare-trade-evidence.ts path/to/research.json
```

It compares recorded baseline, rule-only and rule-plus-LLM selections with
matched per-trade inputs. Quotes, supplied verified outcomes, estimated costs
and missing evidence remain distinct. Fixture tests do not establish improved
returns. Trailing, risk-based sizing and rotation are not part of this update.
