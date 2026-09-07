import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseErc8004Identity } from "@/lib/exec/erc8004-identity";
import { Erc8004IdentityStatus } from "./Erc8004IdentityStatus";

const hash = `0x${"ab".repeat(32)}`;
const pending = { version: 1, publicRef: "bc3f7b92-4c65-4acf-aef4-338b084f7a13", revision: 1, category: "grid", status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
const registered = { ...pending, status: "registered", agentId: ((1n << 256n) - 1n).toString(), registrationTxHash: hash, uriUpdateTxHash: hash };
function render(value?: unknown) { return renderToStaticMarkup(<Erc8004IdentityStatus identity={parseErc8004Identity(value)} />); }

describe("ERC-8004 identity status", () => {
  it("adds nothing for a legacy agent", () => expect(render()).toBe(""));

  it("renders pending and attention without a token link or signing action", () => {
    for (const value of [pending, { ...pending, status: "registering", registrationTxHash: hash }, { ...registered, status: "updating" },
      { ...registered, status: "blocked", errorCode: "verification_failed" }]) {
      const html = render(value);
      expect(html).toContain(value.status === "blocked" ? "registration needs attention" : "registration pending");
      // REMOVED at the operator's request (2026-09-06): the header line carries the
      // registration state only; ownership is not restated on every agent page.
      expect(html).not.toContain("Identity owned by");
      expect(html).not.toContain("href=");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("ERC-8004 #");
    }
  });

  it("renders the complete registered ID and only the fixed 8004scan destination", () => {
    const html = render(registered);
    expect(html).toContain(`ERC-8004 #${registered.agentId}`);
    expect(html).toContain(`href="https://8004scan.io/agents/bsc/${registered.agentId}"`);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("cannot render a registered badge from a lone ID or malformed registered DTO", () => {
    for (const value of [{ agentId: "7" }, { ...registered, uriUpdateTxHash: null }, { ...registered, url: "javascript:alert(1)" }]) {
      const html = render(value);
      expect(html).toContain("registration needs attention");
      expect(html).not.toContain("href=");
      expect(html).not.toContain("ERC-8004 #");
      expect(html).not.toContain("alert(1)");
    }
  });
});
