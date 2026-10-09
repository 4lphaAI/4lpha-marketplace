/**
 * Caller identity configuration for the public seller endpoint, and the client IP behind Railway + Cloudflare.
 *
 * `SELLER_CALLER_IDENTITY=railway-client-ip` keys the per-caller quota on the client IP. Railway's edge overwrites
 * `x-real-ip` with the address that connected to it (a client cannot set it). When Cloudflare proxies the hostname
 * that address is a Cloudflare edge, and the visitor is in `cf-connecting-ip`. A client can send that header itself,
 * so it is believed ONLY when `x-real-ip` is inside Cloudflare's published ranges: a client that reaches the Railway
 * domain directly with a forged `cf-connecting-ip` has a non-Cloudflare `x-real-ip` and is keyed on that address.
 *
 * The key is the full IPv4 address, or the /64 prefix for IPv6 (one host usually controls a whole /64); an IPv4-mapped
 * IPv6 address is read as the IPv4 one.
 * A missing or malformed `x-real-ip` maps to ONE shared key (fail closed): such requests share a single caller bucket
 * instead of bypassing it. Functions here never return or throw a configured value; only variable names.
 */

import type { IncomingHttpHeaders } from "node:http";

export const CALLER_IDENTITY_ENV = "SELLER_CALLER_IDENTITY";
export const TRUSTED_HEADER_ENV = "SELLER_TRUSTED_CALLER_HEADER";
export const RAILWAY_CLIENT_IP = "railway-client-ip";
export const CLIENT_IP_HEADER = "x-real-ip";
export const CLOUDFLARE_IP_HEADER = "cf-connecting-ip";
export const UNKNOWN_CLIENT = "unknown";

/**
 * Cloudflare's published edge ranges, fetched 2026-10-08 from https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6. To refresh: re-fetch both URLs (they change rarely, with notice on
 * https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/), paste the lines here, and update the
 * date. A stale list fails safe in one direction (a new Cloudflare range is keyed on its edge IP, one shared bucket) and is
 * harmless in the other (a range Cloudflare dropped could only be reached by a client that already controls that address).
 */
export const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
] as const;
export const CLOUDFLARE_IPV6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
] as const;

type Parsed = { version: 4 | 6; value: bigint };

function parseV4(raw: string): bigint | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function wordsOf(groups: string[], mayEndInV4: boolean): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    if (group.includes(".")) {
      const v4 = mayEndInV4 && i === groups.length - 1 ? parseV4(group) : null;
      if (v4 === null) return null;
      out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    } else {
      if (!/^[0-9a-f]{1,4}$/iu.test(group)) return null;
      out.push(parseInt(group, 16));
    }
  }
  return out;
}

function parseV6(raw: string): bigint | null {
  if (!/^[0-9a-f:.]+$/iu.test(raw)) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const split = (text: string): string[] => (text === "" ? [] : text.split(":"));
  const head = wordsOf(split(halves[0]!), halves.length === 1);
  const tail = halves.length === 2 ? wordsOf(split(halves[1]!), true) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return words.reduce((acc, word) => (acc << 16n) | BigInt(word), 0n);
}

/** Strict IPv4 or IPv6 literal (no zone id, no port, no brackets); an IPv4-mapped IPv6 address is read as the IPv4 one. */
export function parseIp(raw: string): Parsed | null {
  const v4 = parseV4(raw);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseV6(raw);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
  return { version: 6, value: v6 };
}

type Range = { version: 4 | 6; shift: bigint; prefix: bigint };

function compile(cidr: string): Range {
  const [address, bits] = cidr.split("/") as [string, string];
  const parsed = parseIp(address);
  if (parsed === null) throw new Error(`bad CIDR ${cidr}`);
  const total = parsed.version === 4 ? 32n : 128n;
  const shift = total - BigInt(bits);
  return { version: parsed.version, shift, prefix: parsed.value >> shift };
}

const RANGES: readonly Range[] = [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6].map(compile);

export function isCloudflareIp(raw: string): boolean {
  const parsed = parseIp(raw.trim().toLowerCase());
  return parsed !== null && RANGES.some((range) => range.version === parsed.version && parsed.value >> range.shift === range.prefix);
}

function single(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The bucket key for a valid IP: IPv4 (and IPv4-mapped IPv6) as the dotted address, IPv6 as its /64 prefix in
 * canonical compressed form (one host usually controls a whole /64), e.g. `2001:db8:1:2::/64`.
 */
export function ipKey(parsed: Parsed): string {
  if (parsed.version === 4) return [24n, 16n, 8n, 0n].map((shift) => String((parsed.value >> shift) & 0xffn)).join(".");
  const words: number[] = [];
  for (let i = 0n; i < 4n; i += 1n) words.push(Number((parsed.value >> (112n - 16n * i)) & 0xffffn));
  words.push(0, 0, 0, 0);
  // RFC 5952: compress the longest run of zero words (first wins, runs of 2 or more)
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && words[j] === 0) j += 1;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  const hex = (list: number[]): string => list.map((w) => w.toString(16)).join(":");
  if (best.length < 2) return `${hex(words)}/64`;
  return `${hex(words.slice(0, best.start))}::${hex(words.slice(best.start + best.length))}/64`;
}

/**
 * The client key behind Railway (+ Cloudflare): the client IP (IPv6 reduced to its /64), or the shared `unknown` key
 * when `x-real-ip` is missing or invalid. The Cloudflare trust check uses the full `x-real-ip` address.
 */
export function clientIp(headers: IncomingHttpHeaders): string {
  const real = single(headers[CLIENT_IP_HEADER]);
  const parsedReal = real.length === 0 || real.length > 64 ? null : parseIp(real);
  if (parsedReal === null) return UNKNOWN_CLIENT;
  if (isCloudflareIp(real)) {
    const forwarded = single(headers[CLOUDFLARE_IP_HEADER]);
    const parsedForwarded = forwarded.length > 0 && forwarded.length <= 64 ? parseIp(forwarded) : null;
    if (parsedForwarded !== null) return ipKey(parsedForwarded);
  }
  return ipKey(parsedReal);
}

function filled(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** True when the operator selected `SELLER_CALLER_IDENTITY=railway-client-ip` (the mode that wins at runtime). */
export function railwayClientIpMode(env: NodeJS.ProcessEnv): boolean {
  return (env[CALLER_IDENTITY_ENV] ?? "").trim().toLowerCase() === RAILWAY_CLIENT_IP;
}

/**
 * Boot problems with the caller identity configuration (variable names only, never a value). The unknown-value and
 * both-set refusals apply everywhere; "no source at all" and an unusable header name are production refusals.
 */
export function callerIdentityProblems(env: NodeJS.ProcessEnv, production: boolean): string[] {
  const problems: string[] = [];
  const mode = filled(env, CALLER_IDENTITY_ENV);
  const header = filled(env, TRUSTED_HEADER_ENV);
  if (mode && !railwayClientIpMode(env)) problems.push(`${CALLER_IDENTITY_ENV} has an unsupported value (supported: ${RAILWAY_CLIENT_IP})`);
  if (mode && header) problems.push(`set only one of ${CALLER_IDENTITY_ENV} and ${TRUSTED_HEADER_ENV}`);
  // an unusable header name would satisfy "a source is configured" while giving no identity: a production refusal
  if (production && header && !/^[a-z0-9-]+$/u.test((env[TRUSTED_HEADER_ENV] ?? "").trim().toLowerCase())) {
    problems.push(`${TRUSTED_HEADER_ENV} is not a valid header name`);
  }
  if (production && !mode && !header) {
    problems.push(`no caller identity source: set ${CALLER_IDENTITY_ENV}=${RAILWAY_CLIENT_IP} (or ${TRUSTED_HEADER_ENV})`);
  }
  return problems;
}
