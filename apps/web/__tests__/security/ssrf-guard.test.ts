/**
 * SSRF guard — user-supplied outbound URL fetch (MONEY-594 A10).
 *
 * Regression coverage for packages/core/src/import/ssrf-guard.ts, the shared
 * defense for the "fetch a user-controlled URL" flows (document import,
 * fetch_url worker action, GCS CSV download). The response body is persisted
 * to GCS + indexed for RAG, so a naive fetch() is a read-SSRF + exfil
 * primitive against cloud metadata / internal services / loopback.
 *
 * IMPORTANT: every assertion below exercises the SHIPPED classifier imported
 * from `@usemoney/core/import` — `isBlockedIp` (and the `@internal`-exported
 * `isBlockedIpv4` / `isBlockedIpv6` / `expandIpv6` / `groupsToIpv4` helpers it
 * dispatches to) and the real `isSafeFetchTarget`. There is NO inline copy of
 * the classifier: a regression in the source is a regression in these tests.
 * The DNS lookup is injected via `isSafeFetchTarget`'s `resolveHostname`
 * option and the redirect loop (`guardedFetch`) drives the real per-hop
 * `isSafeFetchTarget`, so the rebinding / redirect-to-private-IP defense is
 * exercised hermetically (no real DNS, no real sockets).
 *
 * They encode the security contract: metadata/loopback/private/link-local/
 * reserved are REJECTED, a normal https host is ALLOWED, and a 30x Location
 * pointing at a private IP is REJECTED on the re-validated hop.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dns from "node:dns";
import type { LookupOneOptions, LookupAllOptions } from "node:dns";
// The REAL guard under test — no inline mirror. `isSafeFetchTarget` takes an
// injectable `resolveHostname`, so the URL/host/DNS gate is exercised
// hermetically; `isBlockedIp*` are the shipped pure IP classifiers; `safeFetch`
// drives the two-lookup DNS-rebinding regression at the bottom of this file.
import {
  safeFetch,
  isSafeFetchTarget,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  expandIpv6,
  groupsToIpv4,
  SsrfBlockedError as RealSsrfBlockedError,
  type SafeFetchOptions,
} from "@usemoney/core/import";

// ── Test harness over the REAL classifier ──────────────────────────────

type Resolver = (host: string) => Promise<string[]>;
type Verdict =
  | { safe: true; resolvedIps: string[] }
  | { safe: false; reason: string };

interface ClassifyOptions {
  allowHttp?: boolean;
  allowedHosts?: readonly string[];
}

/**
 * Thin adapter that calls the SHIPPED `isSafeFetchTarget`, wiring the test's
 * `(url, resolve, options)` ergonomics onto the real
 * `(url, { resolveHostname, ...options })` signature. The DNS resolver is
 * injected (never real network); IP-literal hosts skip it inside the source.
 * The system-under-test is the real classifier — this only adapts the call shape.
 */
function classifyTarget(
  rawUrl: string,
  resolve: Resolver,
  options: ClassifyOptions = {}
): Promise<Verdict> {
  const opts: SafeFetchOptions = { ...options, resolveHostname: resolve };
  return isSafeFetchTarget(rawUrl, opts);
}

/**
 * Drives the REAL per-hop `isSafeFetchTarget` through a redirect chain, mirroring
 * `safeFetch`'s manual redirect loop. Injected `fetchImpl` returns
 * `{ status, location }` per URL so we can model a 302 → private-IP redirect
 * without real sockets; the SAFETY decision on every hop is the shipped classifier.
 */
async function guardedFetch(
  rawUrl: string,
  resolve: Resolver,
  fetchImpl: (u: string) => Promise<{ status: number; location?: string }>,
  options: ClassifyOptions & { maxRedirects?: number } = {}
): Promise<{ finalUrl: string; status: number }> {
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await classifyTarget(currentUrl, resolve, options);
    if (!verdict.safe) throw new RealSsrfBlockedError(verdict.reason);

    const res = await fetchImpl(currentUrl);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) return { finalUrl: currentUrl, status: res.status };
      if (hop === maxRedirects)
        throw new RealSsrfBlockedError("Too many redirects");
      currentUrl = new URL(res.location, currentUrl).toString();
      continue;
    }
    return { finalUrl: currentUrl, status: res.status };
  }
  throw new RealSsrfBlockedError("Too many redirects");
}

// A resolver that maps a couple of well-known hosts; everything else is a
// public IP. Used so "normal https host" passes without touching real DNS.
const fakeResolve: Resolver = async (host) => {
  const map: Record<string, string[]> = {
    "internal.evil.test": ["169.254.169.254"],
    "rebind.evil.test": ["10.1.2.3"],
    "files.example.com": ["93.184.216.34"], // public
    "cdn.example.com": ["93.184.216.34"],
  };
  return map[host] ?? ["93.184.216.34"];
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("SSRF guard — isBlockedIp (MONEY-594 A10)", () => {
  it("blocks the cloud-metadata IP 169.254.169.254", () => {
    assert.equal(isBlockedIp("169.254.169.254"), true);
  });

  it("blocks the entire 169.254.0.0/16 link-local range", () => {
    assert.equal(isBlockedIp("169.254.0.1"), true);
    assert.equal(isBlockedIp("169.254.255.254"), true);
  });

  it("blocks 10.0.0.0/8 (private)", () => {
    assert.equal(isBlockedIp("10.0.0.1"), true);
    assert.equal(isBlockedIp("10.255.255.255"), true);
  });

  it("blocks 127.0.0.0/8 (loopback)", () => {
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("127.1.2.3"), true);
  });

  it("blocks 172.16.0.0/12 and 192.168.0.0/16 (private)", () => {
    assert.equal(isBlockedIp("172.16.0.1"), true);
    assert.equal(isBlockedIp("172.31.255.255"), true);
    assert.equal(isBlockedIp("192.168.1.1"), true);
  });

  it("does NOT block a normal public IP", () => {
    assert.equal(isBlockedIp("93.184.216.34"), false);
    assert.equal(isBlockedIp("8.8.8.8"), false);
  });

  it("blocks IPv6 loopback (::1) and IPv4-mapped metadata", () => {
    assert.equal(isBlockedIp("::1"), true);
    assert.equal(isBlockedIp("::ffff:169.254.169.254"), true);
    assert.equal(isBlockedIp("fd00::1"), true); // ULA
    assert.equal(isBlockedIp("fe80::1"), true); // link-local
  });

  it("blocks HEX IPv4-mapped private/loopback (::ffff:7f00:1, ::ffff:c0a8:1)", () => {
    // ::ffff:7f00:1 === ::ffff:127.0.0.1 (loopback) — the dotted-only regex missed this.
    assert.equal(isBlockedIp("::ffff:7f00:1"), true);
    // ::ffff:a9fe:a9fe === ::ffff:169.254.169.254 (cloud metadata).
    assert.equal(isBlockedIp("::ffff:a9fe:a9fe"), true);
    // ::ffff:c0a8:1 === ::ffff:192.168.0.1 (private).
    assert.equal(isBlockedIp("::ffff:c0a8:1"), true);
  });

  it("blocks IPv4-compatible (::7f00:1 hex and ::127.0.0.1 dotted)", () => {
    assert.equal(isBlockedIp("::7f00:1"), true); // ::127.0.0.1 hex
    assert.equal(isBlockedIp("::127.0.0.1"), true); // dotted v4-compat
    assert.equal(isBlockedIp("::a9fe:a9fe"), true); // ::169.254.169.254 metadata
  });

  it("blocks NAT64 (64:ff9b::/96) wrapping a private/metadata IPv4", () => {
    assert.equal(isBlockedIp("64:ff9b::7f00:1"), true); // 127.0.0.1
    assert.equal(isBlockedIp("64:ff9b::127.0.0.1"), true);
    assert.equal(isBlockedIp("64:ff9b::a9fe:a9fe"), true); // 169.254.169.254
    assert.equal(isBlockedIp("64:ff9b::169.254.169.254"), true);
  });

  it("blocks 6to4 (2002::/16) wrapping a private/metadata IPv4", () => {
    assert.equal(isBlockedIp("2002:7f00:1::"), true); // 127.0.0.1
    assert.equal(isBlockedIp("2002:a9fe:a9fe::"), true); // 169.254.169.254
    assert.equal(isBlockedIp("2002:c0a8:1::"), true); // 192.168.0.1
    assert.equal(isBlockedIp("2002:0a00:0001::"), true); // 10.0.0.1
  });

  it("blocks site-local fec0::/10 (fec.. / fed.. / fee.. / fef..)", () => {
    assert.equal(isBlockedIp("fec0::1"), true);
    assert.equal(isBlockedIp("fed0::1"), true);
    assert.equal(isBlockedIp("feff::1"), true);
  });

  it("blocks ULA fc00::/7 and link-local fe80::/10 across the whole range", () => {
    assert.equal(isBlockedIp("fc00::1"), true);
    assert.equal(isBlockedIp("fdab::1"), true);
    assert.equal(isBlockedIp("fe80::1"), true);
    assert.equal(isBlockedIp("febf::1"), true);
    assert.equal(isBlockedIp("fe80::1%eth0"), true); // zone id stripped
  });

  it("does NOT over-block a public IPv4 embedded in v6 forms", () => {
    // 93.184.216.34 (public) wrapped as mapped / 6to4 / NAT64 must stay allowed.
    assert.equal(isBlockedIp("::ffff:93.184.216.34"), false);
    assert.equal(isBlockedIp("::ffff:5db8:d822"), false); // hex form of the above
    assert.equal(isBlockedIp("2002:5db8:d822::"), false); // 6to4 of 93.184.216.34
    assert.equal(isBlockedIp("64:ff9b::5db8:d822"), false); // NAT64 of 93.184.216.34
  });

  it("blocks reserved fe00::/9 (fe00..fe7f, just below link-local fe80::/10)", () => {
    // These previously fell through to "allowed"; they are reserved, not global
    // unicast, and must fail closed.
    assert.equal(isBlockedIp("fe00::1"), true); // bottom of the /9
    assert.equal(isBlockedIp("fe40::1"), true); // middle
    assert.equal(isBlockedIp("fe7f:ffff::1"), true); // top, just below fe80
    assert.equal(isBlockedIp("fe7f::1%eth0"), true); // zone id stripped
  });

  it("blocks reserved f800::/6 (f800..fbff, between multicast and ULA/fe80)", () => {
    // Reserved/unassigned space that is NOT global unicast (2000::/3).
    assert.equal(isBlockedIp("f800::1"), true); // bottom of the /6
    assert.equal(isBlockedIp("f900::1"), true);
    assert.equal(isBlockedIp("fa00::1"), true);
    assert.equal(isBlockedIp("fbff:ffff::1"), true); // top, just below fc00 ULA
  });

  it("does NOT over-block normal global-unicast IPv6 (2000::/3)", () => {
    assert.equal(isBlockedIp("2001:4860:4860::8888"), false); // Google DNS
    assert.equal(isBlockedIp("2606:4700:4700::1111"), false); // Cloudflare DNS
    // Boundaries of the 2000::/3 global-unicast block must stay allowed even
    // after the reserved-range additions above.
    assert.equal(isBlockedIp("2000::1"), false); // bottom of 2000::/3
    assert.equal(isBlockedIp("3fff:ffff::1"), false); // top of 2000::/3
  });

  it("treats a non-IP string as unsafe (fail closed)", () => {
    assert.equal(isBlockedIp("not-an-ip"), true);
  });
});

describe("SSRF guard — expandIpv6 / groupsToIpv4 helpers (MONEY-594 A10)", () => {
  // Direct coverage of the SHIPPED low-level helpers the classifier dispatches
  // to (exported @internal). Their correctness underpins every embedded-IPv4
  // (mapped / 6to4 / NAT64) block decision above.
  it("expands :: zero-compression to 8 padded hex groups", () => {
    assert.deepEqual(expandIpv6("::1"), [
      "0000",
      "0000",
      "0000",
      "0000",
      "0000",
      "0000",
      "0000",
      "0001",
    ]);
    assert.deepEqual(expandIpv6("2001:db8::1"), [
      "2001",
      "0db8",
      "0000",
      "0000",
      "0000",
      "0000",
      "0000",
      "0001",
    ]);
  });

  it("rewrites a trailing dotted-quad tail into its two hex groups", () => {
    // ::ffff:127.0.0.1 → low 32 bits = 7f00:0001
    assert.deepEqual(expandIpv6("::ffff:127.0.0.1"), [
      "0000",
      "0000",
      "0000",
      "0000",
      "0000",
      "ffff",
      "7f00",
      "0001",
    ]);
  });

  it("returns null for structurally invalid IPv6 (two '::', bad octet)", () => {
    assert.equal(expandIpv6("1::2::3"), null);
    assert.equal(expandIpv6("::ffff:999.0.0.1"), null);
    assert.equal(expandIpv6("12345::"), null); // group > 4 hex digits
  });

  it("groupsToIpv4 decodes two hex groups to dotted-decimal", () => {
    assert.equal(groupsToIpv4("7f00", "0001"), "127.0.0.1");
    assert.equal(groupsToIpv4("a9fe", "a9fe"), "169.254.169.254");
    assert.equal(groupsToIpv4("5db8", "d822"), "93.184.216.34");
  });
});

describe("SSRF guard — family-specific classifiers isBlockedIpv4/v6 (MONEY-594 A10)", () => {
  // The shipped family classifiers are exported @internal; assert them directly
  // so a regression in either branch is caught independently of the dispatcher.
  it("isBlockedIpv4 blocks private/reserved, allows public", () => {
    assert.equal(isBlockedIpv4("169.254.169.254"), true); // metadata
    assert.equal(isBlockedIpv4("10.0.0.1"), true);
    assert.equal(isBlockedIpv4("127.0.0.1"), true);
    assert.equal(isBlockedIpv4("100.64.0.1"), true); // CGNAT
    assert.equal(isBlockedIpv4("93.184.216.34"), false);
    assert.equal(isBlockedIpv4("999.0.0.1"), true); // malformed → fail closed
  });

  it("isBlockedIpv6 blocks loopback/ULA/link-local/reserved, allows global", () => {
    assert.equal(isBlockedIpv6("::1"), true);
    assert.equal(isBlockedIpv6("fd00::1"), true); // ULA
    assert.equal(isBlockedIpv6("fe80::1"), true); // link-local
    assert.equal(isBlockedIpv6("fe00::1"), true); // reserved fe00::/9
    assert.equal(isBlockedIpv6("f800::1"), true); // reserved f800::/6
    assert.equal(isBlockedIpv6("::ffff:127.0.0.1"), true); // mapped loopback
    assert.equal(isBlockedIpv6("2001:4860:4860::8888"), false); // global unicast
  });
});

describe("SSRF guard — classifyTarget host/DNS gate (MONEY-594 A10)", () => {
  it("blocks metadata.google.internal by hostname", async () => {
    const v = await classifyTarget(
      "https://metadata.google.internal/",
      fakeResolve
    );
    assert.equal(v.safe, false);
    assert.equal((v as { reason: string }).reason, "Blocked hostname");
  });

  it("blocks the 'metadata' short hostname", async () => {
    const v = await classifyTarget(
      "https://metadata/computeMetadata/v1/",
      fakeResolve
    );
    assert.equal(v.safe, false);
  });

  it("blocks localhost by hostname", async () => {
    const v = await classifyTarget("https://localhost/admin", fakeResolve);
    assert.equal(v.safe, false);
    assert.equal((v as { reason: string }).reason, "Blocked hostname");
  });

  it("blocks a literal 127.0.0.1 host (loopback)", async () => {
    const v = await classifyTarget("https://127.0.0.1:8080/", fakeResolve);
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("blocks a literal 10.x host (private)", async () => {
    const v = await classifyTarget("https://10.1.2.3/internal", fakeResolve);
    assert.equal(v.safe, false);
  });

  it("blocks a bracketed IPv6 loopback literal http://[::1]/", async () => {
    // URL keeps the brackets ("[::1]"); the guard must strip them, classify as
    // an IP literal, and block via the v6 blocklist — NOT fall through to DNS.
    const v = await classifyTarget("https://[::1]/admin", fakeResolve);
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("blocks a bracketed IPv4-mapped metadata literal [::ffff:169.254.169.254]", async () => {
    const v = await classifyTarget(
      "https://[::ffff:169.254.169.254]/computeMetadata/v1/",
      fakeResolve
    );
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("blocks a bracketed NAT64 literal [64:ff9b::7f00:1] (loopback)", async () => {
    const v = await classifyTarget(
      "https://[64:ff9b::7f00:1]:8080/",
      fakeResolve
    );
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("blocks a bracketed 6to4 literal [2002:7f00:1::] (loopback)", async () => {
    const v = await classifyTarget("https://[2002:7f00:1::]/", fakeResolve);
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("ALLOWS a bracketed public IPv6 literal [2001:4860:4860::8888]", async () => {
    // The bracket-stripping path must NOT break legitimate global-unicast v6.
    const v = await classifyTarget(
      "https://[2001:4860:4860::8888]/",
      fakeResolve
    );
    assert.equal(v.safe, true);
    assert.deepEqual((v as { resolvedIps: string[] }).resolvedIps, [
      "2001:4860:4860::8888",
    ]);
  });

  it("blocks the metadata IP reached via DNS resolution", async () => {
    // Host looks innocuous but resolves to link-local metadata IP.
    const v = await classifyTarget("https://internal.evil.test/", fakeResolve);
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Resolves to a private or reserved IP"
    );
  });

  it("ALLOWS a normal https host that resolves to a public IP", async () => {
    const v = await classifyTarget(
      "https://files.example.com/report.pdf",
      fakeResolve
    );
    assert.equal(v.safe, true);
    assert.deepEqual((v as { resolvedIps: string[] }).resolvedIps, [
      "93.184.216.34",
    ]);
  });

  it("rejects plain http by default (https-only)", async () => {
    const v = await classifyTarget("http://files.example.com/x", fakeResolve);
    assert.equal(v.safe, false);
    assert.match((v as { reason: string }).reason, /Disallowed protocol/);
  });

  it("rejects non-http(s) schemes (file:, gopher:)", async () => {
    assert.equal(
      (await classifyTarget("file:///etc/passwd", fakeResolve)).safe,
      false
    );
    assert.equal(
      (await classifyTarget("gopher://x/", fakeResolve)).safe,
      false
    );
  });

  it("rejects credentials embedded in the URL", async () => {
    const v = await classifyTarget(
      "https://user:pass@files.example.com/x",
      fakeResolve
    );
    assert.equal(v.safe, false);
    assert.equal(
      (v as { reason: string }).reason,
      "Credentials in URL are not allowed"
    );
  });

  it("enforces an allowlist when provided (host not in allowlist)", async () => {
    const v = await classifyTarget("https://files.example.com/x", fakeResolve, {
      allowedHosts: ["storage.googleapis.com"],
    });
    assert.equal(v.safe, false);
    assert.equal((v as { reason: string }).reason, "Host not in allowlist");
  });
});

describe("SSRF guard — redirect re-validation (MONEY-594 A10)", () => {
  it("blocks a 302 redirect that points at a private IP", async () => {
    // First hop is a clean public host that 302s to a metadata-IP host.
    const fetchImpl = async (u: string) => {
      if (u.startsWith("https://files.example.com")) {
        return { status: 302, location: "https://internal.evil.test/steal" };
      }
      return { status: 200 };
    };
    await assert.rejects(
      () =>
        guardedFetch("https://files.example.com/start", fakeResolve, fetchImpl),
      (err: unknown) =>
        err instanceof RealSsrfBlockedError &&
        /private or reserved IP/.test(err.message)
    );
  });

  it("blocks a redirect straight to a literal loopback URL", async () => {
    const fetchImpl = async (u: string) => {
      if (u.startsWith("https://cdn.example.com")) {
        return { status: 301, location: "https://127.0.0.1/admin" };
      }
      return { status: 200 };
    };
    await assert.rejects(
      () => guardedFetch("https://cdn.example.com/a", fakeResolve, fetchImpl),
      RealSsrfBlockedError
    );
  });

  it("follows a redirect between two public hosts and returns the final hop", async () => {
    const fetchImpl = async (u: string) => {
      if (u === "https://files.example.com/a") {
        return { status: 302, location: "https://cdn.example.com/b" };
      }
      return { status: 200 };
    };
    const out = await guardedFetch(
      "https://files.example.com/a",
      fakeResolve,
      fetchImpl
    );
    assert.equal(out.status, 200);
    assert.equal(out.finalUrl, "https://cdn.example.com/b");
  });

  it("rejects a redirect loop that exceeds maxRedirects", async () => {
    const fetchImpl = async (u: string) => ({
      status: 302,
      location: new URL("/next", u).toString(),
    });
    await assert.rejects(
      () =>
        guardedFetch("https://files.example.com/x", fakeResolve, fetchImpl, {
          maxRedirects: 2,
        }),
      (err: unknown) =>
        err instanceof RealSsrfBlockedError &&
        /Too many redirects/.test(err.message)
    );
  });
});

// ── REAL safeFetch DNS-rebinding TOCTOU regression (MONEY-594 A10) ──────
//
// The blocks above assert the real classifier (`isBlockedIp*` /
// `isSafeFetchTarget`) with an injected resolver; this final block exercises the
// full `safeFetch` from @usemoney/core/import to prove the connection is pinned
// to the IP the validator approved — defeating a low-TTL rebind that returns a
// public IP to the validator and a private/metadata IP at connect time.
//
// Mechanism (no real network, no module mocks — runs in the default
// `yarn test` runner):
//   • A loopback TCP "rebind sentinel" stands in for the attacker's
//     private/metadata target. If safeFetch ever performs a SECOND, independent
//     DNS resolution at connect time, undici's default connector resolves via
//     node:dns.lookup — which we TRAP to return the sentinel's loopback IP, so
//     the socket would land on the sentinel.
//   • safeFetch's validator resolves via the injected `resolveHostname`, which
//     returns a PUBLIC IP (passes the blocklist). The fix pins the connection to
//     that public IP, so the connect-time trap is never consulted and the
//     sentinel is never reached.
//
// Assertion: sentinel hit-count and connect-time trap call-count are BOTH zero,
// while the same trap+sentinel demonstrably fire for an un-pinned `fetch`
// (positive control) — so the test distinguishes the fixed code from the hole.

describe("SSRF guard — real safeFetch IP-pinning vs DNS rebinding (MONEY-594 A10)", () => {
  // Public IP the validator is told the host resolves to (passes blocklist).
  const PUBLIC_IP = "203.0.113.10"; // TEST-NET-3, classified public
  // The rebind target a vulnerable connect-time resolution would yield.
  const REBIND_HOST = "rebind-toctou.invalid";

  let sentinel: net.Server;
  let sentinelPort = 0;
  let sentinelHits = 0;
  let connectTrapHits = 0;
  const realDnsLookup = dns.lookup;

  // Let any trailing socket close/error callbacks (e.g. an aborted black-hole
  // connect being torn down by undici) flush before the next test / teardown.
  const quiesce = () => new Promise<void>((r) => setTimeout(r, 250));

  before(async () => {
    sentinel = net.createServer((sock) => {
      sentinelHits += 1;
      sock.end();
    });
    await new Promise<void>((resolve) =>
      sentinel.listen(0, "127.0.0.1", resolve)
    );
    const addr = sentinel.address();
    sentinelPort = typeof addr === "object" && addr ? addr.port : 0;

    // Trap the connect-time resolver. ONLY our test host is intercepted (and
    // pointed at the loopback sentinel); every other lookup is delegated to the
    // real resolver so unrelated DNS keeps working.
    const trapped: typeof dns.lookup = ((
      hostname: string,
      optionsOrCb: unknown,
      maybeCb?: unknown
    ) => {
      if (hostname !== REBIND_HOST) {
        return (realDnsLookup as unknown as (...a: unknown[]) => unknown)(
          hostname,
          optionsOrCb,
          maybeCb
        );
      }
      connectTrapHits += 1;
      const options = (typeof optionsOrCb === "function" ? {} : optionsOrCb) as
        | LookupOneOptions
        | LookupAllOptions;
      const cb = (
        typeof optionsOrCb === "function" ? optionsOrCb : maybeCb
      ) as (
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number
      ) => void;
      if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
      return undefined;
    }) as typeof dns.lookup;
    // Override the callback resolver for the test seam (typed as typeof
    // dns.lookup, so the assignment type-checks without a suppression).
    dns.lookup = trapped;
  });

  after(async () => {
    // Restore the real resolver.
    dns.lookup = realDnsLookup;
    // Drain any trailing socket callbacks before tearing the server down.
    await quiesce();
    await new Promise<void>((resolve) => sentinel.close(() => resolve()));
  });

  // A single sequential test (rather than three) so the real-socket steps share
  // one test boundary — this keeps node:test's pending-op detector from flagging
  // cross-test residue from an aborted black-hole connect.
  it("pins to the validated IP, never to a rebound private IP, and refuses private-only resolution", async () => {
    const url = `http://${REBIND_HOST}:${sentinelPort}/`;

    // ── Step 1 — positive control ─────────────────────────────────────
    // Prove the trap+sentinel actually fire on a NORMAL DNS-driven connect, so
    // the negative assertions below are not vacuous. A plain net.connect to the
    // host resolves via node:dns.lookup (trapped) → loopback sentinel. This is
    // the un-pinned/vulnerable shape: resolve-then-connect with NO pin. (Plain
    // node:net here — not undici — so this control never touches undici's
    // global dispatcher state.)
    sentinelHits = 0;
    connectTrapHits = 0;
    await new Promise<void>((resolve) => {
      const probe = net.connect(
        { host: REBIND_HOST, port: sentinelPort },
        () => {
          probe.destroy();
          resolve();
        }
      );
      probe.on("error", () => resolve());
    });
    assert.equal(
      connectTrapHits >= 1,
      true,
      "control: a normal connect should consult the connect-time resolver"
    );
    assert.equal(
      sentinelHits >= 1,
      true,
      "control: a normal connect should reach the rebind sentinel"
    );
    await quiesce();

    // ── Step 2 — the fix: safeFetch pins to the validated public IP ────
    // The validator (resolveHostname) returns a PUBLIC IP (passes the
    // blocklist). A real low-TTL rebind would hand a PRIVATE IP to the connect
    // step instead — modeled by the node:dns.lookup trap that points at the
    // loopback sentinel. With the pin in force, the socket goes to the public
    // IP (203.0.113.10 — unreachable here) and the trap/sentinel are bypassed.
    sentinelHits = 0;
    connectTrapHits = 0;
    let validatorCalls = 0;
    const publicResolver = async (host: string): Promise<string[]> => {
      assert.equal(host, REBIND_HOST);
      validatorCalls += 1;
      return [PUBLIC_IP];
    };
    await assert.rejects(
      () =>
        safeFetch(
          url,
          {},
          {
            allowHttp: true,
            resolveHostname: publicResolver,
            timeoutMs: 5000,
            connectTimeoutMs: 200, // bound the unreachable connect; keep it fast
          }
        ),
      (err: unknown) =>
        // A connect failure to the pinned public IP is fine; an SSRF "private"
        // block would mean the pin leaked a private IP — that must NOT happen.
        err instanceof Error &&
        !(
          err instanceof RealSsrfBlockedError &&
          /private or reserved/.test(err.message)
        )
    );
    assert.equal(validatorCalls, 1, "validator should resolve exactly once");
    assert.equal(
      connectTrapHits,
      0,
      "FIXED: connect must NOT perform a second DNS resolution (pin in force)"
    );
    assert.equal(
      sentinelHits,
      0,
      "FIXED: the rebind/private IP must NEVER be connected to"
    );
    await quiesce();

    // ── Step 3 — straightforward rebind-defeat (refuse, no socket) ─────
    // If the validator itself sees the metadata IP, the request is blocked
    // before any socket opens.
    sentinelHits = 0;
    connectTrapHits = 0;
    await assert.rejects(
      () =>
        safeFetch(
          url,
          {},
          {
            allowHttp: true,
            resolveHostname: async () => ["169.254.169.254"],
            timeoutMs: 3000,
          }
        ),
      (err: unknown) =>
        err instanceof RealSsrfBlockedError &&
        /private or reserved/.test(err.message)
    );
    assert.equal(sentinelHits, 0);
    assert.equal(connectTrapHits, 0);
  });
});
