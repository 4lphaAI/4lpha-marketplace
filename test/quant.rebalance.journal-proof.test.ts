import assert from "node:assert/strict";
import { it } from "node:test";
import { quantRebalanceJournalProofAllowed } from "../src/quant/rebalanceJournalProof.js";

it("allows a matched failed receipt to finish an action after journal terminal crash windows", () => {
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "ROLLED_BACK", proof: "failure", proofSource: "tx", matchedStoredTransaction: true, storedTransactionPresent: true }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "ROLLED_BACK", proof: "success", proofSource: "tx", matchedStoredTransaction: true, storedTransactionPresent: true }), false);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "ROLLED_BACK", proof: "failure", proofSource: "tx", matchedStoredTransaction: false, storedTransactionPresent: true }), false);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "failure", proofSource: "tx", matchedStoredTransaction: true, storedTransactionPresent: true }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "failure", proofSource: "tx", matchedStoredTransaction: false, storedTransactionPresent: true }), false);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "success", proofSource: "tx", matchedStoredTransaction: true, storedTransactionPresent: true }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "failure", proofSource: "calls-id-read", matchedStoredTransaction: false, storedTransactionPresent: false }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "success", proofSource: "calls-id-read", matchedStoredTransaction: false, storedTransactionPresent: false }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "failure", proofSource: "tx", matchedStoredTransaction: false, storedTransactionPresent: false }), true);
  assert.equal(quantRebalanceJournalProofAllowed({ journalState: "COMMITTED", proof: "success", proofSource: "tx", matchedStoredTransaction: false, storedTransactionPresent: false }), true);
});
