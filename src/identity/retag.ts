import type { SqlClient } from "../store/sql.js";
import { decodeJsonb } from "../store/codec.js";
import { categoryForHire, decodeIdentity, fail, validIdentity, type IdentityCategory, type IdentityFence } from "./types.js";

type AgentRow = { id: string; owner_address: string; status: string; erc8004_identity: unknown };
export type RetagResult = { readonly apply: boolean; readonly rows: readonly {
  readonly id: string; readonly status: string; readonly from: "trading"; readonly to: IdentityCategory;
  readonly action: "retag" | "would-retag" | `skip:${string}`;
}[] };

export async function retagTradfi(sql: SqlClient, apply: boolean, acquireFence: () => Promise<IdentityFence>): Promise<RetagResult> {
  const fence = await acquireFence();
  try {
    return await sql.transaction(async (tx) => {
      fence.check();
      const selected = await tx.query<AgentRow>(`/* retag.agents */ select a.id,a.owner_address,a.status,a.erc8004_identity from agents a
        where a.erc8004_identity->>'status'='pending' and a.erc8004_identity->>'category'='trading'
          and a.erc8004_agent_id is null and not exists (select 1 from erc8004_jobs j
            where j.public_ref=a.erc8004_identity->>'publicRef'
              or (lower(j.owner_address)=lower(a.owner_address) and j.source_id=a.id))
        order by a.id collate "C" for update of a`);
      const rows: RetagResult["rows"][number][] = [];
      for (const row of selected.rows) {
        fence.check();
        const identity = decodeIdentity(row.erc8004_identity, false);
        if (!validIdentity(identity) || identity.status !== "pending" || identity.category !== "trading") continue;
        const settings = await tx.query<{ params: unknown }>(`/* retag.settings */ select params from trade_settings where agent_id=$1 and lower(owner_address)=lower($2)`, [row.id, row.owner_address]);
        const category = categoryForHire("trade-v1", decodeJsonb(settings.rows[0]?.params))!;
        let action: RetagResult["rows"][number]["action"] = settings.rows.length === 0 ? "skip:no-settings" : category === "trading" ? "skip:not-tradfi" : "would-retag";
        if (category !== "trading" && apply) {
          if (!Number.isSafeInteger(identity.revision + 1)) fail("invalid_identity");
          fence.check();
          const updated = await tx.query<{ id: string }>(`/* retag.update */ update agents set erc8004_identity=$3::jsonb
            where id=$1 and owner_address=$2 and erc8004_identity=$4::jsonb and erc8004_agent_id is null returning id`,
          [row.id, row.owner_address, JSON.stringify({ ...identity, category, revision: identity.revision + 1 }), JSON.stringify(row.erc8004_identity)]);
          action = updated.rows.length === 1 ? "retag" : "skip:cas-miss";
        }
        rows.push({ id: row.id, status: row.status, from: "trading", to: category, action });
      }
      fence.check();
      return { apply, rows };
    });
  } finally { await fence.close(); }
}
