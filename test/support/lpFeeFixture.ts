import type { LpSagaDeps } from "../../src/lp/sagas.js";
import { MemoryLpFeeEventStore, type LpFeeEvent } from "../../src/store/lpFeeEvents.js";

export function withFeeRecording<D extends LpSagaDeps>(deps: D, tokenIds: readonly string[], fail = false) {
  class Store extends MemoryLpFeeEventStore {
    attempts = 0;
    override async recordReceipt(rows: readonly LpFeeEvent[]): Promise<void> {
      this.attempts++;
      if (fail) throw new Error("fee store offline");
      await super.recordReceipt(rows);
    }
  }
  const store = new Store();
  const instrumented: D = { ...deps, feeEvents: store, receipts: { ...deps.receipts,
    // Keep class fake methods' receivers intact.
    collectAmounts: deps.receipts.collectAmounts.bind(deps.receipts),
    swapAmounts: deps.receipts.swapAmounts.bind(deps.receipts),
    mintedTokenId: deps.receipts.mintedTokenId.bind(deps.receipts),
    ...(deps.receipts.mintedTokenIds ? { mintedTokenIds: deps.receipts.mintedTokenIds.bind(deps.receipts) } : {}),
    ...(deps.receipts.expectedPoolSwap ? { expectedPoolSwap: deps.receipts.expectedPoolSwap.bind(deps.receipts) } : {}),
    ...(deps.receipts.mintAmounts ? { mintAmounts: deps.receipts.mintAmounts.bind(deps.receipts) } : {}),
    feeEvents: async () => ({ blockNumber: 100n, byTokenId: new Map(tokenIds.map(id => [id, { collected0: 110n, collected1: 220n, decreased0: 100n, decreased1: 200n }])) }),
  } };
  return { deps: instrumented, store };
}
