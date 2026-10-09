/**
 * The funded-job sweep is an on-chain scan: at most one in flight per process, notifies during a sweep collapse into
 * ONE trailing sweep, and sweep starts are spaced. Signing and the scan are fakes; nothing touches a wallet or chain.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SellerCore, type PendingJobsFetcher, type SigningApi } from "../src/sellerCore.js";

const SPACING_MS = 200;

beforeEach(() => {
  process.env.NOTIFY_SWEEP_MIN_INTERVAL_SECONDS = String(SPACING_MS / 1000);
});
afterEach(() => {
  delete process.env.NOTIFY_SWEEP_MIN_INTERVAL_SECONDS;
});

function signing(submitted: number[]): SigningApi {
  return {
    listPrice: () => 1n,
    clampPrice: (x) => x,
    signQuote: async () => ({}),
    verifySignedJob: async () => ({ ok: true, reason: "", permanent: false }),
    jobSpec: async () => ({ task: "t", terms: {} }),
    submitResult: async (id) => {
      submitted.push(id);
      return { submitTx: "0xtx", deliverableUrl: null };
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

function rig(scans: (call: number) => Promise<Record<string, unknown>>) {
  const starts: number[] = [];
  const submitted: number[] = [];
  const pendingJobs: PendingJobsFetcher = async () => {
    starts.push(performance.now());
    return scans(starts.length);
  };
  const core = new SellerCore({ runWork: async () => "work", generator: "test", network: "bsc-mainnet", signing: signing(submitted), pendingJobs });
  return { core, starts, submitted };
}

describe("sweep coalescing", () => {
  it("N notifies during one sweep run exactly one trailing sweep", async () => {
    const hold = gate();
    const { core, starts } = rig(async (call) => {
      if (call === 1) await hold.promise;
      return { jobs: [] };
    });
    await core.notifyFunded({});
    assert.equal(starts.length, 1, "the first notify starts a sweep at once");
    for (let i = 0; i < 8; i += 1) await core.notifyFunded(i % 2 === 0 ? {} : { job_id: 100 + i });
    assert.equal(starts.length, 1, "no second sweep while the first runs");
    hold.open();
    await core.drain();
    assert.equal(starts.length, 2, "exactly one trailing sweep, not eight");
  });
  it("notifies that arrive during the trailing sweep make exactly one more", async () => {
    const hold = gate();
    const { core, starts } = rig(async (call) => {
      if (call === 2) await hold.promise;
      return { jobs: [] };
    });
    await core.notifyFunded({});
    await core.notifyFunded({}); // collapses into the trailing sweep
    while (starts.length < 2) await new Promise((r) => setTimeout(r, 10));
    await core.notifyFunded({});
    await core.notifyFunded({});
    hold.open();
    await core.drain();
    assert.equal(starts.length, 3);
  });
  it("a job that appears only in the trailing scan is delivered", async () => {
    const hold = gate();
    const { core, starts, submitted } = rig(async (call) => {
      if (call === 1) {
        await hold.promise;
        return { jobs: [] };
      }
      return { jobs: [{ jobId: 7 }] };
    });
    await core.notifyFunded({});
    await core.notifyFunded({}); // a job funded mid-sweep, notified while the scan runs
    hold.open();
    await core.drain();
    assert.equal(starts.length, 2);
    assert.deepEqual(submitted, [7]);
  });
  it("sweep starts are spaced: the trailing sweep waits, it is not dropped", async () => {
    const hold = gate();
    const { core, starts } = rig(async (call) => {
      if (call === 1) await hold.promise;
      return { jobs: [] };
    });
    await core.notifyFunded({});
    await core.notifyFunded({});
    hold.open(); // the first sweep ends at once, well inside the spacing
    await core.drain();
    assert.equal(starts.length, 2);
    assert.ok((starts[1] as number) - (starts[0] as number) >= SPACING_MS - 15, `gap ${(starts[1] as number) - (starts[0] as number)} ms`);
  });
  it("spacing also holds between two separate notifies, and an idle first sweep is not delayed", async () => {
    const { core, starts } = rig(async () => ({ jobs: [] }));
    const t0 = performance.now();
    await core.notifyFunded({});
    await core.drain();
    assert.ok((starts[0] as number) - t0 < SPACING_MS, "the first sweep starts immediately");
    await core.notifyFunded({});
    await core.drain();
    assert.equal(starts.length, 2);
    assert.ok((starts[1] as number) - (starts[0] as number) >= SPACING_MS - 15);
  });
  it("a failing scan does not wedge the loop: the next notify sweeps again", async () => {
    const { core, starts } = rig(async (call) => {
      if (call === 1) throw new Error("rpc down");
      return { jobs: [] };
    });
    await core.notifyFunded({});
    await core.drain();
    await core.notifyFunded({});
    await core.drain();
    assert.equal(starts.length, 2);
  });
});
