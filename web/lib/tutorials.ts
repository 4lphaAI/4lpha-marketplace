/* Tutorial video links, operator-supplied 2026-09-09.

   One source of truth for both surfaces that link out to them: the header's
   "Tutorial" nav item (the whole playlist) and the per-agent "Tutorial Videos"
   link on the deploy screen. The keys match `GUIDE_LINKS` in
   `components/screens/DeployAgentScreen.tsx`, so `id` indexes both records —
   note the deploy screen calls the lending agent `health` and the trading agent
   `trading`, which is why those two keys do not read as their product names.

   URLs are stored exactly as the operator gave them, `si=` share parameters
   included; the only edit would be a silent one, and a link that differs from
   what was handed over is a link nobody can verify. */

export const TUTORIAL_PLAYLIST =
  "https://youtube.com/playlist?list=PLOMsGmPsK-0Q&si=GwBXowz-cObb4h3i";

export const TUTORIAL_LINKS = {
  grid: "https://youtu.be/I5uyElPdtfo?si=kzmUTp45ZGnL7WSi",
  trading: "https://youtu.be/Y1jobkuKXH8?si=abHJClYnCnZ30rys",
  lp: "https://youtu.be/1uIeKGeg1no?si=WnNGoAryx3VNMxLR",
  health: "https://youtu.be/I7wxbKY0-ac?si=ddjQBC7IBw0qpfSC",
} as const;

export type TutorialKind = keyof typeof TUTORIAL_LINKS;
