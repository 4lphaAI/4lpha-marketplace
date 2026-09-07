import { getAddress } from "viem";
import type { AgentRecord } from "./agents.js";
import { decodeJsonb } from "./codec.js";
import { validateSessionSpec } from "../core/session.js";
import { canonicalEncode } from "../auth/canonical.js";
import type { SessionSpec } from "../core/types.js";
import type { SqlClient } from "./sql.js";
import { categoryForPreset, decodeIdentity, fail, isObject, newIdentity, validIdentity, type IdentityCategory, type IdentitySources, type IdentitySource, type Erc8004IdentitySummary, type IdentityFence } from "../identity/types.js";

export const IDENTITY_AGENT_MIGRATION = `alter table agents add column if not exists erc8004_identity jsonb`;
export const IDENTITY_AGENT_INDEX = `create unique index if not exists agents_erc8004_ref on agents ((erc8004_identity->>'publicRef')) where erc8004_identity is not null`;

function verifiedSessionFacts(value: unknown): boolean {
  try {
    if (!isObject(value) || !isObject(value.spec) || !isObject(value.permissions) || typeof value.publicKey !== "string"
      || !/^0x(?:04)?[0-9a-fA-F]{128}$/.test(value.publicKey) || !Number.isSafeInteger(value.expiry) || (value.expiry as number) <= 0
      || value.spec.expiresAt !== value.expiry) return false;
    // Enrollment checks the persisted grant shape; expiry does not erase a verified historical session.
    return canonicalEncode(validateSessionSpec(value.spec as SessionSpec, { nowSeconds: (value.expiry as number) - 3600 })) === canonicalEncode(value.permissions);
  } catch { return false; }
}

export function sourceFromRecord(agent: AgentRecord): IdentitySource {
  const facts = agent.sessionFacts;
  return { id: agent.id, owner: agent.ownerAddress, identity: agent.erc8004Identity ?? null, existingId: agent.erc8004AgentId,
    category: categoryForPreset(facts?.hireSizing?.name), eligible: (agent.status === "armed" || agent.status === "paused") && agent.sessionStateDecodeMismatch !== true && verifiedSessionFacts(facts) };
}
type SourceRow = { id: string; owner_address: string; status: string; session_facts: unknown; http_runtime_profile: string; erc8004_agent_id: string | null; erc8004_identity: unknown; identity_absent: boolean };
const COLUMNS = "id, owner_address, status, session_facts, http_runtime_profile, erc8004_agent_id, erc8004_identity, erc8004_identity is null as identity_absent";
function fromRow(row: SourceRow): IdentitySource {
  const facts = decodeJsonb(row.session_facts);
  const sizing = isObject(facts) && isObject(facts.hireSizing) ? facts.hireSizing : null;
  return { id: row.id, owner: getAddress(row.owner_address), existingId: row.erc8004_agent_id, identity: decodeIdentity(row.erc8004_identity, row.identity_absent),
    category: categoryForPreset(sizing?.name), eligible: (row.status === "armed" || row.status === "paused") && verifiedSessionFacts(facts) };
}
export function projectionAllowed(source: IdentitySource, next: Erc8004IdentitySummary): boolean {
  const old = source.identity;
  return validIdentity(old) && validIdentity(decodeIdentity(next, false)) && old.publicRef === next.publicRef && old.category === next.category
    && next.revision === old.revision + 1 && (source.existingId === null || source.existingId === next.agentId);
}
/** SELECT-only construction, no AgentStore factory, customer keys, or DDL. */
export class PostgresIdentitySources implements IdentitySources {
  constructor(readonly sql: SqlClient) {}
  async get(id: string): Promise<IdentitySource | null> {
    const result = await this.sql.query<SourceRow>(`/* erc8004.source */ select ${COLUMNS} from agents where id=$1`, [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async enrolled(afterId = ""): Promise<readonly IdentitySource[]> {
    const result = await this.sql.query<SourceRow>(`/* erc8004.outbox */ select ${COLUMNS} from agents where erc8004_identity is not null and id collate "C">$1 order by id collate "C" limit 100`, [afterId]);
    return result.rows.map(fromRow);
  }
  async enroll(id: string, category?: IdentityCategory): Promise<IdentitySource> {
    return this.sql.transaction(async (tx) => {
      const result = await tx.query<SourceRow>(`/* erc8004.enrollRead */ select ${COLUMNS} from agents where id=$1 for update`, [id]);
      const row = result.rows[0]; if (!row) fail("not_found");
      const source = fromRow(row);
      if (source.identity !== null || source.existingId !== null) fail("conflict");
      // Legacy inference needs explicit category and matching immutable runtime facts.
      const selected = source.category ?? (category === "trading" && row.http_runtime_profile === "trade-v1" ? "trading" : (category === "lp" || category === "grid") && row.http_runtime_profile === "lp-v1" ? category : null);
      if (!source.eligible || selected === null || category !== undefined && category !== selected) fail("ineligible");
      const identity = newIdentity(selected);
      const updated = await tx.query<{ id: string }>(`/* erc8004.enroll */ update agents set erc8004_identity=$3::jsonb where id=$1 and owner_address=$2 and erc8004_identity is null and erc8004_agent_id is null and status in ('armed','paused') returning id`, [id, source.owner.toLowerCase(), JSON.stringify(identity)]);
      if (!updated.rows[0]) fail("conflict");
      return { ...source, category: selected, identity };
    });
  }
  async project(source: IdentitySource, next: Erc8004IdentitySummary, fence: IdentityFence): Promise<boolean> {
    if (!projectionAllowed(source, next)) return false;
    fence.check();
    return this.sql.transaction(async (tx) => {
      fence.check();
      const result = await tx.query<{ id: string }>(`/* erc8004.project */ update agents set erc8004_identity=$5::jsonb,
        erc8004_agent_id=case when $6::text is null then erc8004_agent_id else $6 end
        where id=$1 and owner_address=$2 and erc8004_identity->>'publicRef'=$3
          and erc8004_identity=$4::jsonb and (erc8004_agent_id is null or erc8004_agent_id=$7)
        returning id`, [source.id, source.owner.toLowerCase(), next.publicRef, JSON.stringify(source.identity), JSON.stringify(next), next.status === "registered" ? next.agentId : null, next.agentId]);
      fence.check();
      return result.rows.length === 1;
    });
  }
}
