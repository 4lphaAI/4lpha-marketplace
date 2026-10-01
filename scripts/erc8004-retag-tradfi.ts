import { getAddress, type Address } from "viem";
import { databaseUrl } from "../src/identity/config.js";
import { createIdentityFence } from "../src/identity/fence.js";
import { retagTradfi } from "../src/identity/retag.js";
import { errorCode, fail, REGISTRY } from "../src/identity/types.js";
import { createPgSqlClient } from "../src/store/sql.js";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== "--apply") fail("arguments_invalid");
  const url = databaseUrl(process.env);
  let minter: Address;
  try { minter = getAddress(process.env.ERC8004_MINTER_ADDRESS ?? ""); } catch { fail("invalid_config"); }
  if (minter === "0x0000000000000000000000000000000000000000") fail("invalid_config");
  const sql = await createPgSqlClient(url);
  try {
    const data = await retagTradfi(sql, args.length === 1, () => createIdentityFence(url, { chainId: 56, registry: REGISTRY, minter }));
    process.stdout.write(`${JSON.stringify({ data })}\n`);
  } finally { await sql.close(); }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ data: null, error: { code: errorCode(error) } })}\n`);
  process.exitCode = 1;
}
