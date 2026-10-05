import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgenticInstance } from "./domain.js";
import type { AgenticStore } from "./store.js";
import type { BawRunner } from "./baw.js";

export async function readAgenticHostIdentity(): Promise<{ machineId: string; osBootMarker: string } | null> {
  try {
    if (process.platform !== "win32") {
      const [machine, boot] = await Promise.all([readFile("/etc/machine-id", "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      return machine.trim() && boot.trim() ? { machineId: machine.trim(), osBootMarker: boot.trim() } : null;
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],
      { timeout: 10_000, windowsHide: true }, (error, output) => error === null ? resolve(output) : reject(new Error("AGENTIC_HOST_IDENTITY")));
    });
    const [machineId, osBootMarker] = stdout.trim().split(/\r?\n/).map(s => s.trim());
    return machineId && osBootMarker && Number.isFinite(Date.parse(osBootMarker)) ? { machineId, osBootMarker } : null;
  } catch { return null; }
}

export class AgenticInstanceManager {
  readonly row: AgenticInstance;
  readonly #store: AgenticStore;
  readonly #runner: BawRunner;
  readonly #exit: (code: number) => void;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #heartbeatTask: Promise<void> | null = null;
  #lastHeartbeat = process.hrtime.bigint();
  #stopping = false;
  #dispatches = 0;
  readonly #waiters = new Set<() => void>();

  private constructor(row: AgenticInstance, store: AgenticStore, runner: BawRunner, exit: (code: number) => void) {
    this.row = row; this.#store = store; this.#runner = runner; this.#exit = exit;
  }
  static async start(store: AgenticStore, runner: BawRunner, service: AgenticInstance["service"],
    identity: Awaited<ReturnType<typeof readAgenticHostIdentity>> | undefined = undefined, env: NodeJS.ProcessEnv = process.env,
    exit: (code: number) => void = code => { process.exit(code); }): Promise<AgenticInstanceManager> {
    if (identity === undefined) identity = await readAgenticHostIdentity();
    const deployment = env["RAILWAY_DEPLOYMENT_ID"] || null;
    if (deployment === null && identity === null) throw new Error("AGENTIC_HOST_IDENTITY");
    const now = await store.now();
    const row: AgenticInstance = { instanceId: randomUUID(), service, host: hostname(), pid: process.pid,
      machineId: identity?.machineId ?? null, osBootMarker: identity?.osBootMarker ?? null,
      railwayDeploymentId: deployment, railwayReplicaId: env["RAILWAY_REPLICA_ID"] || null,
      bootAt: now, heartbeatAt: now, retiredAt: null, retiredBy: null };
    await store.registerInstance(row);
    const manager = new AgenticInstanceManager(row, store, runner, exit);
    manager.#heartbeat = setInterval(() => { if (manager.#heartbeatTask === null) manager.#heartbeatTask = manager.heartbeat().catch(() => undefined).finally(() => { manager.#heartbeatTask = null; }); }, 10_000);
    return manager;
  }
  get canClaim(): boolean { return !this.#stopping && this.row.service !== "execution-api" && Number(process.hrtime.bigint() - this.#lastHeartbeat) < 30_000_000_000; }
  get inFlight(): number { return this.#dispatches; }
  stopClaiming(): void { this.#stopping = true; }
  beginDispatch(): void { if (!this.canClaim) throw new Error("AGENTIC_INSTANCE_NOT_LIVE"); this.#dispatches += 1; }
  endDispatch(): void {
    this.#dispatches -= 1;
    if (this.#dispatches === 0) for (const resolve of this.#waiters) resolve();
  }
  async heartbeat(): Promise<void> {
    if (!await this.#store.heartbeat(this.row.instanceId)) {
      this.#stopping = true; this.#runner.killChildren();
      if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
      this.#heartbeat = null; this.#exit(70); return;
    }
    this.#lastHeartbeat = process.hrtime.bigint();
  }
  async finish(): Promise<void> {
    this.stopClaiming();
    if (this.#dispatches !== 0) await new Promise<void>(resolve => this.#waiters.add(resolve));
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    await this.#heartbeatTask;
    await this.#store.retire(this.row.instanceId, "exit");
  }
}

export function agenticQuiescence(instance: AgenticInstance, claimedAt: number, current: { machineId: string | null; osBootMarker: string | null },
  input: { deploymentStopped?: string; attest?: string }): { kind: "graceful-exit" | "deployment-stopped" | "host-rebooted"; evidence: unknown } | null {
  if (instance.retiredBy === "exit") return { kind: "graceful-exit", evidence: instance };
  if (instance.railwayDeploymentId !== null) return input.deploymentStopped === instance.railwayDeploymentId && input.attest?.trim()
    ? { kind: "deployment-stopped", evidence: { instance, attest: input.attest } } : null;
  if (current.machineId === null || current.machineId !== instance.machineId || current.osBootMarker === null
    || instance.osBootMarker === null || current.osBootMarker === instance.osBootMarker
    || process.platform === "win32" && !(Date.parse(current.osBootMarker) > claimedAt)) return null;
  return { kind: "host-rebooted", evidence: { instance, observedBootMarker: current.osBootMarker } };
}
