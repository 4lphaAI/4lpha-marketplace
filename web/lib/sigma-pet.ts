"use client";

/* SIGMA, the 4lpha pet. Ported from `D:\4lpha-0G` (`lib/copilot/sigma-pet.ts` +
   `components/layout/SigmaPet.tsx`). Three things changed in the port and all
   three are deliberate:

   1. The reaction map is rewritten for THIS product. 4lpha-0G's map talks about
      vaults, the 0G copilot chat and a scanner, none of which exist here; the
      ids below name marketplace screens and hire/deploy events instead.
   2. Routing is a prop, not `usePathname()`. `KitApp` routes in React state
      (see `components/KitApp.tsx`), so the pet is told the route rather than
      reading the address bar, which lags a state route by a render.
   3. Presentation is plain CSS in `app/globals.css` (`.fl-sigma*`), because
      this app has no Tailwind.

   The pet is decoration: it reads nothing, signs nothing and calls no API. */

export const SIGMA_PET_STATE_EVENT = "4lpha:sigma-pet-state";
export const SIGMA_PET_GREETING = "Hey. I am Sigma, the 4lpha pet. Drag me anywhere.";
export const SIGMA_POSITION_STORAGE_KEY = "4lpha:sigma-pet-position";
export const SIGMA_HIDDEN_STORAGE_KEY = "4lpha:sigma-pet-hidden";
export const SIGMA_ATLAS_COLUMNS = 8;
export const SIGMA_ATLAS_ROWS = 9;
const SIGMA_REACTION_COOLDOWN_MS = 45_000;

/** Row/frame layout of `public/pets/sigma/spritesheet.webp` — an 8x9 atlas of
    192x208 cells. Rows are fixed by the asset; do not renumber them. */
export const SIGMA_ANIMATIONS = {
  idle: { frames: 6, intervalMs: 180, row: 0 },
  "running-right": { frames: 8, intervalMs: 110, row: 1 },
  "running-left": { frames: 8, intervalMs: 110, row: 2 },
  waving: { frames: 4, intervalMs: 170, row: 3 },
  jumping: { frames: 5, intervalMs: 130, row: 4 },
  failed: { frames: 8, intervalMs: 170, row: 5 },
  waiting: { frames: 6, intervalMs: 190, row: 6 },
  running: { frames: 6, intervalMs: 105, row: 7 },
  review: { frames: 6, intervalMs: 155, row: 8 },
} as const;

export type SigmaPetAnimationState = keyof typeof SIGMA_ANIMATIONS;

export interface SigmaPetStateDetail {
  bubbleText?: string;
  state: SigmaPetAnimationState;
}

export type SigmaPetReactionId =
  | "account.detail"
  | "account.list"
  | "agent.detail"
  | "demo.detail"
  | "deploy.grid"
  | "deploy.health"
  | "deploy.lp"
  | "deploy.trade"
  | "hire.success"
  | "list.enter"
  | "market.enter"
  | "sigma.click"
  | "sigma.drag";

export const SIGMA_REACTIONS: Record<SigmaPetReactionId, SigmaPetStateDetail> = {
  "account.detail": { bubbleText: "Your agent, live. Positions, receipts, and an exit button.", state: "review" },
  "account.list": { bubbleText: "Your agents. Everything here runs on your own wallet.", state: "waving" },
  "agent.detail": { bubbleText: "Read the caps before you hire. That is the whole leash.", state: "review" },
  "demo.detail": { bubbleText: "Demo mode. Live prices, simulated fills, zero risk.", state: "waving" },
  "deploy.grid": { bubbleText: "Grid agent. Two rungs, one pool, endless ping-pong.", state: "review" },
  "deploy.health": { bubbleText: "Health guard. It repays your Venus loan while you sleep.", state: "review" },
  "deploy.lp": { bubbleText: "LP agent. It re-ranges and compounds inside a fence.", state: "review" },
  "deploy.trade": { bubbleText: "Trading agent. Pinned universe, capped spend, no freestyle.", state: "review" },
  "hire.success": { bubbleText: "Hired. The agent is armed and still fenced.", state: "jumping" },
  "list.enter": { bubbleText: "Listing an agent? Bring receipts, not vibes.", state: "waving" },
  "market.enter": { bubbleText: "Pick an agent. I will judge your risk quietly.", state: "waving" },
  "sigma.click": { bubbleText: "Hey, why you touch me?", state: "waving" },
  "sigma.drag": { bubbleText: "Are you moving me somewhere?", state: "running" },
};

const lastReactionAt = new Map<string, number>();
let lastDispatchAt = 0;

/** Fire a reaction at the mounted pet. No-op on the server, and rate limited per
    id so a re-rendering screen cannot machine-gun the bubble.
    `quietForMs` drops the reaction when ANY other one spoke that recently — the
    route reaction uses it so that navigating away from a just-finished hire does
    not wipe the "Hired." bubble a third of a second later. */
export function dispatchSigmaPetReaction(
  reactionId: SigmaPetReactionId,
  options: { cooldownMs?: number; force?: boolean; quietForMs?: number } = {},
) {
  if (typeof window === "undefined") return;

  const reaction = SIGMA_REACTIONS[reactionId];
  if (!reaction) return;

  const now = Date.now();
  if (options.quietForMs !== undefined && now - lastDispatchAt < options.quietForMs) return;

  const cooldownMs = options.cooldownMs ?? SIGMA_REACTION_COOLDOWN_MS;
  const lastAt = lastReactionAt.get(reactionId) ?? 0;
  if (!options.force && now - lastAt < cooldownMs) return;

  lastReactionAt.set(reactionId, now);
  lastDispatchAt = now;
  window.dispatchEvent(
    new CustomEvent<SigmaPetStateDetail>(SIGMA_PET_STATE_EVENT, { detail: reaction }),
  );
}

/** Maps a `KitApp` state route to a reaction. Kept in the same shape as the
    screen dispatch in `KitApp`, so a new route without a reaction is silent
    rather than wrong. */
export function sigmaReactionForRoute(route: string): SigmaPetReactionId | undefined {
  if (route.startsWith("/agent/")) return "agent.detail";
  if (route.startsWith("/account/")) return "account.detail";
  if (route === "/account") return "account.list";
  if (route.startsWith("/demo/")) return "demo.detail";
  if (route.startsWith("/deploy/")) {
    const kind = route.slice("/deploy/".length);
    if (kind === "grid") return "deploy.grid";
    if (kind === "trade" || kind === "trading") return "deploy.trade";
    if (kind === "lp") return "deploy.lp";
    if (kind === "lending" || kind === "health") return "deploy.health";
    return undefined;
  }
  if (route === "/list-your-agent") return "list.enter";
  if (route === "/") return "market.enter";
  return undefined;
}

export function clampSigmaPosition(
  position: { x: number; y: number },
  size: number,
  viewport: { height: number; width: number },
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(8, position.x), Math.max(8, viewport.width - size - 8)),
    y: Math.min(Math.max(8, position.y), Math.max(8, viewport.height - size - 8)),
  };
}

/** Background-position for one atlas cell, in percent. Percentage positioning
    interpolates over (track - cell), hence the `columns - 1` / `rows - 1`. */
export function sigmaSpriteOffset(
  state: SigmaPetAnimationState,
  frame: number,
): { x: number; y: number } {
  const animation = SIGMA_ANIMATIONS[state];
  const safeFrame = ((frame % animation.frames) + animation.frames) % animation.frames;
  return {
    x: (safeFrame / (SIGMA_ATLAS_COLUMNS - 1)) * 100,
    y: (animation.row / (SIGMA_ATLAS_ROWS - 1)) * 100,
  };
}
