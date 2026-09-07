import { pathToFileURL } from "node:url";
import { minterMigrationMain } from "../src/identity/minterMigrationEntry.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await minterMigrationMain(process.argv.slice(2));
}
