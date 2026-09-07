import { pathToFileURL } from "node:url";
import { identityMain } from "../src/identity/entry.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await identityMain(process.argv.slice(2));
