/**
 * The client IP the public rate limiters key on (MCP limiter, desk limiter).
 *
 * Production `4lpha.tech` and `desk.4lpha.tech` sit behind Cloudflare, which sits in front of Railway's edge. Railway
 * overwrites `x-real-ip` (a client cannot set it, see `AGENTIC-SKILLS-MCP-BUILD.md` O1), but behind Cloudflare that header
 * carries a Cloudflare edge address, not the visitor: without more, every visitor of a colo would share one bucket.
 * Cloudflare puts the visitor in `cf-connecting-ip`, and a client can send that header itself, so it is believed ONLY when
 * `x-real-ip` (the part the client cannot forge) is inside Cloudflare's published ranges. A client that reaches the Railway
 * domain directly with a forged `cf-connecting-ip` has a non-Cloudflare `x-real-ip` and is keyed on that address, so a
 * forged header never buys a fresh bucket.
 *
 * Missing or malformed `x-real-ip` (local dev, a proxy change) keeps the shared `unknown` bucket: fail closed.
 */
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

export function clientIp(headers: Pick<Headers, "get">): string {
  const real = headers.get(CLIENT_IP_HEADER)?.trim() ?? "";
  if (!(real.length > 0 && real.length <= 64 && /^[0-9a-fA-F:.]+$/u.test(real))) return UNKNOWN_CLIENT;
  if (isCloudflareIp(real)) {
    const forwarded = headers.get(CLOUDFLARE_IP_HEADER)?.trim().toLowerCase() ?? "";
    if (forwarded.length > 0 && forwarded.length <= 64 && parseIp(forwarded) !== null) return forwarded;
  }
  return real.toLowerCase();
}
