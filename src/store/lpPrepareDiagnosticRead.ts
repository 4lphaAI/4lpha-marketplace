/** Read-only, narrow session scope for the D1 relay diagnostic. */
import { getAddress, type Hex } from "viem";
import {
  parseSessionRevocationEvidence,
  type AgentCaps,
  type AgentRecord,
  type AgentStatus,
  type SessionFacts,
} from "./agents.js";
import type { SessionRevocationEvidenceV1 } from "../account/keyStoreReader.js";
import { decodeJsonb } from "./codec.js";
import { decryptSecret, loadMasterKey } from "./crypto.js";
import { createPgSqlClient } from "./sql.js";
import { parseHttpRuntimeProfile } from "../auth/runtimeAuth.js";

type DiagnosticAgentRow = {
  readonly id: string;
  readonly owner_address: string;
  readonly wallet_address: string;
  readonly custody_model: AgentRecord["custodyModel"];
  readonly session_facts: unknown | null;
  readonly session_revocation: unknown | null;
  readonly caps: unknown | null;
  readonly status: AgentStatus;
  readonly http_runtime_profile: string;
  readonly erc8004_agent_id: string | null;
  readonly pending_grant: unknown | null;
  readonly row_version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly session_key_ciphertext: string | null;
};

export type LpPrepareDiagnosticAgent = {
  readonly agent: AgentRecord;
  readonly sessionPrivateKey: Hex;
};

export function lpPrepareDiagnosticRevocation(
  raw: unknown | null,
  sessionKeyPresent: boolean,
): SessionRevocationEvidenceV1 | null {
  const proof = raw === null ? null : parseSessionRevocationEvidence(decodeJsonb(raw));
  if (raw !== null && proof === null) {
    throw new Error("Agent session revocation proof is malformed.");
  }
  if (proof !== null && sessionKeyPresent) {
    throw new Error("Agent session integrity is corrupt: revocation proof and session key coexist.");
  }
  return proof;
}

/**
 * Decrypts exactly one persisted key inside the callback and closes the read
 * connection afterwards.  It exports no writer and never returns the key.
 */
export async function withLpPrepareDiagnosticAgent<T>(
  agentId: string,
  use: (value: LpPrepareDiagnosticAgent) => Promise<T>,
): Promise<T> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") throw new Error("DATABASE_URL is required for the LP prepare diagnostic.");
  const masterKey = loadMasterKey();
  if (masterKey === null) throw new Error("EXECUTION_MASTER_KEY is required to read the persisted session key.");
  const sql = await createPgSqlClient(databaseUrl);
  try {
    const result = await sql.query<DiagnosticAgentRow>(
      `/* lp-prepare-diagnostic.read */
       select id, owner_address, wallet_address, custody_model, session_facts, session_revocation, caps, status, http_runtime_profile,
              erc8004_agent_id, pending_grant, row_version, created_at, updated_at, session_key_ciphertext
       from agents where id = $1`, [agentId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Agent "${agentId}" not found.`);
    const sessionRevocation = lpPrepareDiagnosticRevocation(
      row.session_revocation,
      row.session_key_ciphertext !== null,
    );
    if (row.session_facts === null || row.session_key_ciphertext === null) {
      throw new Error("Agent has no persisted LP session and key.");
    }
    const agent: AgentRecord = {
      id: row.id,
      ownerAddress: getAddress(row.owner_address),
      walletAddress: getAddress(row.wallet_address),
      custodyModel: row.custody_model,
      sessionFacts: decodeJsonb(row.session_facts) as SessionFacts,
      sessionRevocation,
      caps: row.caps === null ? null : decodeJsonb(row.caps) as AgentCaps,
      status: row.status,
      httpRuntimeProfile: parseHttpRuntimeProfile(row.http_runtime_profile),
      erc8004AgentId: row.erc8004_agent_id,
      pendingGrant: row.pending_grant === null ? null : decodeJsonb(row.pending_grant) as AgentRecord["pendingGrant"],
      rowVersion: row.row_version,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
    const sessionPrivateKey = decryptSecret(row.session_key_ciphertext, masterKey) as Hex;
    return await use({ agent, sessionPrivateKey });
  } finally {
    await sql.close();
  }
}
