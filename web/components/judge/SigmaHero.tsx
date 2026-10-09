"use client";
/* Sigma in the judge guide hero: the animated pet with a speech bubble that
   cycles through short lines (lib/judge-data.ts SIGMA_LINES). Display only: no
   input, no request. A click moves to the next line. */
import React from "react";

import { SIGMA_LINES } from "@/lib/judge-data";
import { SIGMA_ANIMATIONS, sigmaSpriteOffset, type SigmaPetAnimationState } from "@/lib/sigma-pet";

const LINE_MS = 6000;
const TYPE_MS = 24;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function SigmaSprite({ state, size, still }: { state: SigmaPetAnimationState; size: number; still: boolean }) {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    setFrame(0);
    if (still) return;
    const timer = setInterval(() => setFrame((f) => f + 1), SIGMA_ANIMATIONS[state].intervalMs);
    return () => clearInterval(timer);
  }, [state, still]);
  const offset = sigmaSpriteOffset(state, frame);
  return (
    <span aria-hidden="true" className="fl-sigma__sprite"
      style={{ width: size, backgroundPosition: `${offset.x}% ${offset.y}%`, backgroundSize: "800% 900%" }} />
  );
}

export function SigmaHero() {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = React.useState(0);
  const [shown, setShown] = React.useState(0);
  const line = SIGMA_LINES[index]!;

  // Type the current line, then hold it and move on.
  React.useEffect(() => {
    if (reduced) { setShown(line.text.length); return; }
    setShown(0);
    const typer = setInterval(() => setShown((n) => (n >= line.text.length ? n : n + 1)), TYPE_MS);
    return () => clearInterval(typer);
  }, [index, reduced, line.text]);
  React.useEffect(() => {
    const next = setTimeout(() => setIndex((i) => (i + 1) % SIGMA_LINES.length), LINE_MS + line.text.length * (reduced ? 0 : TYPE_MS));
    return () => clearTimeout(next);
  }, [index, reduced, line.text]);

  const typing = shown < line.text.length;
  const advance = () => setIndex((i) => (i + 1) % SIGMA_LINES.length);

  return (
    <div className="fl-jg-sigma">
      <div className="fl-jg-bubble" aria-live="polite">
        <p>
          {line.text.slice(0, shown)}
          {typing && <span className="fl-jg-caret" />}
          {/* Reserve the full line's height so the bubble does not jump while typing. */}
          <span aria-hidden="true" style={{ visibility: "hidden" }}>{line.text.slice(shown)}</span>
        </p>
        <div className="fl-jg-bubbledots" aria-hidden="true">
          {SIGMA_LINES.map((_, i) => <span key={i} className={i === index ? "on" : ""} />)}
        </div>
      </div>
      <button type="button" className="fl-jg-sigmabtn" onClick={advance} aria-label="Sigma, next line" title="Click me">
        <SigmaSprite state={line.state} size={220} still={reduced} />
      </button>
    </div>
  );
}
