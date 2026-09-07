import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

/**
 * The canonical-host redirect.
 *
 * What is asserted is mostly what it must NOT do: the apex must pass through
 * untouched, because a middleware that redirects the canonical host is an
 * infinite loop that takes the whole site down.
 */
function request(url: string, host: string, method = "GET"): NextRequest {
  return new NextRequest(url, { method, headers: { host } });
}

describe("canonical host redirect", () => {
  it("sends www to the apex, keeping path and query", () => {
    const response = middleware(
      request("https://www.4lpha.tech/demo/abc?tab=activity", "www.4lpha.tech"),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://4lpha.tech/demo/abc?tab=activity");
  });

  it("PRESERVES THE METHOD — a POST is not degraded to a GET", () => {
    const response = middleware(
      request("https://www.4lpha.tech/api/demo/agents", "www.4lpha.tech", "POST"),
    );
    // 308 is the permanent redirect that keeps the method; 301/302 do not.
    expect(response.status).toBe(308);
  });

  it("leaves the apex alone — redirecting it would be an infinite loop", () => {
    const response = middleware(request("https://4lpha.tech/deploy/grid", "4lpha.tech"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("leaves the Railway hostname and localhost alone", () => {
    for (const host of ["web-production-a0495.up.railway.app", "localhost:3000", "127.0.0.1:3000"]) {
      const response = middleware(request(`http://${host}/`, host));
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("compares the hostname only, so a port cannot defeat or trigger it", () => {
    const withPort = middleware(request("https://www.4lpha.tech/", "www.4lpha.tech:443"));
    expect(withPort.status).toBe(308);
    expect(withPort.headers.get("location")).toBe("https://4lpha.tech/");
  });

  it("is case-insensitive about the host, as DNS is", () => {
    const response = middleware(request("https://www.4lpha.tech/", "WWW.4lpha.TECH"));
    expect(response.status).toBe(308);
  });
});
