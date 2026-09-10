/**
 * The shared module-load scanner used by every import-boundary test.
 *
 * EXTRACTED VERBATIM from `test/demo.plane.test.ts` (QUANT-GRID R2.12 / M4).
 * Nothing about the algorithm changed — only its home — because two boundaries
 * now depend on it (demo mode's "nothing reachable from `src/demo/**` can act",
 * and the quant plane's own closure pin) and two copies of a scanner is exactly
 * how the first version of the demo boundary came to agree with its own prose
 * instead of with the code.
 *
 * Every module a source file LOADS at runtime, found by PARSING it.
 *
 * FIX-REVIEW-2 FINDING 1, and the reviewer's own recommendation: two successive
 * regex versions of this were each defeated within minutes — by `export * from`
 * on a line with a leading statement, by `import ("x")` with a space, by a
 * comment between `import` and its parenthesis. Each patch invited the next
 * bypass, because a regex cannot know what is code, what is a comment and what
 * is a type position.
 *
 * TypeScript's own parser does know. `import type` / `export type` are skipped
 * because the compiler erases them; a dynamic import in a TYPE position is a
 * `LiteralTypeNode` under an `ImportTypeNode`, never a `CallExpression`, so it
 * never reaches the visitor at all — no capitalisation heuristic required. A
 * dynamic import with a non-literal specifier is reported as `computed` rather
 * than dropped, so the caller can refuse it instead of missing it.
 */
import tsModule from "typescript";

/** One module load found in a source file. */
export type ScannedModule =
  | { readonly kind: "literal"; readonly specifier: string }
  /** A dynamic import whose specifier is computed — it cannot be followed. */
  | { readonly kind: "computed" };

export function scanModuleLoads(source: string): ScannedModule[] {
  const ts = tsModule;
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.ESNext, true);
  const found: ScannedModule[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
      const typeOnly =
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true)
        || (ts.isExportDeclaration(node) && node.isTypeOnly);
      const specifier = node.moduleSpecifier;
      if (!typeOnly && specifier !== undefined && ts.isStringLiteral(specifier)) {
        found.push({ kind: "literal", specifier: specifier.text });
      }
      void clause;
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      found.push(
        argument !== undefined && ts.isStringLiteral(argument)
          ? { kind: "literal", specifier: argument.text }
          : { kind: "computed" },
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        found.push({ kind: "literal", specifier: reference.expression.text });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/** The literal specifiers only, for callers that cannot follow a computed load. */
export function scanModuleSpecifiers(source: string): string[] {
  return scanModuleLoads(source).flatMap((load) =>
    load.kind === "literal" ? [load.specifier] : [],
  );
}

/**
 * The parsed IMPORT CLAUSES of a file, for capability scans that care about
 * WHICH binding a module took (QUANT-GRID R3.11 / BC11).
 *
 * A closure pin answers "does A reach B". It cannot answer "does A reach B's
 * `open` function by name, and does nothing re-export it under another name" —
 * which is the question the envelope module's secret functions need, because a
 * single `export { open as decrypt } from "./envelope.js"` would widen the set
 * of files that can decrypt a client's session without changing any closure.
 */
export type ScannedImportClause = {
  readonly specifier: string;
  /** `import * as ns from "x"` — the form a named-import pin must refuse. */
  readonly namespace: boolean;
  /** `import x from "x"` — a default binding. */
  readonly defaultBinding: boolean;
  /** Named bindings, as `{ imported, local }` pairs. */
  readonly named: readonly { readonly imported: string; readonly local: string }[];
  /** True for `export … from "x"` in any form (including `export *`). */
  readonly reExport: boolean;
  /** True for a type-only import/export, which the compiler erases. */
  readonly typeOnly: boolean;
};

export function scanImportClauses(source: string): ScannedImportClause[] {
  const ts = tsModule;
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.ESNext, true);
  const found: ScannedImportClause[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const named: { imported: string; local: string }[] = [];
      let namespace = false;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) namespace = true;
        else {
          for (const element of bindings.elements) {
            named.push({
              imported: (element.propertyName ?? element.name).text,
              local: element.name.text,
            });
          }
        }
      }
      found.push({
        specifier: node.moduleSpecifier.text,
        namespace,
        defaultBinding: clause?.name !== undefined,
        named,
        reExport: false,
        typeOnly: clause?.isTypeOnly === true,
      });
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const named: { imported: string; local: string }[] = [];
      let namespace = false;
      if (clause === undefined) namespace = true; // `export * from "x"`
      else if (ts.isNamespaceExport(clause)) namespace = true;
      else {
        for (const element of clause.elements) {
          named.push({
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
          });
        }
      }
      found.push({
        specifier: node.moduleSpecifier.text,
        namespace,
        defaultBinding: false,
        named,
        reExport: true,
        typeOnly: node.isTypeOnly,
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}
