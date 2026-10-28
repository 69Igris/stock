/**
 * Error Sanitization Tests
 *
 * Tests for the error sanitization utilities that convert raw database
 * and system errors into user-friendly messages.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeErrorMessage,
  sanitizeErrors,
} from "../src/error-sanitization";

describe("Error Sanitization", () => {
  describe("sanitizeErrorMessage", () => {
    it("should sanitize unique constraint errors for brokerTradeId", () => {
      const error =
        "Unique constraint failed on the constraint: `Trade_userId_broker_brokerUserId_brokerTradeId_key`";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "This trade already exists (duplicate trade ID)",
      );
    });

    it("should sanitize general unique constraint errors", () => {
      const error =
        "Unique constraint failed on the constraint: `Trade_some_other_key`";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "This trade already exists in your account");
    });

    it("should sanitize transaction API errors", () => {
      const error =
        "Transaction API error: Transaction with { txnNumber: 11 } has been aborted";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Import temporarily failed - please try again",
      );
    });

    it("should sanitize aborted transaction errors", () => {
      const error = "Transaction has been aborted due to timeout";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Import temporarily failed - please try again",
      );
    });

    it("should sanitize connection errors", () => {
      const error = "Connection refused: ECONNREFUSED";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Connection error - please try again");
    });

    it("should sanitize ECONNREFUSED errors", () => {
      const error = "Error: connect ECONNREFUSED 127.0.0.1:27017";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Connection error - please try again");
    });

    it("should sanitize timeout errors", () => {
      const error = "Operation timeout after 30000ms";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Request timed out - please try again");
    });

    it("should sanitize ETIMEDOUT errors", () => {
      const error = "Error: connect ETIMEDOUT";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Request timed out - please try again");
    });

    it("should sanitize Prisma errors", () => {
      const error = "Invalid `prisma.trade.create()` invocation";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Something went wrong - please try again");
    });

    it("should preserve row numbers in error messages", () => {
      const error =
        "Row 5: Unique constraint failed on the constraint: `Trade_userId_broker_brokerUserId_brokerTradeId_key`";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Row 5: This trade already exists (duplicate trade ID)",
      );
    });

    it("should preserve row numbers with nested sanitization", () => {
      const error = "Row 10: Transaction API error: has been aborted";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Row 10: Import temporarily failed - please try again",
      );
    });

    it("should truncate very long error messages", () => {
      const longError = "A".repeat(150);
      const result = sanitizeErrorMessage(longError);
      assert.strictEqual(result.length, 103); // 100 chars + "..."
      assert.ok(result.endsWith("..."));
    });

    it("should sanitize GCP Pub/Sub NOT_FOUND errors", () => {
      const error =
        "5 NOT_FOUND: Resource not found (resource=document-process-qa).";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service temporarily unavailable - please try again later",
      );
    });

    it("should sanitize GCP PERMISSION_DENIED errors", () => {
      const error =
        "7 PERMISSION_DENIED: User not authorized to perform this action.";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service temporarily unavailable - please try again later",
      );
    });

    it("should sanitize GCP UNAVAILABLE errors", () => {
      const error = "14 UNAVAILABLE: The service is currently unavailable.";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service temporarily unavailable - please try again later",
      );
    });

    it("should sanitize GCP DEADLINE_EXCEEDED errors", () => {
      const error = "4 DEADLINE_EXCEEDED: Deadline exceeded after 30s.";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service temporarily unavailable - please try again later",
      );
    });

    it("should sanitize GCP Storage signed URL errors", () => {
      const error = "Failed to generate signed URL: invalid credentials";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Storage service error - please try again");
    });

    it("should sanitize GCP Storage upload URL errors", () => {
      const error = "Failed to generate upload URL: bucket not accessible";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Storage service error - please try again");
    });

    it("should sanitize GCP Storage init errors", () => {
      const error =
        "Failed to initialize GCP Storage: missing credentials file";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Storage service error - please try again");
    });

    it("should sanitize MongoDB E11000 duplicate key errors", () => {
      const error =
        'E11000 duplicate key error collection: stockbook.trades index: _id_ dup key: { _id: "abc123" }';
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "This record already exists");
    });

    it("should sanitize duplicate key errors", () => {
      const error = "duplicate key value violates unique constraint";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "This record already exists");
    });

    it("should sanitize RESOURCE_EXHAUSTED errors", () => {
      const error = "8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service is busy - please try again in a moment",
      );
    });

    it("should sanitize Quota exceeded errors", () => {
      const error = "Quota exceeded for requests per minute";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(
        result,
        "Service is busy - please try again in a moment",
      );
    });

    it("should sanitize PrismaClientValidationError", () => {
      const error = "PrismaClientValidationError: Unknown argument `badField`";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Something went wrong - please try again");
    });

    it("should return original message if no pattern matches", () => {
      const error = "Invalid date format";
      const result = sanitizeErrorMessage(error);
      assert.strictEqual(result, "Invalid date format");
    });

    it("should handle empty string", () => {
      const result = sanitizeErrorMessage("");
      assert.strictEqual(result, "");
    });
  });

  describe("sanitizeErrors", () => {
    it("should sanitize an array of errors", () => {
      const errors = [
        "Unique constraint failed on the constraint: `brokerTradeId`",
        "Transaction API error: has been aborted",
        "Regular error message",
      ];
      const results = sanitizeErrors(errors);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(
        results[0],
        "This trade already exists (duplicate trade ID)",
      );
      assert.strictEqual(
        results[1],
        "Import temporarily failed - please try again",
      );
      assert.strictEqual(results[2], "Regular error message");
    });

    it("should handle empty array", () => {
      const results = sanitizeErrors([]);
      assert.strictEqual(results.length, 0);
    });
  });
});
