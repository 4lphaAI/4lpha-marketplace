"use client";
import React from "react";
import { Icon } from "@/design-system";

/** The 4lpha account on X — the same one the ERC-8004 identity metadata publishes. */
const X_URL = "https://x.com/4lpha_agent";

/**
 * The app-wide notice. It sits ABOVE the sticky header in `KitApp`, so it
 * shows on every route without each screen having to render it, and scrolls
 * away rather than eating vertical space on every page.
 *
 * One live agent per account is a real product limit today (one passkey owner
 * binds one wallet), so the banner names the workaround instead of leaving a
 * user stuck at the second hire.
 */
export function NoticeBanner() {
  return <div className="fl-notice" role="note">
    <span className="fl-notice__inner">
      <Icon name="info" size={14} />
      <span>
        <strong>Note:</strong> each account can hire only one agent for now — you can create
        additional accounts, each with its own passkey. We are improving the product every day
        and would love your feedback.{" "}
        <a href={X_URL} target="_blank" rel="noreferrer">Visit our X<Icon name="external" size={12} /></a>
      </span>
    </span>
  </div>;
}
