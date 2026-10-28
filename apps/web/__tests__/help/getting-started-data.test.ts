/**
 * Getting Started Data Tests
 *
 * Tests for the onboarding steps data module: step structure,
 * sequential numbering, link validity, and content integrity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gettingStartedSteps,
  type GettingStartedStep,
} from "../../app/help/lib/getting-started-data";

describe("Getting Started Data", () => {
  describe("structure", () => {
    it("should export an array of steps", () => {
      assert.ok(Array.isArray(gettingStartedSteps));
      assert.ok(gettingStartedSteps.length > 0);
    });

    it("should have exactly 7 steps", () => {
      assert.strictEqual(gettingStartedSteps.length, 7);
    });

    it("should have all required fields on every step", () => {
      for (const step of gettingStartedSteps) {
        assert.ok(typeof step.step === "number", `Step missing step number`);
        assert.ok(step.title, `Step ${step.step} missing title`);
        assert.ok(step.description, `Step ${step.step} missing description`);
        assert.ok(step.href, `Step ${step.step} missing href`);
        assert.ok(step.linkLabel, `Step ${step.step} missing linkLabel`);
        assert.ok(step.icon, `Step ${step.step} missing icon`);
      }
    });
  });

  describe("sequential numbering", () => {
    it("should be numbered 1 through 7", () => {
      for (let i = 0; i < gettingStartedSteps.length; i++) {
        assert.strictEqual(
          gettingStartedSteps[i].step,
          i + 1,
          `Step at index ${i} has number ${gettingStartedSteps[i].step}, expected ${i + 1}`
        );
      }
    });
  });

  describe("links", () => {
    it("all hrefs should start with /", () => {
      for (const step of gettingStartedSteps) {
        assert.ok(
          step.href.startsWith("/"),
          `Step ${step.step} href "${step.href}" doesn't start with /`
        );
      }
    });

    it("hrefs should reference valid app routes", () => {
      const validRoutes = [
        "/sign-up",
        "/brokers",
        "/dashboard",
        "/tradebook",
        "/paper-trading",
        "/fire",
        "/settings",
        "/pricing",
        "/holdings",
        "/positions",
        "/discover",
        "/analysis",
      ];
      for (const step of gettingStartedSteps) {
        const baseHref = step.href.split("?")[0];
        assert.ok(
          validRoutes.includes(baseHref),
          `Step ${step.step} href "${step.href}" is not a recognized route`
        );
      }
    });
  });

  describe("content quality", () => {
    it("titles should be concise (under 40 chars)", () => {
      for (const step of gettingStartedSteps) {
        assert.ok(
          step.title.length <= 40,
          `Step ${step.step} title too long: "${step.title}" (${step.title.length} chars)`
        );
      }
    });

    it("descriptions should be meaningful (30+ chars)", () => {
      for (const step of gettingStartedSteps) {
        assert.ok(
          step.description.length >= 30,
          `Step ${step.step} description too short: ${step.description.length} chars`
        );
      }
    });

    it("link labels should be short and actionable (under 25 chars)", () => {
      for (const step of gettingStartedSteps) {
        assert.ok(
          step.linkLabel.length <= 25,
          `Step ${step.step} linkLabel too long: "${step.linkLabel}"`
        );
      }
    });
  });

  describe("expected steps", () => {
    it("first step should be account creation", () => {
      assert.strictEqual(gettingStartedSteps[0].step, 1);
      assert.ok(gettingStartedSteps[0].title.toLowerCase().includes("account"));
    });

    it("second step should be broker connection", () => {
      assert.strictEqual(gettingStartedSteps[1].step, 2);
      assert.ok(gettingStartedSteps[1].title.toLowerCase().includes("broker"));
    });

    it("last step should be about upgrading", () => {
      const last = gettingStartedSteps[gettingStartedSteps.length - 1];
      assert.ok(last.title.toLowerCase().includes("upgrade"));
    });
  });
});
