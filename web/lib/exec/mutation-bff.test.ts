import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { forwardAgentMutation } from "./mutation-bff";

describe("owner mutation BFF", () => {
  it("forwards signature-covered bytes exactly", async () => {
    const raw = '{ "signed": {"action":"pause"}, "params": {} }\n';
    const mutation = vi.fn().mockResolvedValue({ status: 200, body: '{"data":{"status":"paused"}}' });
    const response = await forwardAgentMutation(
      new NextRequest("https://app.test/api/agents/agent-1/pause", { method: "POST", body: raw }),
      "agent-1",
      "/pause",
      mutation,
    );
    expect(response.status).toBe(200);
    expect(mutation).toHaveBeenCalledWith("/agents/agent-1/pause", raw);
  });

  it("rejects malformed ids and empty bodies before the plane", async () => {
    const mutation = vi.fn();
    const badId = await forwardAgentMutation(
      new NextRequest("https://app.test/api/agents/nope/pause", { method: "POST", body: "{}" }),
      "bad/id",
      "/pause",
      mutation,
    );
    const empty = await forwardAgentMutation(
      new NextRequest("https://app.test/api/agents/agent-1/pause", { method: "POST", body: "" }),
      "agent-1",
      "/pause",
      mutation,
    );
    expect(badId.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("sanitizes transport failures", async () => {
    const mutation = vi.fn().mockImplementation(() => { throw new Error("secret upstream detail"); });
    const response = await forwardAgentMutation(
      new NextRequest("https://app.test/api/agents/agent-1/revoke", { method: "POST", body: "{}" }),
      "agent-1",
      "/revoke",
      mutation,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":{"code":"execution_unavailable"}}');
  });

  it("pins every mutation route to its one plane suffix", () => {
    const routes = [
      ["../../app/api/agents/[id]/pause/route.ts", '"/pause"'],
      ["../../app/api/agents/[id]/unpause/route.ts", '"/unpause"'],
      ["../../app/api/agents/[id]/revoke/route.ts", '"/revoke"'],
      ["../../app/api/agents/[id]/lp/settings/route.ts", '"/lp/settings"'],
      ["../../app/api/agents/[id]/lp/[positionId]/exit/route.ts", "`/lp/${encodeURIComponent(positionId)}/exit`"],
      ["../../app/api/agents/[id]/trade/settings/route.ts", '"/trade/settings"'],
      ["../../app/api/agents/[id]/trade/positions/[positionId]/exit/route.ts", "`/trade/positions/${encodeURIComponent(positionId)}/exit`"],
    ] as const;
    for (const [path, suffix] of routes) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).toContain(suffix);
    }
  });
});
