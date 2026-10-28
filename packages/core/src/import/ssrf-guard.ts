/**
 * SSRF guard for outbound "fetch a user-supplied URL" flows.
 *
 * Centralizes the host/IP allowlist + safe-fetch logic shared by:
 * - workers/src/processors/document-process.ts (fetch_url action)
 * - workers/src/processors/import.ts            (GCS file download)
 * - apps/web/lib/actions/documents.ts           (importFromUrlAction)
 *
 * Threat model: a user controls the URL. The response body is persisted to GCS
 * and indexed for RAG, so a naive `fetch()` is a read-SSRF primitive with
 * exfiltration (cloud metadata, internal services, loopback, link-local).
 *
 * Defenses:
 * - https-only (http allowed only via an explicit opt-in, never by default)
 * - DNS-resolve the host and REJECT private/loopback/link-local/reserved ranges
 * - reject cloud-metadata hostnames (metadata.google.internal, ...)
 * - re-validate EVERY redirect hop and pin to the validated IP to defeat
 *   DNS-rebinding (the resolved IP is connected to; the Host header is kept)
 * - cap the response body size
 *
 * Server-only module (depends on node:dns + node:net). Never import from a
 * client bundle.
 */

import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

/** Result of a safe-target check. */
export type SafeFetchTargetResult =
  | { safe: true; resolvedIps: string[] }
  | { safe: false; reason: string };

/**
 * Resolve a hostname to one or more IP-literal strings. Mirrors the subset of
 * `node:dns/promises.lookup(host, { all: true })` the guard relies on.
 */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: the real system DNS via node:dns/promises. */
const defaultResolver: HostnameResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** Options controlling the SSRF guard. */
export interface SafeFetchOptions {
  /**
   * Allow plain-http targets in addition to https. Off by default — only
   * enable for trusted, fixed-domain allowlists (e.g. GCS download).
   */
  allowHttp?: boolean;
  /**
   * Optional host allowlist. When set, the URL hostname (case-insensitive)
   * must equal, or be a sub-domain of, one of these entries. Even when a host
   * is allowlisted it is still DNS-checked against the private-range blocklist.
   */
  allowedHosts?: readonly string[];
  /** Max response body size in bytes (default 25 MiB). */
  maxBytes?: number;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /**
   * Max time the pinned socket may spend connecting, in ms (default 10_000,
   * never more than {@link timeoutMs}). Bounds an otherwise-unbounded connect to
   * an attacker-influenced host.
   */
  connectTimeoutMs?: number;
  /** Max redirect hops to follow (default 5). */
  maxRedirects?: number;
  /**
   * Override the hostname→IP resolver used for the private-range check.
   * Defaults to system DNS. The connection is still pinned to whatever IP this
   * returns, so a custom resolver MUST itself be trustworthy — this exists for
   * tests and for callers wiring a hardened/cached resolver, never to relax the
   * private-IP blocklist.
   */
  resolveHostname?: HostnameResolver;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** Hostnames that must never be fetched (cloud metadata + obvious loopback). */
const BLOCKED_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata",
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * True when an IP literal (v4 or v6) is in a private / loopback / link-local /
 * reserved / unspecified range that must never be reachable via user URLs.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  // Not a parseable IP literal — treat as unsafe (caller resolves real IPs).
  return true;
}

/**
 * @internal — exported ONLY so the security regression suite can exercise the
 * SHIPPED classifier instead of an inline copy. Not part of the supported
 * public API; prefer {@link isBlockedIp} (family-dispatching) from app code.
 */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — "this" network / unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 — multicast; 240.0.0.0/4 — reserved/broadcast
  if (a >= 224) return true;

  return false;
}

/**
 * Expand an IPv6 literal to its full, uncompressed form: exactly 8 groups of 4
 * lowercase hex digits. Handles `::` zero-compression and a trailing
 * dotted-quad tail (the embedded-IPv4 syntax, e.g. `::ffff:127.0.0.1`), which
 * is rewritten to its two equivalent hex groups before expansion.
 *
 * Returns `null` for anything that is not a structurally valid IPv6 address.
 * Callers should only pass strings that already passed `isIP(...) === 6`, but
 * this is defensive — a `null` return is treated as "cannot prove safe".
 *
 * @internal — exported ONLY for the security regression suite (see
 * {@link isBlockedIpv4}). Not part of the supported public API.
 */
export function expandIpv6(ip: string): string[] | null {
  let s = ip.toLowerCase();

  // Rewrite a trailing dotted-quad (the last "group" written as IPv4) into the
  // two 16-bit hex groups it represents, so the rest of the logic is hex-only.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = [dotted[1], dotted[2], dotted[3], dotted[4]].map((o) =>
      Number(o),
    );
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const [o0, o1, o2, o3] = octets as [number, number, number, number];
    const hi = ((o0 << 8) | o1).toString(16);
    const lo = ((o2 << 8) | o3).toString(16);
    s = `${s.slice(0, dotted.index)}${hi}:${lo}`;
  }

  let groups: string[];
  const dbl = s.indexOf("::");
  if (dbl >= 0) {
    // Only one "::" is legal.
    if (s.indexOf("::", dbl + 1) !== -1) return null;
    const head = s
      .slice(0, dbl)
      .split(":")
      .filter((x) => x !== "");
    const tail = s
      .slice(dbl + 2)
      .split(":")
      .filter((x) => x !== "");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = s.split(":");
  }

  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * Two expanded hex groups → dotted-decimal IPv4 (e.g. "7f00","0001" → 127.0.0.1).
 *
 * @internal — exported ONLY for the security regression suite (see
 * {@link isBlockedIpv4}). Not part of the supported public API.
 */
export function groupsToIpv4(hiGroup: string, loGroup: string): string {
  const hi = parseInt(hiGroup, 16);
  const lo = parseInt(loGroup, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * @internal — exported ONLY for the security regression suite (see
 * {@link isBlockedIpv4}). Not part of the supported public API; prefer
 * {@link isBlockedIp} from app code.
 */
export function isBlockedIpv6(rawIp: string): boolean {
  // Strip zone id (e.g. fe80::1%eth0) before reasoning about the address.
  const ip = rawIp.split("%")[0]!.toLowerCase();

  // Unspecified (::) and loopback (::1)
  if (ip === "::" || ip === "::1") return true;

  // f800::/6 — reserved/unassigned block (f8.. / f9.. / fa.. / fb..) that sits
  // between multicast (ff00::/8) and the fc00::/7 ULA / fe80 ranges. Not global
  // unicast (that is 2000::/3) and not legitimately routable — fail closed.
  if (
    ip.startsWith("f8") ||
    ip.startsWith("f9") ||
    ip.startsWith("fa") ||
    ip.startsWith("fb")
  ) {
    return true;
  }
  // fc00::/7 — unique local addresses (fc.. / fd..)
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  // fe00::/9 — reserved (fe0.. / fe1.. / fe2.. / fe3.. / fe4.. / fe5.. / fe6.. /
  // fe7..). Sits just below the link-local fe80::/10 block below; reserved and
  // not global unicast, so fail closed rather than letting it fall through.
  if (
    ip.startsWith("fe0") ||
    ip.startsWith("fe1") ||
    ip.startsWith("fe2") ||
    ip.startsWith("fe3") ||
    ip.startsWith("fe4") ||
    ip.startsWith("fe5") ||
    ip.startsWith("fe6") ||
    ip.startsWith("fe7")
  ) {
    return true;
  }
  // fe80::/10 — link-local (fe8.. / fe9.. / fea.. / feb..)
  if (
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  ) {
    return true;
  }
  // fec0::/10 — site-local (deprecated, but still routable on-link: fec.. / fed.. / fee.. / fef..)
  if (
    ip.startsWith("fec") ||
    ip.startsWith("fed") ||
    ip.startsWith("fee") ||
    ip.startsWith("fef")
  ) {
    return true;
  }
  // ff00::/8 — multicast
  if (ip.startsWith("ff")) return true;

  // Everything below needs the fully-expanded address to read embedded IPv4.
  const g = expandIpv6(ip);
  if (!g) return true; // unparseable — fail closed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  // 6to4 (2002::/16): the embedded IPv4 is the next 32 bits (groups 1 & 2).
  // Block when that embedded v4 is itself private/reserved.
  if (g0 === "2002") {
    return isBlockedIpv4(groupsToIpv4(g1, g2));
  }

  // NAT64 well-known prefix (64:ff9b::/96): embedded IPv4 is the low 32 bits.
  // ACCEPTED RESIDUAL: only the IANA well-known prefix is decoded. Operators may
  // run NAT64 on an arbitrary Network-Specific Prefix (any /96), and there is no
  // way to recognize an arbitrary /96 as "this wraps an embedded IPv4" without
  // treating most of the global-unicast space as NAT64 and over-blocking
  // legitimate hosts. Detecting operator-specific prefixes is backlog, not done
  // here. The connection is still pinned to the validated IP, and any private
  // IPv4 reached over NAT64 from an attacker's network is the operator's own
  // perimeter — not a cross-tenant exfil of OUR metadata/loopback.
  if (g0 === "0064" && g1 === "ff9b" && g2 === "0000" && g3 === "0000") {
    return isBlockedIpv4(groupsToIpv4(g6, g7));
  }

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated): the
  // first 80 bits are zero, optionally followed by ffff, and the low 32 bits
  // hold the embedded IPv4. Covers BOTH dotted (`::ffff:127.0.0.1`) and hex
  // (`::ffff:7f00:1`, `::7f00:1`) encodings — they expand to the same groups.
  const first80Zero =
    g0 === "0000" &&
    g1 === "0000" &&
    g2 === "0000" &&
    g3 === "0000" &&
    g4 === "0000";
  if (first80Zero && (g5 === "0000" || g5 === "ffff")) {
    return isBlockedIpv4(groupsToIpv4(g6, g7));
  }

  return false;
}

function hostMatchesAllowlist(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}

/**
 * Validate that `rawUrl` is safe to fetch: https-only (unless opted in), host
 * not in the metadata/loopback denylist, optionally within an allowlist, and
 * every DNS-resolved IP outside private/reserved ranges.
 *
 * Returns the resolved IPs so callers can pin the connection to a validated IP
 * (defeats DNS-rebinding between check and fetch).
 */
export async function isSafeFetchTarget(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchTargetResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }

  const allowHttp = options.allowHttp ?? false;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return { safe: false, reason: `Disallowed protocol: ${url.protocol}` };
  }

  // Credentials in the URL are a common SSRF/obfuscation vector.
  if (url.username || url.password) {
    return { safe: false, reason: "Credentials in URL are not allowed" };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    return { safe: false, reason: "Empty hostname" };
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: "Blocked hostname" };
  }

  // `URL` keeps the brackets on an IPv6 literal host (e.g. "[::1]"), and
  // isIP("[::1]") === 0, so a bracketed literal would otherwise fall through to
  // the DNS branch and only fail closed by accident ("DNS resolution failed").
  // Strip the surrounding brackets so the literal is classified as an IP and
  // run through the blocklist directly.
  const ipLiteral =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (
    options.allowedHosts &&
    options.allowedHosts.length > 0 &&
    !hostMatchesAllowlist(hostname, options.allowedHosts)
  ) {
    return { safe: false, reason: "Host not in allowlist" };
  }

  // Resolve to IP(s) and validate each. Handles both IP-literal hosts and
  // DNS names that may resolve to internal addresses.
  let resolvedIps: string[];
  const literalFamily = isIP(ipLiteral);
  if (literalFamily !== 0) {
    resolvedIps = [ipLiteral];
  } else {
    const resolve = options.resolveHostname ?? defaultResolver;
    try {
      resolvedIps = await resolve(hostname);
    } catch {
      return { safe: false, reason: "DNS resolution failed" };
    }
  }

  if (resolvedIps.length === 0) {
    return { safe: false, reason: "No DNS records" };
  }

  for (const ip of resolvedIps) {
    if (isBlockedIp(ip)) {
      return { safe: false, reason: "Resolves to a private or reserved IP" };
    }
  }

  return { safe: true, resolvedIps };
}

/** Error thrown when a fetch target is rejected or a body exceeds the cap. */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`Blocked unsafe fetch target: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Build a single-use undici {@link Agent} that PINS every connection it makes to
 * `validatedIp` — the exact address {@link isSafeFetchTarget} already approved.
 *
 * Node's global `fetch` is undici, and undici resolves the request hostname via
 * the connector's `lookup` callback. By forcing that callback to return the
 * pre-validated IP we guarantee the socket connects to the SAME address the
 * guard checked, instead of issuing a fresh, independent DNS resolution at
 * connect time (the DNS-rebinding TOCTOU window).
 *
 * The request hostname is left untouched, so undici still sends the original
 * `Host` header and — for https — uses the hostname as the TLS SNI / certificate
 * validation `servername`. Only the L3 destination is pinned.
 *
 * `validatedIp` MUST be an IP literal that already passed {@link isBlockedIp}.
 * `connectTimeoutMs` bounds how long the socket may spend connecting to the
 * pinned IP (an unbounded connect to an attacker-influenced host is a DoS vector).
 */
function buildPinnedAgent(
  validatedIp: string,
  connectTimeoutMs: number,
): Agent {
  // 4 | 6 (0 is impossible — validatedIp already passed isBlockedIp's isIP gate).
  const family: number = isIP(validatedIp);
  const pinnedLookup: LookupFunction = (
    _hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    // undici (via node:net) calls with `{ all: true }`; honor both shapes so the
    // pinned address is returned regardless of how the socket asks for it.
    if (options.all) {
      callback(null, [{ address: validatedIp, family }]);
    } else {
      callback(null, validatedIp, family);
    }
  };

  return new Agent({
    connect: { lookup: pinnedLookup, timeout: connectTimeoutMs },
    connectTimeout: connectTimeoutMs,
    // One request per agent; no pooling/keep-alive that could outlive the pin.
    pipelining: 0,
  });
}

/**
 * SSRF-safe replacement for `fetch()` for user-supplied URLs.
 *
 * - Validates the initial URL (and host allowlist) via {@link isSafeFetchTarget}.
 * - PINS the connection to the validated IP (see {@link buildPinnedAgent}) so a
 *   low-TTL rebinding record cannot swap a public IP at check time for a
 *   private/metadata IP at connect time.
 * - Follows redirects manually, re-validating AND re-pinning EVERY hop.
 * - Caps the response body at `maxBytes`.
 *
 * Returns a `Response` whose body has already been buffered and re-validated to
 * be within the size cap. Throws {@link SsrfBlockedError} on any unsafe target
 * or oversize body.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<{ response: Response; buffer: Buffer; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const connectTimeoutMs = Math.min(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    timeoutMs,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Per-hop dispatcher that pins the connection to the validated IP. Held at
  // function scope so the outer `finally` always disposes it, even on throw.
  let agent: Agent | undefined;

  try {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const verdict = await isSafeFetchTarget(currentUrl, options);
      if (!verdict.safe) {
        throw new SsrfBlockedError(verdict.reason);
      }

      // Pin THIS hop's connection to an IP the guard just approved. Every IP in
      // resolvedIps passed isBlockedIp(), so the first entry is safe to use.
      const pinnedIp = verdict.resolvedIps[0];
      if (!pinnedIp) {
        throw new SsrfBlockedError("No validated IP to pin");
      }
      // Dispose the previous hop's agent before opening a new connection.
      if (agent) {
        await agent.destroy();
      }
      agent = buildPinnedAgent(pinnedIp, connectTimeoutMs);

      const response = await fetch(currentUrl, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        // undici-only field; absent from the DOM RequestInit typings.
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });

      // Manually handle redirects so each hop is re-validated and re-pinned.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          // No Location header — treat as a terminal response.
          return await bufferResponse(response, currentUrl, maxBytes);
        }
        if (hop === maxRedirects) {
          throw new SsrfBlockedError("Too many redirects");
        }
        // Drain the redirect body so the pinned socket can be torn down cleanly
        // on the next iteration without leaking the connection.
        await response.body?.cancel().catch(() => {});
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      return await bufferResponse(response, currentUrl, maxBytes);
    }

    // Unreachable: loop returns or throws within maxRedirects + 1 iterations.
    throw new SsrfBlockedError("Too many redirects");
  } finally {
    clearTimeout(timer);
    // Force-close the pinned connection. bufferResponse has already drained the
    // terminal body, so nothing in-flight depends on this socket.
    if (agent) {
      await agent.destroy().catch(() => {});
    }
  }
}

async function bufferResponse(
  response: Response,
  finalUrl: string,
  maxBytes: number,
): Promise<{ response: Response; buffer: Buffer; finalUrl: string }> {
  // Fast reject via Content-Length when present.
  const declared = response.headers.get("content-length");
  if (declared) {
    const declaredLen = Number(declared);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      throw new SsrfBlockedError("Response exceeds maximum allowed size");
    }
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new SsrfBlockedError("Response exceeds maximum allowed size");
    }
    return { response, buffer, finalUrl };
  }

  // Stream and enforce the cap incrementally (defends against a lying or
  // absent Content-Length).
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SsrfBlockedError("Response exceeds maximum allowed size");
      }
      chunks.push(value);
    }
  }

  return { response, buffer: Buffer.concat(chunks), finalUrl };
}
