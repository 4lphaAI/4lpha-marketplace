/** Journal-state matrix for operator receipt proofs; it never causes a write. */
export function quantRebalanceJournalProofAllowed(input: {
  readonly journalState: string;
  readonly proof: "success" | "failure";
  readonly proofSource: "calls-id-read" | "tx";
  readonly matchedStoredTransaction: boolean;
  readonly storedTransactionPresent: boolean;
}): boolean {
  if (input.journalState === "ROLLED_BACK") return input.proof === "failure" && input.matchedStoredTransaction;
  if (input.journalState === "COMMITTED") {
    return input.matchedStoredTransaction || !input.storedTransactionPresent
      && (input.proofSource === "calls-id-read" || input.proofSource === "tx");
  }
  return ["PENDING", "IN_PROGRESS", "UNKNOWN"].includes(input.journalState);
}
