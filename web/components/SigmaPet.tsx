"use client";

/* SIGMA, the draggable 4lpha pet. Ported from `D:\4lpha-0G`
   (`components/layout/SigmaPet.tsx`); see `lib/sigma-pet.ts` for what changed
   and why. Presentation is `.fl-sigma*` in `app/globals.css` — this app has no
   Tailwind, so the original's utility classes could not come across.

   The pet is decoration only: no fetch, no wallet read, no owner action. */

import React from "react";

import {
  SIGMA_ANIMATIONS,
  SIGMA_ATLAS_COLUMNS,
  SIGMA_ATLAS_ROWS,
  SIGMA_HIDDEN_STORAGE_KEY,
  SIGMA_PET_GREETING,
  SIGMA_PET_STATE_EVENT,
  SIGMA_POSITION_STORAGE_KEY,
  clampSigmaPosition,
  dispatchSigmaPetReaction,
  sigmaReactionForRoute,
  sigmaSpriteOffset,
  type SigmaPetAnimationState,
  type SigmaPetStateDetail,
} from "@/lib/sigma-pet";

const PET_SIZE = 82;

export function SigmaPet({ route }: { route: string }) {
  const dragRef = React.useRef<{
    moved: boolean;
    offsetX: number;
    offsetY: number;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const positionRef = React.useRef({ x: 0, y: 0 });
  const suppressClickRef = React.useRef(false);
  const [position, setPosition] = React.useState({ x: 0, y: 0 });
  const [ready, setReady] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [greetingDismissed, setGreetingDismissed] = React.useState(false);
  const [runtime, setRuntime] = React.useState<SigmaPetStateDetail>({
    bubbleText: SIGMA_PET_GREETING,
    state: "waving",
  });

  const bubbleOnRight = position.x < 280;
  const isGreetingBubble = runtime.bubbleText === SIGMA_PET_GREETING;
  const showBubble = Boolean(runtime.bubbleText) && !(isGreetingBubble && greetingDismissed);

  React.useEffect(() => {
    positionRef.current = position;
  }, [position]);

  // Route reactions run on a short delay so the bubble lands after the screen,
  // not during its mount.
  React.useEffect(() => {
    const reaction = sigmaReactionForRoute(route);
    if (!reaction) return;
    const timer = window.setTimeout(
      () => dispatchSigmaPetReaction(reaction, { quietForMs: 2_500 }),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [route]);

  // Position is read in an effect, never in the initialiser, so the server
  // render and the first client render agree (same rule as `KitApp`'s route).
  React.useEffect(() => {
    setHidden(readStoredHidden());

    function syncPosition() {
      const stored = readStoredPosition();
      // Bottom-right corner by default: the pet is fixed, so it overlaps
      // whatever scrolls under it, and the corner is where a viewer expects a
      // mascot rather than in the middle of a deploy form. Draggable from there.
      const fallback = {
        x: window.innerWidth - PET_SIZE - 24,
        y: Math.max(96, window.innerHeight - PET_SIZE - 24),
      };
      const viewport = { height: window.innerHeight, width: window.innerWidth };
      updatePosition(clampSigmaPosition(stored ?? fallback, PET_SIZE, viewport));
      setReady(true);
    }

    const timeout = window.setTimeout(syncPosition, 0);
    window.addEventListener("resize", syncPosition);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", syncPosition);
    };
  }, []);

  React.useEffect(() => {
    function handleState(event: Event) {
      const detail = (event as CustomEvent<SigmaPetStateDetail>).detail;
      if (!detail?.state || !(detail.state in SIGMA_ANIMATIONS)) return;
      setRuntime({ bubbleText: detail.bubbleText, state: detail.state });
    }

    window.addEventListener(SIGMA_PET_STATE_EVENT, handleState);
    return () => window.removeEventListener(SIGMA_PET_STATE_EVENT, handleState);
  }, []);

  function updatePosition(next: { x: number; y: number }) {
    positionRef.current = next;
    setPosition(next);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (isGreetingBubble) setGreetingDismissed(true);
    dragRef.current = {
      moved: false,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && distance > 6) {
      drag.moved = true;
      suppressClickRef.current = true;
      dispatchSigmaPetReaction("sigma.drag", { cooldownMs: 8_000, force: true });
    }

    updatePosition(
      clampSigmaPosition(
        { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
        PET_SIZE,
        { height: window.innerHeight, width: window.innerWidth },
      ),
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    storePosition(positionRef.current);
  }

  function handleClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    dispatchSigmaPetReaction("sigma.click", { cooldownMs: 8_000, force: true });
  }

  function dismissGreeting() {
    if (isGreetingBubble) setGreetingDismissed(true);
  }

  if (hidden) return null;

  return (
    <div
      className="fl-sigma"
      data-testid="sigma-pet"
      style={{
        opacity: ready ? 1 : 0,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      }}
    >
      {showBubble ? (
        <div
          className={`fl-sigma__bubble${bubbleOnRight ? " fl-sigma__bubble--right" : ""}${
            isGreetingBubble ? " fl-sigma__bubble--greeting" : ""
          }`}
        >
          <p>{runtime.bubbleText}</p>
        </div>
      ) : null}
      <button
        aria-label="Move Sigma, the 4lpha pet"
        className="fl-sigma__grab"
        type="button"
        onClick={handleClick}
        onFocus={dismissGreeting}
        onPointerCancel={handlePointerUp}
        onPointerDown={handlePointerDown}
        onPointerEnter={dismissGreeting}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <SigmaSprite state={runtime.state} />
      </button>
      <button
        aria-label="Hide Sigma"
        className="fl-sigma__hide"
        title="Hide Sigma"
        type="button"
        onClick={() => {
          storeHidden();
          setHidden(true);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function SigmaSprite({ state }: { state: SigmaPetAnimationState }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const animation = SIGMA_ANIMATIONS[state];
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (prefersReducedMotion || animation.frames <= 1) return;
    const interval = window.setInterval(() => {
      setFrame((current) => (current + 1) % animation.frames);
    }, animation.intervalMs);
    return () => window.clearInterval(interval);
  }, [animation.frames, animation.intervalMs, prefersReducedMotion]);

  const offset = sigmaSpriteOffset(state, frame);

  return (
    <span
      aria-label="Sigma"
      className="fl-sigma__sprite"
      role="img"
      style={{
        backgroundPosition: `${offset.x}% ${offset.y}%`,
        backgroundSize: `${SIGMA_ATLAS_COLUMNS * 100}% ${SIGMA_ATLAS_ROWS * 100}%`,
        width: PET_SIZE,
      }}
    />
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mediaQuery) return;

    const timeout = window.setTimeout(() => setPrefersReducedMotion(mediaQuery.matches), 0);
    function handleChange(event: MediaQueryListEvent) {
      setPrefersReducedMotion(event.matches);
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => {
      window.clearTimeout(timeout);
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  return prefersReducedMotion;
}

/* localStorage is a per-viewer convenience here — a cleared or throwing store
   just means the pet starts in its default corner, visible. */
function readStoredPosition(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(SIGMA_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ x: unknown; y: unknown }>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function storePosition(position: { x: number; y: number }) {
  try {
    window.localStorage.setItem(SIGMA_POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    /* private mode / blocked site data — the pet still works this session. */
  }
}

function readStoredHidden(): boolean {
  try {
    return window.localStorage.getItem(SIGMA_HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeHidden() {
  try {
    window.localStorage.setItem(SIGMA_HIDDEN_STORAGE_KEY, "1");
  } catch {
    /* ignored — hiding then lasts only for this page view. */
  }
}
