const [subcommand] = process.argv.slice(2);
if (subcommand === "prepare-diagnostic") {
  await import("./live-lp-prepare-diagnostic.js");
} else {
  await import("./live-lp.js");
}
