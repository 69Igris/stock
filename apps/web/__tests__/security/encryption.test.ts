/**
 * Security Encryption Tests
 *
 * Tests for AES-256-GCM encryption utilities.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SecureEncryption,
  generateEncryptionKey,
  encryption,
  assertEncryptionKey,
  __resetEncryptionForTests,
} from "@usemoney/security";

describe("Security Encryption", () => {
  describe("generateEncryptionKey", () => {
    it("should generate a 64-character hex key", () => {
      const key = generateEncryptionKey();
      assert.strictEqual(key.length, 64);
    });

    it("should generate valid hex string", () => {
      const key = generateEncryptionKey();
      assert.ok(/^[a-f0-9]{64}$/i.test(key), "Key should be valid hex");
    });

    it("should generate unique keys each time", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      assert.notStrictEqual(key1, key2);
    });

    it("should generate cryptographically random keys", () => {
      const keys = new Set();
      for (let i = 0; i < 100; i++) {
        keys.add(generateEncryptionKey());
      }
      assert.strictEqual(keys.size, 100, "All keys should be unique");
    });
  });

  describe("SecureEncryption", () => {
    let encryptor: SecureEncryption;

    beforeEach(() => {
      const testKey = generateEncryptionKey();
      encryptor = new SecureEncryption(testKey);
    });

    describe("encrypt", () => {
      it("should encrypt simple object", () => {
        const data = { username: "testuser", password: "secret123" };
        const result = encryptor.encrypt(data);

        assert.ok(result.encrypted, "Should have encrypted data");
        assert.ok(result.iv, "Should have IV");
        assert.ok(result.authTag, "Should have auth tag");
      });

      it("should produce different ciphertext for same data (different IV)", () => {
        const data = { key: "value" };
        const result1 = encryptor.encrypt(data);
        const result2 = encryptor.encrypt(data);

        assert.notStrictEqual(result1.encrypted, result2.encrypted);
        assert.notStrictEqual(result1.iv, result2.iv);
      });

      it("should encrypt nested objects", () => {
        const data = {
          user: {
            profile: {
              name: "Test User",
              settings: { theme: "dark" },
            },
          },
        };
        const result = encryptor.encrypt(data);

        assert.ok(result.encrypted);
      });

      it("should encrypt arrays", () => {
        const data = { items: [1, 2, 3, "four", { five: 5 }] };
        const result = encryptor.encrypt(data);

        assert.ok(result.encrypted);
      });

      it("should produce hex-encoded output", () => {
        const data = { test: "data" };
        const result = encryptor.encrypt(data);

        assert.ok(/^[a-f0-9]+$/i.test(result.encrypted));
        assert.ok(/^[a-f0-9]+$/i.test(result.iv));
        assert.ok(/^[a-f0-9]+$/i.test(result.authTag));
      });

      it("should produce 24-character IV (12 bytes hex)", () => {
        const data = { test: "data" };
        const result = encryptor.encrypt(data);

        assert.strictEqual(result.iv.length, 24);
      });

      it("should produce 32-character auth tag (16 bytes hex)", () => {
        const data = { test: "data" };
        const result = encryptor.encrypt(data);

        assert.strictEqual(result.authTag.length, 32);
      });
    });

    describe("decrypt", () => {
      it("should decrypt encrypted data correctly", () => {
        const original = { username: "testuser", password: "secret123" };
        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt(
          encrypted.encrypted,
          encrypted.iv,
          encrypted.authTag
        );

        assert.deepStrictEqual(decrypted, original);
      });

      it("should decrypt nested objects correctly", () => {
        const original = {
          broker: "ZERODHA",
          credentials: {
            accessToken: "abc123",
            refreshToken: "xyz789",
          },
        };
        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt(
          encrypted.encrypted,
          encrypted.iv,
          encrypted.authTag
        );

        assert.deepStrictEqual(decrypted, original);
      });

      it("should decrypt arrays correctly", () => {
        const original = { items: [1, 2, 3] };
        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt<typeof original>(
          encrypted.encrypted,
          encrypted.iv,
          encrypted.authTag
        );

        assert.deepStrictEqual(decrypted.items, [1, 2, 3]);
      });

      it("should throw error for wrong auth tag", () => {
        const original = { secret: "data" };
        const encrypted = encryptor.encrypt(original);

        // Tamper with auth tag
        const wrongAuthTag = "0".repeat(32);

        assert.throws(
          () =>
            encryptor.decrypt(encrypted.encrypted, encrypted.iv, wrongAuthTag),
          /Failed to decrypt/
        );
      });

      it("should throw error for tampered ciphertext", () => {
        const original = { secret: "data" };
        const encrypted = encryptor.encrypt(original);

        // Tamper with ciphertext
        const tampered = "0".repeat(encrypted.encrypted.length);

        assert.throws(
          () => encryptor.decrypt(tampered, encrypted.iv, encrypted.authTag),
          /Failed to decrypt/
        );
      });

      it("should throw error for wrong IV", () => {
        const original = { secret: "data" };
        const encrypted = encryptor.encrypt(original);

        // Wrong IV
        const wrongIV = "0".repeat(24);

        assert.throws(
          () =>
            encryptor.decrypt(encrypted.encrypted, wrongIV, encrypted.authTag),
          /Failed to decrypt/
        );
      });
    });

    describe("hash", () => {
      it("should produce SHA-256 hash", async () => {
        const hash = await encryptor.hash("test data");
        assert.strictEqual(hash.length, 64); // 32 bytes = 64 hex chars
      });

      it("should produce consistent hash for same input", async () => {
        const hash1 = await encryptor.hash("test data");
        const hash2 = await encryptor.hash("test data");
        assert.strictEqual(hash1, hash2);
      });

      it("should produce different hash for different input", async () => {
        const hash1 = await encryptor.hash("data1");
        const hash2 = await encryptor.hash("data2");
        assert.notStrictEqual(hash1, hash2);
      });

      it("should produce hex-encoded hash", async () => {
        const hash = await encryptor.hash("test");
        assert.ok(/^[a-f0-9]{64}$/i.test(hash));
      });
    });

    describe("secureCompare", () => {
      it("should return true for equal strings", () => {
        const result = encryptor.secureCompare("abc123", "abc123");
        assert.strictEqual(result, true);
      });

      it("should return false for different strings", () => {
        const result = encryptor.secureCompare("abc123", "xyz789");
        assert.strictEqual(result, false);
      });

      it("should return false for different length strings", () => {
        const result = encryptor.secureCompare("short", "longer string");
        assert.strictEqual(result, false);
      });

      it("should return true for empty strings", () => {
        const result = encryptor.secureCompare("", "");
        assert.strictEqual(result, true);
      });

      it("should be case sensitive", () => {
        const result = encryptor.secureCompare("ABC", "abc");
        assert.strictEqual(result, false);
      });
    });
  });

  describe("Key handling", () => {
    it("should accept 64-character hex key", () => {
      const hexKey = "a".repeat(64);
      const enc = new SecureEncryption(hexKey);
      const data = { test: "value" };
      const encrypted = enc.encrypt(data);
      const decrypted = enc.decrypt(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag
      );
      assert.deepStrictEqual(decrypted, data);
    });

    it("should accept 32-character raw key", () => {
      const rawKey = "a".repeat(32);
      const enc = new SecureEncryption(rawKey);
      const data = { test: "value" };
      const encrypted = enc.encrypt(data);
      const decrypted = enc.decrypt(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag
      );
      assert.deepStrictEqual(decrypted, data);
    });

    it("should hash any other length key to 32 bytes", () => {
      const shortKey = "short";
      const enc = new SecureEncryption(shortKey);
      const data = { test: "value" };
      const encrypted = enc.encrypt(data);
      const decrypted = enc.decrypt(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag
      );
      assert.deepStrictEqual(decrypted, data);
    });

    it("should work with same key across encrypt/decrypt", () => {
      const key = generateEncryptionKey();
      const encryptor1 = new SecureEncryption(key);
      const encryptor2 = new SecureEncryption(key);

      const data = { secret: "value" };
      const encrypted = encryptor1.encrypt(data);
      const decrypted = encryptor2.decrypt(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag
      );

      assert.deepStrictEqual(decrypted, data);
    });

    it("should fail to decrypt with different key", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const encryptor1 = new SecureEncryption(key1);
      const encryptor2 = new SecureEncryption(key2);

      const data = { secret: "value" };
      const encrypted = encryptor1.encrypt(data);

      assert.throws(() =>
        encryptor2.decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag)
      );
    });
  });

  describe("encryption singleton", () => {
    it("should have encrypt method", () => {
      assert.ok(typeof encryption.encrypt === "function");
    });

    it("should have decrypt method", () => {
      assert.ok(typeof encryption.decrypt === "function");
    });

    it("should have hash method", () => {
      assert.ok(typeof encryption.hash === "function");
    });

    it("should have secureCompare method", () => {
      assert.ok(typeof encryption.secureCompare === "function");
    });
  });

  // MONEY-285 - verify the all-zero `Buffer.alloc(32, 0)` fallback has
  // been removed. Constructor must throw when neither an explicit key
  // nor `ENCRYPTION_KEY` is available. Singleton + assertEncryptionKey
  // share the same guard.
  //
  // Uses inline try/finally (not beforeEach/afterEach) - node:test's
  // --test-force-exit can race with hook scheduling and skip tests.
  describe("MONEY-285 - missing key must throw, never fall back to all-zero", () => {
    function withMissingKey(fn: () => void): void {
      const saved = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      __resetEncryptionForTests();
      try {
        fn();
      } finally {
        if (saved === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = saved;
        __resetEncryptionForTests();
      }
    }

    it("constructor throws when no key arg and no ENCRYPTION_KEY env", () => {
      withMissingKey(() => {
        assert.throws(
          () => new SecureEncryption(),
          /ENCRYPTION_KEY is required/
        );
      });
    });

    it("constructor throws on empty-string key with no env", () => {
      withMissingKey(() => {
        assert.throws(
          () => new SecureEncryption(""),
          /ENCRYPTION_KEY is required/
        );
      });
    });

    it("constructor accepts explicit key even when env unset, and produces a working encryptor", () => {
      withMissingKey(() => {
        const key = generateEncryptionKey();
        const enc = new SecureEncryption(key);
        const data = { secret: "v" };
        const encrypted = enc.encrypt(data);
        const round = enc.decrypt<typeof data>(
          encrypted.encrypted,
          encrypted.iv,
          encrypted.authTag
        );
        assert.deepStrictEqual(round, data);
      });
    });

    it("getEncryption() singleton throws when env unset", () => {
      withMissingKey(() => {
        assert.throws(
          () => encryption.encrypt({ x: 1 }),
          /ENCRYPTION_KEY is required/
        );
      });
    });

    it("getEncryption() singleton succeeds when env is set", () => {
      withMissingKey(() => {
        process.env.ENCRYPTION_KEY = generateEncryptionKey();
        __resetEncryptionForTests();
        const result = encryption.encrypt({ secret: "value" });
        assert.ok(result.encrypted);
        assert.ok(result.iv);
        assert.ok(result.authTag);
      });
    });

    it("assertEncryptionKey() throws when env unset", () => {
      withMissingKey(() => {
        assert.throws(assertEncryptionKey, /ENCRYPTION_KEY is required/);
      });
    });

    it("assertEncryptionKey() does not throw when env is set", () => {
      withMissingKey(() => {
        process.env.ENCRYPTION_KEY = generateEncryptionKey();
        __resetEncryptionForTests();
        assert.doesNotThrow(assertEncryptionKey);
      });
    });

    it("does not warn-then-fallback when key is missing (no all-zero Buffer)", () => {
      withMissingKey(() => {
        let warned = false;
        const origWarn = console.warn;
        console.warn = () => {
          warned = true;
        };
        try {
          assert.throws(() => new SecureEncryption());
        } finally {
          console.warn = origWarn;
        }
        assert.equal(warned, false, "constructor must not warn-then-fallback");
      });
    });
  });
});
