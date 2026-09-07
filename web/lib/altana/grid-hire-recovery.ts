import type { OwnerActionEnvelope } from "../exec/owner-action";
import type { HireSessionView } from "./hire-state";

export const GRID_HIRE_STORAGE_KEY = "4lpha:grid-hire:v1";
type HireStorage = Pick<Storage, "getItem" | "removeItem">;

export function cancellationRecorded(view: HireSessionView | null): boolean {
  return view?.status === "retired" || (view?.status === "provisioning" && view.cancelRequested === true);
}

/** A response for another hire must never erase the current tab's pointer. */
export function forgetHire(
  storage: HireStorage,
  agentId: string,
  storageKey: string = GRID_HIRE_STORAGE_KEY,
): void {
  const saved = storage.getItem(storageKey);
  if (saved === agentId) { storage.removeItem(storageKey); return; }
  if (storageKey !== "4lpha:trade-hire:v2" || saved === null) return;
  try {
    const record: unknown = JSON.parse(saved);
    if (record !== null && typeof record === "object" && "agentId" in record && record.agentId === agentId) storage.removeItem(storageKey);
  } catch { /* A malformed pointer is not proof it belongs to this hire. */ }
}

export function forgetGridHire(storage: HireStorage, agentId: string): void {
  forgetHire(storage, agentId, GRID_HIRE_STORAGE_KEY);
}

export function cancellationMessage(view: HireSessionView): string {
  if (view.status === "retired") return "This hire has expired and is retired. You can start a new hire.";
  if (view.revocationRequired === true) return "Cancellation recorded. This agent will not activate. Its record stays in Account until expiry; you can start a new hire now. Session authority was detected on chain and still needs revoking.";
  return "Cancellation recorded. This agent will not activate. Its record stays in Account until expiry; you can start a new hire now.";
}

export async function cancelGridHire(input: {
  readonly agentId: string;
  readonly signEnvelope: (action: string, agentId: string, params: unknown) => Promise<OwnerActionEnvelope>;
  readonly storage: HireStorage;
  readonly storageKey?: string;
  readonly fetcher?: typeof fetch;
}): Promise<HireSessionView> {
  const envelope = await input.signEnvelope("cancelProvisioning", input.agentId, {});
  const response = await (input.fetcher ?? fetch)(`/api/agents/${encodeURIComponent(input.agentId)}/session/cancel`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
  });
  const payload = await response.json() as { data?: HireSessionView; error?: { message?: string; code?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`);
  if (payload.data === undefined || !cancellationRecorded(payload.data)) {
    throw new Error("Cancellation is not confirmed. Refresh this hire and try again.");
  }
  forgetHire(input.storage, input.agentId, input.storageKey);
  return payload.data;
}

export class GridDeployStopped extends Error {
  constructor() { super("Deploy stopped. You can continue the setup or cancel the hire."); }
}

/** Stops local continuations, never claims to retract a submitted wallet action. */
export class GridDeployRun {
  private readonly controller = new AbortController();
  get stopped(): boolean { return this.controller.signal.aborted; }
  stop(): void { this.controller.abort(); }
  check(): void { if (this.stopped) throw new GridDeployStopped(); }
  guarded<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise((resolve, reject) => {
      const onStop = () => reject(new GridDeployStopped());
      this.controller.signal.addEventListener("abort", onStop, { once: true });
      void Promise.resolve().then(() => { this.check(); return action(); }).then((value) => {
        this.controller.signal.removeEventListener("abort", onStop);
        if (this.stopped) reject(new GridDeployStopped()); else resolve(value);
      }, (error: unknown) => {
        this.controller.signal.removeEventListener("abort", onStop);
        reject(error);
      });
    });
  }
  wait(ms: number): Promise<void> {
    this.check();
    return new Promise((resolve, reject) => {
      const onStop = () => { clearTimeout(timer); reject(new GridDeployStopped()); };
      const timer = setTimeout(() => {
        this.controller.signal.removeEventListener("abort", onStop);
        resolve();
      }, ms);
      this.controller.signal.addEventListener("abort", onStop, { once: true });
    });
  }
}
