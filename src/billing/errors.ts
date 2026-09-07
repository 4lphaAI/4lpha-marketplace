export const BILLING_ERROR_TABLE = Object.freeze({
  BILLING_DISABLED: { code: "billing_disabled", status: 503, retryable: false, resolution: "operator_config" },
  BILLING_PAUSED: { code: "billing_paused", status: 409, retryable: false, resolution: "owner_action" },
  BILLING_REVOKED: { code: "billing_revoked", status: 409, retryable: false, resolution: "owner_action" },
  PAYMENT_DUE: { code: "payment_due", status: 409, retryable: false, resolution: "top_up_bnb" },
  EXPOSURE_LIMIT: { code: "exposure_limit", status: 409, retryable: false, resolution: "wait_for_window" },
  IDEMPOTENCY_CONFLICT: { code: "idempotency_conflict", status: 409, retryable: false, resolution: "none" },
  RUNTIME_AUTH_FAILED: { code: "runtime_auth_failed", status: 401, retryable: false, resolution: "none" },
  VENDOR_PAYMENT_REFUSED: { code: "vendor_payment_refused", status: 502, retryable: false, resolution: "operator_reconcile" },
  BILLING_EVIDENCE_UNKNOWN: { code: "billing_evidence_unknown", status: 409, retryable: false, resolution: "operator_reconcile" },
  ORACLE_UNAVAILABLE: { code: "oracle_unavailable", status: 503, retryable: true, resolution: "none" },
  ORACLE_STALE: { code: "oracle_stale", status: 503, retryable: true, resolution: "none" },
  SEQUENCER_UNAVAILABLE: { code: "sequencer_unavailable", status: 503, retryable: true, resolution: "none" },
  BILLING_SESSION_INVALID: { code: "billing_session_invalid", status: 409, retryable: false, resolution: "owner_action" },
  BILLING_COLLECTION_UNKNOWN: { code: "billing_collection_unknown", status: 409, retryable: false, resolution: "operator_reconcile" },
  MODEL_NOT_ALLOWED: { code: "model_not_allowed", status: 400, retryable: false, resolution: "owner_action" },
  MODEL_MANIFEST_DRIFT: { code: "model_manifest_drift", status: 503, retryable: false, resolution: "operator_config" },
  STREAM_LIMIT: { code: "stream_limit", status: 502, retryable: false, resolution: "operator_reconcile" },
} as const);

export type BillingInternalReason = keyof typeof BILLING_ERROR_TABLE;
export type BillingErrorCode = (typeof BILLING_ERROR_TABLE)[BillingInternalReason]["code"];
export type BillingResolution = (typeof BILLING_ERROR_TABLE)[BillingInternalReason]["resolution"];
export type BillingErrorStatus = (typeof BILLING_ERROR_TABLE)[BillingInternalReason]["status"];

export type BillingErrorBody = Readonly<{
  data: null;
  error: Readonly<{ code: BillingErrorCode; message?: string }>;
  meta: Readonly<{ retryable: boolean; resolution: BillingResolution }>;
}>;

export function billingError(reason: BillingInternalReason, message?: string): Readonly<{
  status: BillingErrorStatus;
  body: BillingErrorBody;
}> {
  const row = BILLING_ERROR_TABLE[reason];
  const safeMessage = message?.replace(/[\r\n\t]/g, " ").slice(0, 280);
  return {
    status: row.status,
    body: {
      data: null,
      error: { code: row.code, ...(safeMessage === undefined || safeMessage === "" ? {} : { message: safeMessage }) },
      meta: { retryable: row.retryable, resolution: row.resolution },
    },
  };
}

export function billingReasonFromError(error: unknown): BillingInternalReason {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("BILLING_PAUSED")) return "BILLING_PAUSED";
  if (message.includes("BILLING_REVOKED")) return "BILLING_REVOKED";
  if (message.includes("PAYMENT_DUE")) return "PAYMENT_DUE";
  if (message.includes("EXPOSURE_LIMIT")) return "EXPOSURE_LIMIT";
  if (message.includes("IDEMPOTENCY_CONFLICT")) return "IDEMPOTENCY_CONFLICT";
  if (message.includes("VENDOR_PAYMENT_REFUSED")) return "VENDOR_PAYMENT_REFUSED";
  if (message.includes("BILLING_EVIDENCE_UNKNOWN")) return "BILLING_EVIDENCE_UNKNOWN";
  if (message.includes("ORACLE_STALE")) return "ORACLE_STALE";
  if (message.includes("ORACLE_UNAVAILABLE")) return "ORACLE_UNAVAILABLE";
  if (message.includes("SEQUENCER_UNAVAILABLE")) return "SEQUENCER_UNAVAILABLE";
  if (message.includes("BILLING_SESSION_INVALID")) return "BILLING_SESSION_INVALID";
  if (message.includes("BILLING_COLLECTION_UNKNOWN")) return "BILLING_COLLECTION_UNKNOWN";
  if (message.includes("MODEL_NOT_ALLOWED")) return "MODEL_NOT_ALLOWED";
  if (message.includes("MODEL_MANIFEST_DRIFT")) return "MODEL_MANIFEST_DRIFT";
  if (message.includes("STREAM_LIMIT")) return "STREAM_LIMIT";
  return "RUNTIME_AUTH_FAILED";
}
