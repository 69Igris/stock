/**
 * Secure Encryption for Sensitive Data
 * Using Node.js crypto for AES-256-GCM encryption
 */

import crypto from "crypto";

export interface EncryptedData {
  encrypted: string;
  iv: string;
  authTag: string;
}

/**
 * Generate a random encryption key (32 bytes = 64 hex chars)
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * SecureEncryption class for encrypting/decrypting sensitive data
 */
export class SecureEncryption {
  private key: Buffer;

  constructor(encryptionKey?: string) {
    const key = encryptionKey || process.env.ENCRYPTION_KEY;

    if (!key) {
      throw new Error(
        "ENCRYPTION_KEY is required. Set the env var (64-char hex) or pass it to the constructor. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    if (key.length === 64) {
      // Hex string (64 chars = 32 bytes)
      this.key = Buffer.from(key, "hex");
    } else if (key.length === 32) {
      // Raw 32-byte string
      this.key = Buffer.from(key);
    } else {
      // Hash any other length key to 32 bytes
      this.key = crypto.createHash("sha256").update(key).digest();
    }
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  encrypt<T extends object>(data: T): EncryptedData {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
      const plaintext = JSON.stringify(data);
      let encrypted = cipher.update(plaintext, "utf8", "hex");
      encrypted += cipher.final("hex");
      const authTag = cipher.getAuthTag();

      return {
        encrypted,
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
      };
    } catch (error) {
      console.error("Encryption failed:", error);
      throw new Error("Failed to encrypt data");
    }
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  decrypt<T = Record<string, unknown>>(
    encrypted: string,
    iv: string,
    authTag: string,
  ): T {
    try {
      const ivBuffer = Buffer.from(iv, "hex");
      const authTagBuffer = Buffer.from(authTag, "hex");
      // MONEY-592 (security audit): reject a truncated GCM auth tag. Node's GCM
      // otherwise accepts short tags (down to 4 bytes), collapsing forgery
      // resistance from 2^-128 toward ~2^-32. A genuine tag is always 16 bytes.
      if (authTagBuffer.length !== 16) {
        throw new Error("Invalid auth tag length");
      }
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        ivBuffer,
        { authTagLength: 16 },
      );
      decipher.setAuthTag(authTagBuffer);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return JSON.parse(decrypted) as T;
    } catch (error) {
      console.error("Decryption failed:", error);
      throw new Error("Failed to decrypt data");
    }
  }

  /**
   * Hash data using SHA-256
   */
  async hash(data: string): Promise<string> {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  /**
   * Timing-safe string comparison
   */
  secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}

// Singleton instance
let encryptionInstance: SecureEncryption | null = null;

/**
 * Get singleton encryption instance. Throws if `ENCRYPTION_KEY` is not set.
 *
 * Constructor throws on missing key (MONEY-285) - the previous all-zero
 * `Buffer.alloc(32, 0)` fallback let workers boot with a deterministic
 * dev key in production. Removed.
 */
export function getEncryption(): SecureEncryption {
  if (!encryptionInstance) {
    encryptionInstance = new SecureEncryption();
  }
  return encryptionInstance;
}

/**
 * Startup assertion - call from worker/web/api entrypoints to fail fast
 * when `ENCRYPTION_KEY` is missing, before any request hits a broker
 * credential decrypt path. Idempotent; reuses the singleton.
 */
export function assertEncryptionKey(): void {
  // Construction throws on a missing key - that's the assertion.
  getEncryption();
}

/**
 * Reset the singleton - test-only helper so a `delete process.env.ENCRYPTION_KEY`
 * scenario can re-trigger the constructor guard. Not exported for production
 * use; the singleton is intentionally lazy and process-lifetime-bound.
 */
export function __resetEncryptionForTests(): void {
  encryptionInstance = null;
}

/**
 * Convenience methods for encryption operations
 */
export const encryption = {
  encrypt: <T extends object>(data: T) => getEncryption().encrypt(data),
  decrypt: <T = Record<string, unknown>>(
    encrypted: string,
    iv: string,
    authTag: string,
  ) => getEncryption().decrypt<T>(encrypted, iv, authTag),
  hash: (data: string) => getEncryption().hash(data),
  secureCompare: (a: string, b: string) => getEncryption().secureCompare(a, b),
};
