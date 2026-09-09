import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TUTORIAL_LINKS, TUTORIAL_PLAYLIST } from "./tutorials";

/* The deploy screen indexes `TUTORIAL_LINKS` with the same `id` it uses for
   `GUIDE_LINKS`, and two of those ids do not read as the product name
   (`trading`, `health`). A wrong key would compile to `undefined` only if the
   record were partial, so pin the keys AND the destinations here — a tutorial
   pointing at the wrong agent is the kind of mistake nobody notices until a
   judge clicks it. */
describe("tutorial links", () => {
  it("covers exactly the four deploy-screen agent ids", () => {
    expect(Object.keys(TUTORIAL_LINKS).sort()).toEqual(["grid", "health", "lp", "trading"]);
  });

  it("points each agent at the video the operator supplied", () => {
    expect(TUTORIAL_LINKS.grid).toBe("https://youtu.be/I5uyElPdtfo?si=kzmUTp45ZGnL7WSi");
    expect(TUTORIAL_LINKS.trading).toBe("https://youtu.be/Y1jobkuKXH8?si=abHJClYnCnZ30rys");
    expect(TUTORIAL_LINKS.lp).toBe("https://youtu.be/1uIeKGeg1no?si=WnNGoAryx3VNMxLR");
    expect(TUTORIAL_LINKS.health).toBe("https://youtu.be/I7wxbKY0-ac?si=ddjQBC7IBw0qpfSC");
  });

  it("gives every link a distinct https destination", () => {
    const all = [TUTORIAL_PLAYLIST, ...Object.values(TUTORIAL_LINKS)];
    for (const url of all) expect(new URL(url).protocol).toBe("https:");
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps the deploy screen and header on this one source", () => {
    const deploy = readFileSync("components/screens/DeployAgentScreen.tsx", "utf8");
    const header = readFileSync("components/screens/KitHeader.tsx", "utf8");
    expect(deploy).toContain("TUTORIAL_LINKS[id]");
    expect(header).toContain("TUTORIAL_PLAYLIST");
    // No hard-coded video URL may reappear beside the shared record.
    expect(deploy).not.toContain("youtu");
    expect(header).not.toContain("youtu");
  });
});
