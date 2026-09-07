import { lpPrepareDiagnosticBootstrapOutcome, printableLpPrepareDiagnosticOutcome } from "./prepareDiagnostic.js";

export async function runLpPrepareDiagnosticBootstrap(input: {
  readonly config: () => Promise<void>;
  readonly readSession: () => Promise<void>;
  readonly infrastructure: () => Promise<void>;
  readonly prepare: () => Promise<void>;
  readonly write: (line: string) => void;
}): Promise<void> {
  try { await input.config(); } catch { input.write(render("config")); return; }
  try { await input.readSession(); } catch { input.write(render("read-session")); return; }
  try { await input.infrastructure(); } catch { input.write(render("read-only-infrastructure")); return; }
  await input.prepare();
}
function render(family: "config" | "read-session" | "read-only-infrastructure"): string {
  return JSON.stringify(printableLpPrepareDiagnosticOutcome(lpPrepareDiagnosticBootstrapOutcome(family)));
}
