"use client";
/* Whether an explainer card is on screen.
 *
 * These cards animate by re-rendering every frame, and the LP deploy form now
 * shows up to three of them at once. Observing visibility means only the card
 * a reader is actually looking at pays for that, and a card that is scrolled
 * away — or in a collapsed section, or in a test that never lays anything out —
 * costs nothing. The loop therefore starts only once the observer has said the
 * card is intersecting, never on assumption. */
import React from "react";

export function useCardVisible(ref: React.RefObject<Element | null>): boolean {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      /* start a little before the card scrolls in, so it is already moving */
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return visible;
}
