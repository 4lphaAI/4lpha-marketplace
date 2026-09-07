import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import axios from "axios";
import { parseUri, formatUri } from "@walletconnect/utils";

const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const queryString = require("query-string") as {
  parse(input: string): Record<string, unknown>;
  stringify(input: Record<string, unknown>): string;
};
const decode = require("decode-uri-component") as (input: string) => string;

describe("security dependency compatibility", () => {
  it("retains CommonJS query-string decoding and query round trips", () => {
    expect(typeof decode).toBe("function");
    const values = { label: "Tiếng Việt 🚀", callback: "https://wallet.example/a?x=1&y=2", key: "a+b/c=" };
    expect(queryString.parse(queryString.stringify(values))).toEqual(values);
    expect(queryString.parse("x=1&x=2&empty=&flag")).toEqual({ x: ["1", "2"], empty: "", flag: null });
  });

  it("resolves the patched upstream decoder through both module systems", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      "import decode from 'decode-uri-component'; import fixed from 'decode-uri-component-patched'; if(decode!==fixed)throw Error('bridge mismatch'); console.log(decode('%E2%9C%93'));"],
    { cwd: webRoot, timeout: 5_000, encoding: "utf8" });
    expect(output.trim()).toBe("✓");
  });

  it("handles bounded malformed escapes without recursive fallback", () => {
    // Run in a bounded child: a dependency regression cannot hang the suite.
    execFileSync(process.execPath, ["-e",
      "const d=require('decode-uri-component'); const s='%E0%A4'.repeat(1024); const r=d(s); if(typeof r!=='string'||r.length>s.length)throw Error('invalid decoder result');"],
    { cwd: webRoot, timeout: 3_000 });
    expect(decode("%broken%20value")).toBe("%broken value");
  });

  it("preserves WalletConnect pairing fields through parse/format", () => {
    const topic = "a".repeat(64);
    const symKey = "b".repeat(64); // Synthetic pairing fixture, never a wallet key.
    const parsed = parseUri(`wc:${topic}@2?relay-protocol=irn&symKey=${symKey}`);
    expect(parsed).toMatchObject({ topic, version: 2, symKey, relay: { protocol: "irn" } });
    expect(parseUri(formatUri(parsed))).toEqual(parsed);
  });

  it("keeps axios JSON request behavior without making a network request", async () => {
    const result = await axios.post("https://fixture.invalid/request", { amount: "123", label: "✓" }, {
      adapter: async config => ({ data: config.data, status: 200, statusText: "OK", headers: {}, config }),
    });
    expect(result.data).toEqual({ amount: "123", label: "✓" });
  });

  it("uses patched transitive releases without replacing the ws7 branch", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
      packages: Record<string, { version?: string; name?: string }>;
    };
    expect(lock.packages["node_modules/axios"]?.version).toBe("1.18.0");
    expect(lock.packages["node_modules/decode-uri-component-patched"]).toMatchObject({ name: "decode-uri-component", version: "0.5.0" });
    const sockets = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/ws$/u.test(name));
    expect(sockets.length).toBeGreaterThan(0);
    for (const [, value] of sockets) expect(["8.21.0", "7.5.13"]).toContain(value.version);
  });

  it("bounds fragmented websocket messages without a real socket", async () => {
    const { Receiver } = require("ws") as { Receiver: new(options: { maxFragments: number; maxPayload: number }) => Writable };
    const receiver = new Receiver({ maxFragments: 2, maxPayload: 1024 });
    const error = once(receiver, "error");
    receiver.write(Buffer.from([2, 1, 97, 0, 1, 98, 128, 1, 99]));
    const [failure] = await error;
    expect(failure).toMatchObject({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS" });
    receiver.destroy();
  });

  it("serializes only initialized close-reason bytes and rejects wider typed arrays", () => {
    type Sender = { close(code: number, reason: ArrayBufferView, mask: boolean): void; sendFrame(parts: Buffer[]): void };
    const { Sender: SocketSender } = require("ws") as { Sender: new(socket: object) => Sender };
    const sender = new SocketSender({});
    let frames: Buffer[] = [];
    sender.sendFrame = parts => { frames = parts; };
    sender.close(1000, new Uint8Array([65, 66]), false);
    expect(frames.at(-1)).toEqual(Buffer.from([3, 232, 65, 66]));
    expect(() => sender.close(1000, new Uint16Array([65]), false)).toThrow(TypeError);
  });
});
