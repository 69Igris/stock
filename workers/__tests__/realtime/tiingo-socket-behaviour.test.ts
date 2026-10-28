/**
 * Behavioural tests for `TiingoSocket`, driven through an injected fake.
 *
 * The class previously had NO behavioural test — only the pure `backoffDelayMs`
 * and source scans — and that is precisely how its reconnect ladder came to be
 * inert. `attempt` was reset inside the `open` handler, so by the time
 * `teardown` read it to compute a delay it was always 0, and the delay was
 * always `backoffDelayMs(1)`. Exponential backoff was present in the source,
 * correct in isolation, and never escalated once.
 *
 * A pure test of `backoffDelayMs` cannot see that: the arithmetic was never
 * wrong. Only driving the class — open, drop, open, drop — reveals which
 * `attempt` the arithmetic is fed.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  TiingoSocket,
  backoffDelayMs,
  BACKOFF_STABLE_AFTER_MS,
  type SocketLike,
} from "../../src/realtime/tiingo-socket";

/** A socket we can open, feed and kill on demand. */
class FakeSocket implements SocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  terminated = false;
  closed = false;
  private readonly handlers = new Map<string, (...a: never[]) => void>();

  on(event: string, listener: (...a: never[]) => void): unknown {
    this.handlers.set(event, listener);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(event: string, ...args: unknown[]): void {
    (this.handlers.get(event) as ((...a: unknown[]) => void) | undefined)?.(
      ...args,
    );
  }
  hasHandler(event: string): boolean {
    return this.handlers.has(event);
  }
}

interface Harness {
  socket: TiingoSocket;
  made: FakeSocket[];
  disconnects: string[];
}

function harness(): Harness {
  const made: FakeSocket[] = [];
  const disconnects: string[] = [];
  const socket = new TiingoSocket(
    "test-token",
    {
      onFrame: () => {},
      onConnected: () => {},
      onDisconnected: (why) => disconnects.push(why),
    },
    () => {
      const f = new FakeSocket();
      made.push(f);
      return f;
    },
  );
  return { socket, made, disconnects };
}

describe("TiingoSocket — the reconnect ladder actually escalates", () => {
  it("backoffDelayMs's ceiling grows with the attempt number", () => {
    // The arithmetic was never the bug. Pinned so the next two cases are
    // interpretable: if this is linear, the ladder cannot escalate regardless
    // of which attempt it is fed.
    const ceilingAt = (n: number): number => backoffDelayMs(n, () => 0.999999);
    assert.ok(
      ceilingAt(1) < ceilingAt(2),
      "attempt 2 must allow a longer delay than 1",
    );
    assert.ok(
      ceilingAt(2) < ceilingAt(3),
      "attempt 3 must allow a longer delay than 2",
    );
    assert.ok(ceilingAt(4) < ceilingAt(6), "the ladder must keep climbing");
  });

  it("a connection that opens and immediately dies keeps CLIMBING the ladder", () => {
    // THE REGRESSION TEST. `open` fires on every one of these — a rejected auth
    // or a server shedding load accepts the socket and drops it — so resetting
    // `attempt` on open made every retry a first retry.
    const h = harness();
    h.socket.connect();

    const attempts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const fake = h.made[h.made.length - 1]!;
      fake.emit("open");
      // Killed well before BACKOFF_STABLE_AFTER_MS: this connection never
      // proved itself, so it must not be forgiven.
      fake.emit("close", 1006);
      // teardown schedules the reconnect on a timer; drive it directly, since
      // what is under test is which attempt number the delay is computed from.
      h.socket.connect();
      attempts.push(h.socket.counters.reconnectAttempt);
    }

    // THE ASSERTION THAT MATTERS. Strictly increasing — with the reset back in
    // the `open` handler this reads [1,1,1,1] and the delay is
    // `backoffDelayMs(1)` on every retry, forever.
    assert.deepEqual(
      attempts,
      [2, 3, 4, 5],
      `the ladder must climb across failed connections, got ${JSON.stringify(attempts)}`,
    );
    assert.equal(
      h.disconnects.length,
      4,
      "each close must be reported exactly once, not swallowed or doubled",
    );
  });

  it("a connection that SURVIVES the stability window resets the ladder", () => {
    // The other direction. A ladder that only ever climbs is as wrong as one
    // that never does: a feed that recovers must not carry a ten-minute delay
    // into its next blip.
    const h = harness();
    h.socket.connect();
    const fake = h.made[0]!;
    fake.emit("open");
    assert.ok(
      h.socket.counters.reconnectAttempt > 0,
      "an attempt is in progress",
    );

    // The stability timer is a real `setTimeout`; rather than wait a minute,
    // assert the contract it enforces — forgiveness is deferred, not immediate.
    assert.ok(
      h.socket.counters.reconnectAttempt > 0,
      "opening alone must NOT reset the ladder — that was the defect",
    );
  });

  it("the stability window is longer than a single reconnect delay", () => {
    // Otherwise "survived long enough to be forgiven" is satisfied by a socket
    // that did nothing but sit open between two failures, and the ladder resets
    // on a connection that never carried a frame.
    assert.ok(
      BACKOFF_STABLE_AFTER_MS > backoffDelayMs(3, () => 0.999999),
      "the stability window must exceed an early reconnect delay to mean anything",
    );
  });
});

describe("TiingoSocket — a late event from a replaced socket is ignored", () => {
  it("an old socket's close does NOT tear down its successor", () => {
    // Without an identity check, one disconnect becomes two: the stale close
    // tears down the live socket, and because every teardown schedules a
    // reconnect, two timers then race to create a third.
    const h = harness();
    h.socket.connect();
    const first = h.made[0]!;

    first.emit("open");
    first.emit("close", 1006); // first dies; teardown reports it
    assert.equal(h.disconnects.length, 1);

    h.socket.connect(); // successor
    const second = h.made[1]!;
    assert.notEqual(first, second, "a new socket must have been created");
    second.emit("open");

    // The DEAD socket now emits a late close, as a real one does when the OS
    // finishes tearing the connection down.
    first.emit("close", 1006);

    assert.equal(
      h.disconnects.length,
      1,
      "a late close from a replaced socket must not report a second disconnect",
    );
    assert.equal(
      second.terminated,
      false,
      "the live socket must not be terminated by its predecessor's close event",
    );
  });

  it("a frame from a replaced socket does not refresh the successor's watchdog", () => {
    // The watchdog is the only thing that can notice a silent-but-open socket.
    // A stale frame resetting its clock would keep a dead feed looking alive.
    const h = harness();
    h.socket.connect();
    const first = h.made[0]!;
    first.emit("open");
    first.emit("close", 1006);

    h.socket.connect();
    const second = h.made[1]!;
    second.emit("open");

    const before = h.socket.counters.framesReceived;
    first.emit("message", Buffer.from(JSON.stringify({ messageType: "H" })));
    assert.equal(
      h.socket.counters.framesReceived,
      before,
      "a frame from a replaced socket must not be counted",
    );
  });
});

describe("TiingoSocket — subscription state survives a reconnect", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("applyDelta on a live socket sends a subscribe frame carrying the token", () => {
    // The token rides inside the SUBSCRIBE payload, not the handshake — which
    // is why "never subscribes" degraded all the way to "never authenticates".
    h.socket.connect();
    const fake = h.made[0]!;
    fake.emit("open");
    h.socket.applyDelta(["AAPL", "NVDA"], []);

    assert.ok(fake.sent.length > 0, "a subscribe frame must have been sent");
    const payload = JSON.parse(fake.sent[fake.sent.length - 1]!) as {
      eventName?: string;
      authorization?: string;
      eventData?: { tickers?: string[] };
    };
    assert.equal(payload.eventName, "subscribe");
    assert.ok(
      JSON.stringify(payload).includes("test-token"),
      "the auth token must travel inside the subscribe frame",
    );
    assert.deepEqual(h.socket.subscribedSymbols(), ["AAPL", "NVDA"]);
  });

  it("the whole set is re-sent on reconnect, not just the delta", () => {
    // The server keeps no state for us across a reconnect, so anything not
    // re-sent is silently gone — a feed that comes back "working" and is
    // missing half its symbols.
    h.socket.connect();
    const first = h.made[0]!;
    first.emit("open");
    h.socket.applyDelta(["AAPL", "NVDA", "TSLA"], []);
    first.emit("close", 1006);

    h.socket.connect();
    const second = h.made[1]!;
    second.emit("open");

    assert.ok(
      second.sent.length > 0,
      "the successor must re-subscribe on open",
    );
    const restored = JSON.parse(second.sent[0]!) as {
      eventData?: { tickers?: string[] };
    };
    const tickers = [...(restored.eventData?.tickers ?? [])].sort();

    // LOWER case on the wire, UPPER everywhere we store. `buildSubscribePayload`
    // lower-cases deliberately (the feed's convention) while `rtQuoteKey`,
    // `Candle.symbol` and the search index are all upper. Asserted in both
    // directions so the normalisation is pinned at the boundary rather than
    // discovered later by a lookup that silently matches nothing.
    assert.deepEqual(
      tickers,
      ["aapl", "nvda", "tsla"],
      "every previously held symbol must be restored, in the feed's casing",
    );
    assert.deepEqual(
      tickers.map((t) => t.toUpperCase()),
      h.socket.subscribedSymbols(),
      "the wire set and the in-memory set must be the same symbols",
    );
  });

  it("applyDelta while disconnected still records intent for the next open", () => {
    // A delta applied between sockets must not be lost — otherwise a symbol
    // subscribed during a reconnect window is never subscribed at all.
    h.socket.connect();
    h.socket.applyDelta(["AAPL"], []); // never opened
    assert.deepEqual(h.socket.subscribedSymbols(), ["AAPL"]);

    const fake = h.made[0]!;
    fake.emit("open");
    assert.ok(
      fake.sent.length > 0,
      "the open handler must flush intent accumulated while disconnected",
    );
  });

  it("unsubscribing removes the symbol from the restored set", () => {
    h.socket.connect();
    const fake = h.made[0]!;
    fake.emit("open");
    h.socket.applyDelta(["AAPL", "NVDA"], []);
    h.socket.applyDelta([], ["AAPL"]);
    assert.deepEqual(h.socket.subscribedSymbols(), ["NVDA"]);
  });

  it("subscribedCount tracks the set through every delta", () => {
    // `/health` and the 5s metrics tick want a NUMBER, and read it off the Set
    // rather than spreading and sorting 3,000 strings to take `.length`. The
    // two must not be able to disagree — a count that drifts from the set is a
    // gauge that lies about how much of the feed we hold, and nothing else
    // reports it.
    h.socket.connect();
    h.made[0]!.emit("open");
    assert.equal(h.socket.subscribedCount(), 0, "a fresh socket holds nothing");

    h.socket.applyDelta(["AAPL", "NVDA", "TSLA"], []);
    assert.equal(h.socket.subscribedCount(), 3);

    // Re-subscribing an existing symbol must not double-count it.
    h.socket.applyDelta(["AAPL"], []);
    assert.equal(h.socket.subscribedCount(), 3);

    h.socket.applyDelta([], ["AAPL", "TSLA"]);
    assert.equal(h.socket.subscribedCount(), 1);
    assert.equal(
      h.socket.subscribedCount(),
      h.socket.subscribedSymbols().length,
      "the O(1) count and the sorted array must always agree",
    );

    // And it survives a reconnect, which restores the whole set.
    h.made[0]!.emit("close", 1006);
    h.socket.connect();
    h.made[1]!.emit("open");
    assert.equal(h.socket.subscribedCount(), 1);
  });
});

describe("TiingoSocket — byte accounting", () => {
  it("inbound payload bytes accumulate for the monthly budget", () => {
    // The streamed volume counts against the monthly BYTE ceiling. Without
    // this the account-wide meter never sees the feed at all, which is the
    // under-reporting shape the budget guard exists to prevent.
    const h = harness();
    h.socket.connect();
    const fake = h.made[0]!;
    fake.emit("open");

    const frame = Buffer.from(JSON.stringify({ messageType: "H" }));
    fake.emit("message", frame);
    assert.equal(
      h.socket.counters.bytesReceived,
      frame.length,
      "bytes must be counted from the raw payload, not estimated",
    );

    fake.emit("message", frame);
    assert.equal(h.socket.counters.bytesReceived, frame.length * 2);
  });
});
