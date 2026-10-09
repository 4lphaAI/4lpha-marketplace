import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCard, DESK_DESCRIPTION, DESK_NAME, publicBaseUrl } from "../src/agentCard.js";

describe("publicBaseUrl: the card's only URL source", () => {
  it("prefers BNBAGENT_PUBLIC_URL, then AGENTCORE_RUNTIME_URL, and drops trailing slashes", () => {
    assert.equal(publicBaseUrl({ BNBAGENT_PUBLIC_URL: "https://desk.4lpha.tech/", AGENTCORE_RUNTIME_URL: "https://other.example" }), "https://desk.4lpha.tech");
    assert.equal(publicBaseUrl({ AGENTCORE_RUNTIME_URL: "https://desk.4lpha.tech//" }), "https://desk.4lpha.tech");
  });
  it("is null when unset, empty, not a URL or not http(s)", () => {
    for (const v of [undefined, "", "   ", "desk.4lpha.tech", "ftp://x.example", "javascript:alert(1)"]) {
      assert.equal(publicBaseUrl({ BNBAGENT_PUBLIC_URL: v }), null, String(v));
    }
  });
});

describe("agent card", () => {
  const saved = { a: process.env.BNBAGENT_PUBLIC_URL, b: process.env.AGENTCORE_RUNTIME_URL };
  afterEach(() => {
    for (const [k, v] of [["BNBAGENT_PUBLIC_URL", saved.a], ["AGENTCORE_RUNTIME_URL", saved.b]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it("advertises the public URL when set, localhost otherwise", () => {
    delete process.env.AGENTCORE_RUNTIME_URL;
    process.env.BNBAGENT_PUBLIC_URL = "https://desk.4lpha.tech";
    assert.equal(buildAgentCard().url, "https://desk.4lpha.tech");
    delete process.env.BNBAGENT_PUBLIC_URL;
    assert.match(buildAgentCard().url, /^http:\/\/localhost:/);
  });
  it("carries the desk name and the three request formats", () => {
    const c = buildAgentCard();
    assert.equal(c.name, DESK_NAME);
    assert.equal(c.name, "4lpha bStock Desk");
    for (const s of ["stock_report", "dca_plan", "rebalance_plan", "task_description", "0.10 USD"]) assert.ok(c.description.includes(s), s);
    assert.equal(c.description, DESK_DESCRIPTION);
    assert.ok(!/[\u2013\u2014]/.test(c.description));
    assert.deepEqual(c.skills.map((s) => s.id), ["negotiate", "notify_funded"]);
  });
});
