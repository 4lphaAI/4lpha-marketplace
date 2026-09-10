/**
 * The quant plane's IMPORT BOUNDARY (QUANT-GRID §3.1, R2.12, R3.11, W10, BC11).
 *
 * ─── THE DEMO-MODE LESSON, APPLIED BEFORE IT COSTS ANYTHING ────────────────
 *
 * Demo mode's first boundary said "may not import `src/ops/**`", its test
 * walked only DIRECT imports, and the shared predicates reached `ops/policy`
 * one level down — so the prose and the test agreed with each other and not
 * with the code. Every claim below is therefore about the TRANSITIVE RUNTIME
 * CLOSURE, computed with the same parser demo mode uses (now shared,
 * `test/support/moduleScan.ts`), and a computed specifier is REFUSED rather
 * than ignored.
 *
 * ─── AND THE CAPABILITY SCAN, WHICH A CLOSURE PIN CANNOT DO ────────────────
 *
 * A closure pin answers "does A reach B". It cannot answer "does A reach B's
 * `open` function BY NAME, and does nothing re-export it under another name" —
 * and a single `export { open as decrypt } from "./envelope.js"` would widen
 * the set of files that can decrypt a client's session without changing any
 * closure at all. R3.11 is that second question; the mutation tests at the
 * bottom prove the scan catches each bypass form.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { scanImportClauses, scanModuleLoads } from "./support/moduleScan.js";

const SRC_ROOT = path.resolve(
  new URL("../src/", import.meta.url).pathname.replace(/^\//u, ""),
);

const norm = (value: string): string => value.split(path.sep).join("/");

/**
 * Modules whose reach would mean quant code can become something it is not.
 *
 * A quant job is NOT a marketplace agent, and this list is what stops it from
 * becoming one by import.
 */
const QUANT_FORBIDDEN = [
  "store/agents.ts",
  "auth/",
  "killswitch/",
  "lp/sagas.ts",
  "lp/open.ts",
  "lp/worker.ts",
  "trade/execute.ts",
  "trade/worker.ts",
  "lending/",
  "venus/",
  "server.ts",
  "index-server.ts",
  "demo/",
] as const;

/** What `grid.ts` and `envelope.ts` may reach: arithmetic and nothing else. */
const PURE_ALLOWED = new Set(["core/types.ts", "ops/relayFee.ts"]);

async function walkClosure(entries: readonly string[]): Promise<{
  readonly seen: Set<string>;
  readonly bare: Set<string>;
}> {
  const seen = new Set<string>();
  const bare = new Set<string>();

  async function walk(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      return;
    }
    const loads = scanModuleLoads(source);
    const computed = loads.filter((load) => load.kind === "computed").length;
    if (computed > 0) {
      // ONE exception, named rather than pattern-matched: `store/sql.ts` loads
      // the `pg` driver through a variable on purpose. Anything else is refused.
      const isSqlDriverLoad = norm(file).endsWith("/src/store/sql.ts")
        && computed === 1
        && /=\s*"pg"/u.test(source);
      assert.ok(
        isSqlDriverLoad,
        `${file} loads a module through a computed specifier the boundary cannot follow`,
      );
    }
    for (const load of loads) {
      if (load.kind !== "literal") continue;
      if (!load.specifier.startsWith(".")) { bare.add(load.specifier); continue; }
      await walk(norm(path.resolve(
        path.dirname(file), load.specifier.replace(/\.js$/u, ".ts"),
      )));
    }
  }

  for (const entry of entries) await walk(entry);
  return { seen, bare };
}

async function quantSources(): Promise<readonly string[]> {
  const dir = norm(path.join(SRC_ROOT, "quant"));
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(norm(path.join(dir, entry.name)));
  }
  return out.sort();
}

describe("quant import boundary — the whole plane", () => {
  it("reaches NOTHING that could turn a quant job into a marketplace agent", async () => {
    const files = await quantSources();
    assert.ok(files.length >= 8, `expected src/quant to hold the module set, saw ${files.length}`);
    const { seen } = await walkClosure([
      ...files, norm(path.join(SRC_ROOT, "store", "quantJobs.ts")),
    ]);
    const outside = [...seen]
      .map((file) => norm(file).replace(`${norm(SRC_ROOT)}/`, ""))
      .filter((file) => !file.startsWith("quant/") && file !== "store/quantJobs.ts")
      .sort();
    for (const module of outside) {
      for (const forbidden of QUANT_FORBIDDEN) {
        assert.ok(
          !module.startsWith(forbidden),
          `src/quant reaches ${module} at runtime, which this phase forbids`,
        );
      }
    }
  });

  it("`src/server.ts` gains ZERO lines — this phase adds no HTTP route", async () => {
    const source = await readFile(norm(path.join(SRC_ROOT, "server.ts")), "utf8");
    // Named checks, not a bare /quant/i: the file legitimately contains the
    // word "quantity" in several LP comments, and a test that fails on prose is
    // a test nobody keeps.
    for (const load of scanModuleLoads(source)) {
      assert.equal(
        load.kind === "literal" && /(^|\/)quant\//u.test(load.specifier), false,
        "src/server.ts must not import the quant plane; §11 declares no route",
      );
    }
    assert.equal(
      source.includes("quantTrade"), false,
      "src/server.ts must not name the quant journal kind; there is no quant route",
    );
    assert.equal(source.includes("QUANT_ENABLED"), false);
  });

  it("nothing OUTSIDE `src/quant` imports the quant plane at runtime", async () => {
    // The plane is reached only by its own composition roots (`scripts/`), so a
    // `src/` module importing it would be a new trust boundary nobody reviewed.
    const offenders: string[] = [];
    async function sweep(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = norm(path.join(dir, entry.name));
        if (entry.isDirectory()) { await sweep(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = full.replace(`${norm(SRC_ROOT)}/`, "");
        if (relative.startsWith("quant/")) continue;
        const source = await readFile(full, "utf8");
        for (const load of scanModuleLoads(source)) {
          if (load.kind === "literal" && /(^|\/)quant\//u.test(load.specifier)) {
            offenders.push(`${relative} → ${load.specifier}`);
          }
        }
      }
    }
    await sweep(SRC_ROOT);
    assert.deepEqual(offenders, []);
  });
});

describe("quant import boundary — the pure modules", () => {
  it("`grid.ts` reaches only arithmetic", async () => {
    const { seen } = await walkClosure([norm(path.join(SRC_ROOT, "quant", "grid.ts"))]);
    const outside = [...seen]
      .map((file) => norm(file).replace(`${norm(SRC_ROOT)}/`, ""))
      .filter((file) => !file.startsWith("quant/"))
      .sort();
    for (const module of outside) {
      assert.ok(PURE_ALLOWED.has(module), `grid.ts reaches ${module}`);
    }
  });

  it("`envelope.ts` reaches NOTHING in src/ at all", async () => {
    const { seen, bare } = await walkClosure([
      norm(path.join(SRC_ROOT, "quant", "envelope.ts")),
    ]);
    const outside = [...seen]
      .map((file) => norm(file).replace(`${norm(SRC_ROOT)}/`, ""))
      .filter((file) => !file.startsWith("quant/"));
    assert.deepEqual(outside, []);
    // `node:crypto` only — zero dependencies, which is why a golden vector can
    // be the whole correctness argument.
    assert.deepEqual([...bare].sort(), ["node:crypto"]);
  });
});

describe("quant capability scan (R3.11 / BC11)", () => {
  const ENVELOPE = /(^|\/)envelope\.js$/u;
  const SECRETS = new Set(["open", "deriveKeypair"]);
  // R3.11 permits exactly these two. What SHIPS is narrower still — `open` is
  // named only by `admission.ts` and `deriveKeypair` only by `execute.ts` — and
  // the assertion is a SUBSET check so that narrowing is preserved rather than
  // forced open by the test.
  const ALLOWED_IMPORTERS = new Set(["quant/execute.ts", "quant/admission.ts"]);

  it("`open` and `deriveKeypair` are imported BY NAME from exactly two files", async () => {
    const importers = new Set<string>();
    async function sweep(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = norm(path.join(dir, entry.name));
        if (entry.isDirectory()) { await sweep(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = full.replace(`${norm(SRC_ROOT)}/`, "");
        const source = await readFile(full, "utf8");
        for (const clause of scanImportClauses(source)) {
          if (!ENVELOPE.test(clause.specifier)) continue;
          assert.equal(
            clause.reExport && clause.namespace, false,
            `${relative} re-exports the envelope module wholesale`,
          );
          if (clause.reExport) {
            for (const binding of clause.named) {
              assert.equal(
                SECRETS.has(binding.imported), false,
                `${relative} re-exports ${binding.imported} (an alias is still a door)`,
              );
            }
            continue;
          }
          assert.equal(
            clause.namespace, false,
            `${relative} namespace-imports the envelope module`,
          );
          for (const binding of clause.named) {
            if (!SECRETS.has(binding.imported)) continue;
            importers.add(relative);
          }
        }
      }
    }
    await sweep(SRC_ROOT);
    assert.ok(importers.size > 0, "the secrets must be reachable by SOMETHING");
    for (const importer of importers) {
      assert.ok(ALLOWED_IMPORTERS.has(importer), `${importer} imports an envelope secret`);
    }
  });

  it("the ONE wrapper each secret is reached through is pinned to its module", async () => {
    // `admission.ts` names `open` and exports `openSession`; `execute.ts` names
    // `deriveKeypair` and exports `quantKeypairFromSeed`. Both wrappers are a
    // WIDER surface than the primitive, so their importers are pinned too.
    const admission = await readFile(
      norm(path.join(SRC_ROOT, "quant", "admission.ts")), "utf8",
    );
    const execute = await readFile(norm(path.join(SRC_ROOT, "quant", "execute.ts")), "utf8");
    assert.ok(admission.includes("import { open,"), "admission.ts must name `open`");
    assert.ok(
      execute.includes("import { deriveKeypair,"), "execute.ts must name `deriveKeypair`",
    );
    const openSessionImporters: string[] = [];
    async function sweep(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = norm(path.join(dir, entry.name));
        if (entry.isDirectory()) { await sweep(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = full.replace(`${norm(SRC_ROOT)}/`, "");
        const source = await readFile(full, "utf8");
        for (const clause of scanImportClauses(source)) {
          if (!clause.specifier.endsWith("/admission.js")) continue;
          if (clause.named.some((binding) => binding.imported === "openSession")) {
            openSessionImporters.push(relative);
          }
        }
      }
    }
    await sweep(SRC_ROOT);
    assert.deepEqual(
      openSessionImporters.sort(), ["quant/execute.ts", "quant/worker.ts"],
      "openSession's importers are execute (per action) and worker (admission, BC12)",
    );
  });

  it("the COMPOSITION ROOTS import neither secret", async () => {
    const scriptsRoot = path.resolve(
      new URL("../scripts/", import.meta.url).pathname.replace(/^\//u, ""),
    );
    for (const name of ["quant-worker.ts", "live-quant.ts", "quantWorkerDeps.ts"]) {
      const source = await readFile(norm(path.join(scriptsRoot, name)), "utf8");
      for (const clause of scanImportClauses(source)) {
        if (!ENVELOPE.test(clause.specifier)) continue;
        for (const binding of clause.named) {
          assert.equal(
            SECRETS.has(binding.imported), false,
            `scripts/${name} imports ${binding.imported}; a composition root must not`,
          );
        }
        assert.equal(clause.namespace, false, `scripts/${name} namespace-imports the envelope`);
      }
    }
  });

  it("catches every bypass form the scan must refuse (mutation tests)", () => {
    const bypasses: readonly (readonly [string, string])[] = [
      ["alias re-export", 'export { open as decrypt } from "./envelope.js";'],
      ["star re-export", 'export * from "./envelope.js";'],
      ["namespace import", 'import * as envelope from "./envelope.js";'],
      ["named re-export", 'export { deriveKeypair } from "./envelope.js";'],
      ["aliased import", 'import { open as unseal } from "./envelope.js";'],
    ];
    for (const [label, source] of bypasses) {
      const clauses = scanImportClauses(source).filter(
        (clause) => ENVELOPE.test(clause.specifier),
      );
      assert.equal(clauses.length, 1, `the scanner missed: ${label}`);
      const clause = clauses[0]!;
      const reachesSecret = clause.namespace
        || clause.named.some((binding) => SECRETS.has(binding.imported));
      assert.equal(reachesSecret, true, `the scanner did not see the secret in: ${label}`);
    }
  });

  it("does NOT flag an unrelated import of the module's public surface", () => {
    const clauses = scanImportClauses('import { seal, QUANT_ENVELOPE_ALGORITHM } from "./envelope.js";');
    const clause = clauses[0]!;
    assert.equal(clause.namespace, false);
    assert.equal(clause.named.some((binding) => SECRETS.has(binding.imported)), false);
  });

  it("ignores the two forms TypeScript ERASES", () => {
    for (const source of [
      'import type { QuantEnvelope } from "./envelope.js";',
      'export type { QuantKeypair } from "./envelope.js";',
    ]) {
      const clause = scanImportClauses(source)[0]!;
      assert.equal(clause.typeOnly, true);
      assert.deepEqual(scanModuleLoads(source), []);
    }
  });
});
