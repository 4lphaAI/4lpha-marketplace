/**
 * Console reporting for the spike. One line per verdict, evidence indented
 * beneath it, so a run can be pasted straight into FINDINGS.md.
 */
import { sanitizeMessage } from "../../src/core/errors.js";
import type { StepStatus } from "./state.js";

export function heading(text: string): void {
  process.stdout.write(`\n${text}\n${"-".repeat(text.length)}\n`);
}

export function verdict(
  step: string,
  status: StepStatus,
  note: string,
  evidence: readonly string[] = [],
): void {
  process.stdout.write(`[${status.padEnd(7)}] ${step} — ${note}\n`);
  for (const line of evidence) process.stdout.write(`            ${line}\n`);
}

export function info(text: string): void {
  process.stdout.write(`            ${text}\n`);
}

/** Render an unknown thrown value as a single safe line. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${sanitizeMessage(cause.message)}`;
  }
  return sanitizeMessage(String(cause));
}

export function explorerTx(explorer: string, hash: string): string {
  return `tx ${hash}  (${explorer}/tx/${hash})`;
}
