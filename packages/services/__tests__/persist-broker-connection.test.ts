/**
 * persistBrokerConnection contract — REAL export, injected io (MONEY-1062 W2-B).
 *
 * The encrypt → findFirst → update/create upsert was duplicated across the Dhan
 * (connectWithApiKeyAction), Groww, and Angel-One connect paths; it is unified in
 * broker-connection.service.persistBrokerConnection. `@usemoney/services` runs its
 * suite as ESM (no require.cache prisma injection), so the fixture injects a fake
 * prisma + fake encryption via the function's `deps` seam and asserts the
 * contract: encrypt is called with the per-broker credential SHAPE, the token
 * expiry is passed through untouched, the reconnect (update) path clears the
 * legacy plaintext columns, and the create path stamps the sync flags + shard.
 *
 * Source: packages/services/src/broker-connection.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  persistBrokerConnection,
  type PersistBrokerConnectionDeps,
} from "../src/broker-connection.service";

interface RecordedCall {
  method: "findFirst" | "update" | "create";
  args: { where?: Record<string, unknown>; data?: Record<string, unknown> };
}

/** A recording prisma double exposing only the brokerConnection delegate. */
class FakePrisma {
  readonly calls: RecordedCall[] = [];
  existing: { id: string; accountName?: string | null } | null = null;

  call(method: RecordedCall["method"]): RecordedCall | undefined {
    return this.calls.find((c) => c.method === method);
  }

  get brokerConnection() {
    const self = this;
    return {
      findFirst: async (args: RecordedCall["args"]) => {
        self.calls.push({ method: "findFirst", args });
        return self.existing;
      },
      update: async (args: RecordedCall["args"]) => {
        self.calls.push({ method: "update", args });
        return { id: self.existing?.id ?? "u", ...(args.data ?? {}) };
      },
      create: async (args: RecordedCall["args"]) => {
        self.calls.push({ method: "create", args });
        return { id: "created-1", ...(args.data ?? {}) };
      },
    };
  }
}

/** A recording encryption double. */
class FakeEncryption {
  encryptCalledWith: object | null = null;
  encrypt(data: object) {
    this.encryptCalledWith = data;
    return { encrypted: "ENC", iv: "IV", authTag: "TAG" };
  }
}

function makeDeps(prisma: FakePrisma, encryption: FakeEncryption) {
  return {
    prisma: prisma as unknown as NonNullable<
      PersistBrokerConnectionDeps["prisma"]
    >,
    encryption,
  };
}

const EXPIRY = new Date("2026-07-11T00:30:00Z");

describe("persistBrokerConnection — encrypt + expiry passthrough", () => {
  it("encrypts the EXACT credential object it is given, and passes the expiry through", async () => {
    const prisma = new FakePrisma();
    const enc = new FakeEncryption();
    const creds = { accessToken: "AT", userId: "CID" };
    const res = await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "DHAN",
        credentials: creds,
        tokenExpiry: EXPIRY,
        brokerUserId: "CID",
        metadata: { userId: "CID" },
      },
      makeDeps(prisma, enc),
    );
    assert.equal(res.success, true);
    assert.deepEqual(enc.encryptCalledWith, creds);
    const create = prisma.call("create");
    assert.ok(create, "expected a create");
    assert.equal(create!.args.data!.encryptedCreds, "ENC");
    assert.equal(create!.args.data!.iv, "IV");
    assert.equal(create!.args.data!.authTag, "TAG");
    // The expiry is stored verbatim (same Date reference).
    assert.equal(create!.args.data!.tokenExpiry, EXPIRY);
    assert.equal(create!.args.data!.status, "CONNECTED");
  });
});

describe("persistBrokerConnection — create (new connection) per broker", () => {
  it("Dhan: matches by { userId, broker, brokerUserId }, no accountName, sync flags + shard stamped", async () => {
    const prisma = new FakePrisma();
    const res = await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "DHAN",
        credentials: { accessToken: "AT", userId: "CID" },
        tokenExpiry: EXPIRY,
        brokerUserId: "CID",
        metadata: { userId: "CID" },
      },
      makeDeps(prisma, new FakeEncryption()),
    );
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.wasReconnect, false);
    assert.equal(res.data.previousAccountName, null);

    const find = prisma.call("findFirst");
    assert.equal(find!.args.where!.userId, "user-1");
    assert.equal(find!.args.where!.broker, "DHAN");
    assert.equal(find!.args.where!.brokerUserId, "CID");

    const data = prisma.call("create")!.args.data!;
    assert.equal(data.brokerUserId, "CID");
    assert.equal(data.syncHoldings, true);
    assert.equal(data.syncPositions, true);
    assert.equal(data.syncOrders, true);
    assert.notEqual(data.syncBucket, undefined); // stable shard stamped
    assert.deepEqual(data.brokerMetadata, { userId: "CID" });
    // Dhan carries no accountName.
    assert.equal("accountName" in data, false);
  });

  it("Groww: matchByBrokerUserId=false → findFirst where is broker-scoped ONLY (no brokerUserId)", async () => {
    const prisma = new FakePrisma();
    await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "GROWW",
        credentials: { accessToken: "AT", apiKey: "AK", apiSecret: "AS" },
        tokenExpiry: EXPIRY,
        brokerUserId: "groww_abc123",
        accountName: "Groww - groww_abc123",
        metadata: { sessionName: null },
        matchByBrokerUserId: false,
        assignSyncBucket: false,
      },
      makeDeps(prisma, new FakeEncryption()),
    );
    const where = prisma.call("findFirst")!.args.where!;
    assert.equal(where.userId, "user-1");
    assert.equal(where.broker, "GROWW");
    assert.equal(
      "brokerUserId" in where,
      false,
      "groww must NOT key the lookup on the unstable session-derived brokerUserId",
    );
    const data = prisma.call("create")!.args.data!;
    assert.equal(data.accountName, "Groww - groww_abc123");
    assert.deepEqual(data.brokerMetadata, { sessionName: null });
    // MONEY-1062/MONEY-1066: Groww preserves prior behavior — NO syncBucket
    // stamped (excluded from the daily fan-out until MONEY-1066 flips it).
    assert.equal(
      "syncBucket" in data,
      false,
      "groww must not stamp a syncBucket when assignSyncBucket:false",
    );
  });

  it("Angel One: refreshToken-bearing credential shape flows through to encrypt", async () => {
    const prisma = new FakePrisma();
    const enc = new FakeEncryption();
    const creds = {
      accessToken: "AT",
      refreshToken: "RT",
      apiKey: "AK",
      userId: "CLIENT1",
    };
    await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "ANGEL_ONE",
        credentials: creds,
        tokenExpiry: EXPIRY,
        brokerUserId: "CLIENT1",
        accountName: "Angel One - CLIENT1",
        metadata: { clientCode: "CLIENT1" },
      },
      makeDeps(prisma, enc),
    );
    assert.deepEqual(enc.encryptCalledWith, creds);
    const data = prisma.call("create")!.args.data!;
    assert.equal(data.accountName, "Angel One - CLIENT1");
    assert.equal(data.brokerUserId, "CLIENT1");
  });
});

describe("persistBrokerConnection — update (reconnect)", () => {
  it("updates the existing row, resets state, clears legacy plaintext, reports wasReconnect + previous name", async () => {
    const prisma = new FakePrisma();
    prisma.existing = { id: "conn-existing", accountName: "Old Name" };
    const res = await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "ANGEL_ONE",
        credentials: { accessToken: "AT2", userId: "CLIENT1" },
        tokenExpiry: EXPIRY,
        brokerUserId: "CLIENT1",
        accountName: "Angel One - CLIENT1",
        metadata: { clientCode: "CLIENT1" },
      },
      makeDeps(prisma, new FakeEncryption()),
    );
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.wasReconnect, true);
    assert.equal(res.data.previousAccountName, "Old Name");

    assert.equal(
      prisma.call("create"),
      undefined,
      "must not create on reconnect",
    );
    const upd = prisma.call("update")!;
    assert.equal(upd.args.where!.id, "conn-existing");
    const data = upd.args.data!;
    assert.equal(data.status, "CONNECTED");
    assert.equal(data.errorMessage, null);
    assert.equal(data.reconnectAttempts, 0);
    // CRITICAL: any legacy plaintext columns are wiped on reconnect.
    assert.equal(data.accessToken, null);
    assert.equal(data.refreshToken, null);
    // No syncBucket / sync flags re-stamped on update (create-only).
    assert.equal("syncBucket" in data, false);
  });
});

describe("persistBrokerConnection — failure surface", () => {
  it("returns a sanitized ServiceResult error (never throws) when the write fails", async () => {
    const throwingPrisma = {
      brokerConnection: {
        findFirst: async () => null,
        update: async () => {
          throw new Error("boom");
        },
        create: async () => {
          throw new Error("db down (secret-ish detail)");
        },
      },
    };
    const res = await persistBrokerConnection(
      {
        userId: "user-1",
        broker: "DHAN",
        credentials: { accessToken: "AT", userId: "CID" },
        tokenExpiry: EXPIRY,
        brokerUserId: "CID",
      },
      {
        prisma: throwingPrisma as unknown as NonNullable<
          PersistBrokerConnectionDeps["prisma"]
        >,
        encryption: new FakeEncryption(),
      },
    );
    assert.equal(res.success, false);
    if (res.success) return;
    assert.equal(res.error, "Failed to persist broker connection");
    assert.doesNotMatch(res.error, /secret-ish/);
  });
});
