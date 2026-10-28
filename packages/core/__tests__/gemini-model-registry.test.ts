/**
 * Gemini model registry — MONEY-229 Phase A, reworked for MONEY-619.
 *
 * Covers the tier-aware routing rework (MONEY-650 ids):
 *   - the 6 live Developer-API models (2.5-flash/-lite/-pro,
 *     3-flash-preview, 3.5-flash, 3.1-pro-preview) with correct
 *     requiresPlan + premium
 *   - resolveBasePlan: QUERY_PACK is a top-up (→ FREE), ULTIMATE → PREMIUM
 *   - rank-based isModelAvailableOnPlan (FREE < PRO < PREMIUM)
 *   - resolveChatModel (fast lane; Pro→Flash downgrade; thinking→Pro)
 *   - resolveResearchModel (deep lane; FREE 2.5-pro, PRO/PREMIUM 3.1-pro)
 *   - getModelLocation (3.x global on the Vertex fallback, 2.5 regional)
 *
 * Source: packages/core/src/gemini/model-registry.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAvailableModelsForUser,
  GEMINI_MODELS,
  REGISTERED_MODEL_IDS,
  DEFAULT_MODEL_FOR_PLAN,
  getModelDefinition,
  isModelAvailableOnPlan,
  isModelAvailable,
  getAvailableGeminiModels,
  getEffectiveCreditCost,
  resolveModelId,
  resolveBasePlan,
  resolveChatModel,
  resolveResearchModel,
  getModelLocation,
  CHAT_MODEL_BY_TIER,
  getPickerModelsForUser,
} from "../src/gemini/model-registry";

// MONEY-650: every id is callable on the Gemini Developer API, available by
// default (the env gate is now empty), so the resolvers return the 3.x models
// unconditionally.

describe("GEMINI_MODELS — registry shape (MONEY-619)", () => {
  it("registers the 7 Gemini + 5 Claude (MONEY-626) models", () => {
    const google = GEMINI_MODELS.filter((m) => m.provider === "google");
    const anthropic = GEMINI_MODELS.filter((m) => m.provider === "anthropic");
    assert.equal(google.length, 7);
    assert.equal(anthropic.length, 5);
    assert.deepEqual(google.map((m) => m.id).sort(), [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    // Every Claude model is founder-gated (MONEY-626).
    assert.ok(anthropic.every((m) => m.founderOnly === true));
  });

  it("MONEY-1314 — gemini-3.7-flash is registered but NEVER offered to a user", () => {
    // Registration is the GATE: `resolveDocParseModel` ignores an unregistered
    // override with a warning, so before this entry existed
    // DOC_PARSE_MODEL=gemini-3.7-flash silently ran the ~48,000-document
    // backfill on gemini-3.5-flash — four times the batch cost.
    assert.ok(getModelDefinition("gemini-3.7-flash"));

    // ...and registering it put it in the USER-FACING PICKER at
    // creditPremium 0. The first version of this test checked
    // CHAT_MODEL_BY_TIER, which is the WRONG GATE:
    // `getPickerModelsForUser` filters on `founderOnly` / `isModelAvailable`
    // and never consults the tier map at all.
    // MONEY-1274: `planId` is now a required argument, and the merged rule
    // consults `internalOnly` BEFORE plan entitlement — so a system-lane model
    // must stay hidden on the HIGHEST plan too, not merely from the allowlist.
    // Widened across plans rather than just satisfying the new signature.
    for (const email of [
      null,
      "someone@example.com",
      "deepshaswat@gmail.com",
    ]) {
      for (const plan of ["FREE", "PRO", "PREMIUM"]) {
        const ids = getPickerModelsForUser(email, plan).map((m) => m.id);
        assert.ok(
          !ids.includes("gemini-3.7-flash"),
          `gemini-3.7-flash is offered in the picker to ${email ?? "an anonymous user"} — ` +
            "it is a document-extraction model, not a chat option",
        );
      }
    }

    // The tier map too, for the same reason it was checked before: the doc
    // lane's model choice is not a chat decision and was never bake-off tested
    // as one.
    assert.ok(!Object.values(CHAT_MODEL_BY_TIER).includes("gemini-3.7-flash"));
  });

  it("[control] a NORMAL model IS offered in the picker", () => {
    // Without this, a picker that returned nothing would satisfy every
    // assertion above and silently remove chat model selection entirely.
    const ids = getPickerModelsForUser("someone@example.com", "FREE").map(
      (m) => m.id,
    );
    assert.ok(
      ids.includes("gemini-2.5-flash"),
      "the picker returned no Flash model",
    );
    assert.ok(ids.length >= 4, `the picker offers only ${ids.length} models`);
  });

  it("internalOnly hides a model from EVERY caller, founder included", () => {
    // `founderOnly` gates behind an allowlist but still shows the model.
    // `internalOnly` means it is not a chat option for anyone — so it is
    // checked before the allowlist, not after.
    const internal = GEMINI_MODELS.filter((m) => m.internalOnly).map(
      (m) => m.id,
    );
    assert.deepEqual(internal, ["gemini-3.7-flash"]);
    // PREMIUM included deliberately: internalOnly must beat the plan gate too.
    //
    // MONEY-1274 — this covers BOTH exports now. The title says "EVERY caller"
    // but it only ever exercised the picker, and `getAvailableModelsForUser`
    // did not filter internalOnly at all, so a system-lane model was hidden
    // from the picker and returned by the availability API.
    for (const email of [null, "deepshaswat@gmail.com"]) {
      for (const plan of ["FREE", "PREMIUM"]) {
        for (const [name, fn] of [
          ["getPickerModelsForUser", getPickerModelsForUser],
          ["getAvailableModelsForUser", getAvailableModelsForUser],
        ] as const) {
          const ids = fn(email, plan).map((m) => m.id);
          for (const id of internal) {
            assert.ok(
              !ids.includes(id),
              `${name} returned internalOnly model ${id} for ${email ?? "anon"} on ${plan}`,
            );
          }
        }
      }
    }
  });
});

describe("resolveBasePlan — QUERY_PACK is a top-up, ULTIMATE → PREMIUM", () => {
  it("collapses any plan id to 3 buckets", () => {
    assert.equal(resolveBasePlan("FREE"), "FREE");
    assert.equal(resolveBasePlan("PRO"), "PRO");
    assert.equal(resolveBasePlan("PREMIUM"), "PREMIUM");
    assert.equal(resolveBasePlan("ULTIMATE"), "PREMIUM");
    assert.equal(resolveBasePlan("QUERY_PACK"), "FREE"); // credit top-up, not a tier
    assert.equal(resolveBasePlan("AI_PRO"), "PREMIUM"); // legacy → PREMIUM
    assert.equal(resolveBasePlan("garbage"), "FREE");
  });
});

describe("isModelAvailableOnPlan — rank-based tier gating", () => {
  it("FREE can pick only FREE models", () => {
    assert.equal(isModelAvailableOnPlan("gemini-2.5-flash", "FREE"), true);
    assert.equal(isModelAvailableOnPlan("gemini-2.5-pro", "FREE"), false);
    assert.equal(
      isModelAvailableOnPlan("gemini-3-flash-preview", "FREE"),
      false,
    );
    assert.equal(
      isModelAvailableOnPlan("gemini-3.1-pro-preview", "FREE"),
      false,
    );
  });

  it("PRO can pick PRO models but NOT the PREMIUM-only 3.5-flash", () => {
    assert.equal(isModelAvailableOnPlan("gemini-3-flash-preview", "PRO"), true);
    assert.equal(isModelAvailableOnPlan("gemini-3.1-pro-preview", "PRO"), true);
    assert.equal(isModelAvailableOnPlan("gemini-2.5-pro", "PRO"), true);
    assert.equal(isModelAvailableOnPlan("gemini-3.5-flash", "PRO"), false);
  });

  it("PREMIUM can pick every Gemini model (Claude is founder/config-gated, not plan-ranked)", () => {
    for (const m of GEMINI_MODELS.filter((x) => x.provider === "google")) {
      assert.equal(isModelAvailableOnPlan(m.id, "PREMIUM"), true);
    }
  });

  it("QUERY_PACK routes as FREE base (top-up, not a tier)", () => {
    assert.equal(
      isModelAvailableOnPlan("gemini-3.1-pro-preview", "QUERY_PACK"),
      false,
    );
    assert.equal(
      isModelAvailableOnPlan("gemini-2.5-flash", "QUERY_PACK"),
      true,
    );
  });

  it("rejects unknown model ids", () => {
    assert.equal(isModelAvailableOnPlan("not-a-model", "PREMIUM"), false);
  });
});

describe("resolveChatModel — fast lane (Flash), Pro→Flash downgrade, thinking", () => {
  it("tier defaults", () => {
    assert.equal(resolveChatModel("FREE"), "gemini-2.5-flash");
    assert.equal(resolveChatModel("PRO"), "gemini-3-flash-preview");
    assert.equal(resolveChatModel("PREMIUM"), "gemini-3.5-flash");
    assert.equal(resolveChatModel("ULTIMATE"), "gemini-3.5-flash");
    assert.equal(resolveChatModel("QUERY_PACK"), "gemini-2.5-flash");
  });

  it("downgrades a Pro pick to the tier Flash (no Pro latency in chat)", () => {
    assert.equal(
      resolveChatModel("PREMIUM", { userPick: "gemini-3.1-pro-preview" }),
      "gemini-3.5-flash",
    );
    assert.equal(
      resolveChatModel("PRO", { userPick: "gemini-3.1-pro-preview" }),
      "gemini-3-flash-preview",
    );
  });

  it("honors an explicit Flash pick the plan allows", () => {
    assert.equal(
      resolveChatModel("FREE", { userPick: "gemini-2.5-flash-lite" }),
      "gemini-2.5-flash-lite",
    );
    // A PRO user can't reach the PREMIUM-only 3.5-flash → tier flash
    assert.equal(
      resolveChatModel("PRO", { userPick: "gemini-3.5-flash" }),
      "gemini-3-flash-preview",
    );
  });

  it("thinking mode routes to the tier's Pro (deep-lane) model", () => {
    assert.equal(
      resolveChatModel("PRO", { thinking: true }),
      "gemini-3.1-pro-preview",
    );
    assert.equal(
      resolveChatModel("PREMIUM", { thinking: true }),
      "gemini-3.1-pro-preview",
    );
    assert.equal(
      resolveChatModel("FREE", { thinking: true }),
      "gemini-2.5-pro",
    );
  });
});

describe("resolveResearchModel — deep lane (Pro)", () => {
  it("tier defaults: FREE 2.5-pro, PRO/PREMIUM 3-pro", () => {
    assert.equal(resolveResearchModel("FREE"), "gemini-2.5-pro");
    assert.equal(resolveResearchModel("PRO"), "gemini-3.1-pro-preview");
    assert.equal(resolveResearchModel("PREMIUM"), "gemini-3.1-pro-preview");
  });

  it("honors an explicit Pro pick the plan allows; ignores a Flash pick", () => {
    assert.equal(
      resolveResearchModel("PRO", "gemini-2.5-pro"),
      "gemini-2.5-pro",
    );
    assert.equal(
      resolveResearchModel("PREMIUM", "gemini-3.5-flash"),
      "gemini-3.1-pro-preview",
    );
    // FREE can't escalate to 3-pro → tier default
    assert.equal(
      resolveResearchModel("FREE", "gemini-3.1-pro-preview"),
      "gemini-2.5-pro",
    );
  });
});

describe("model availability — 3.x GA by default (no env gate)", () => {
  it("all 6 Gemini models are available (Claude is config-gated, MONEY-626)", () => {
    const ids = getAvailableGeminiModels().map((m) => m.id);
    for (const id of [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
    ]) {
      assert.ok(ids.includes(id), `${id} should be available`);
    }
    assert.equal(isModelAvailable("gemini-3-flash-preview"), true);
    assert.equal(isModelAvailable("gemini-3.5-flash"), true);
    assert.equal(isModelAvailable("gemini-3.1-pro-preview"), true);
  });

  it("resolvers return the tier 3.x models (not a 2.5 fallback)", () => {
    assert.equal(resolveChatModel("PRO"), "gemini-3-flash-preview");
    assert.equal(resolveChatModel("PREMIUM"), "gemini-3.5-flash");
    assert.equal(resolveResearchModel("PRO"), "gemini-3.1-pro-preview");
    assert.equal(resolveResearchModel("PREMIUM"), "gemini-3.1-pro-preview");
  });
});

describe("getModelLocation — 3.x global, 2.5 regional", () => {
  it("3.x → global; 2.5 → configured GCP_LOCATION", () => {
    const prior = process.env.GCP_LOCATION;
    process.env.GCP_LOCATION = "asia-south1";
    try {
      assert.equal(getModelLocation("gemini-3-flash-preview"), "global");
      assert.equal(getModelLocation("gemini-3.5-flash"), "global");
      assert.equal(getModelLocation("gemini-3.1-pro-preview"), "global");
      assert.equal(getModelLocation("gemini-2.5-flash"), "asia-south1");
      assert.equal(getModelLocation("gemini-2.5-pro"), "asia-south1");
    } finally {
      if (prior === undefined) delete process.env.GCP_LOCATION;
      else process.env.GCP_LOCATION = prior;
    }
  });
});

describe("getEffectiveCreditCost — premium matrix", () => {
  it("base + premium for paid actions", () => {
    assert.equal(
      getEffectiveCreditCost(
        "l2_research_advanced",
        "gemini-3.1-pro-preview",
        3,
      ),
      5,
    );
    assert.equal(
      getEffectiveCreditCost("l2_research_advanced", "gemini-2.5-pro", 3),
      2,
    );
    assert.equal(
      getEffectiveCreditCost(
        "l2_research_advanced",
        "gemini-3-flash-preview",
        3,
      ),
      3,
    );
  });

  it("clamps at 0 when premium drives negative", () => {
    assert.equal(
      getEffectiveCreditCost("l2_research_fast", "gemini-2.5-pro", 1),
      0,
    );
  });

  it("free chat (l1_*) ignores premium — a thinking turn (non-l1) does not", () => {
    assert.equal(
      getEffectiveCreditCost("l1_flash", "gemini-3.1-pro-preview", 0),
      0,
    );
    // a thinking turn uses a paid (non-l1) action, so the +2 premium applies
    assert.equal(
      getEffectiveCreditCost("l2_chat_thinking", "gemini-3.1-pro-preview", 1),
      3,
    );
  });
});

describe("resolveModelId — saved-pref resolution (rank-based)", () => {
  it("returns a valid pref for the plan", () => {
    assert.equal(
      resolveModelId("gemini-3.1-pro-preview", "PRO"),
      "gemini-3.1-pro-preview",
    );
    assert.equal(
      resolveModelId("gemini-2.5-flash", "FREE"),
      "gemini-2.5-flash",
    );
  });

  it("falls back when the pref out-ranks the plan", () => {
    assert.equal(resolveModelId("gemini-3.5-flash", "PRO"), "gemini-2.5-pro");
    assert.equal(
      resolveModelId("gemini-3.1-pro-preview", "FREE"),
      "gemini-2.5-flash",
    );
  });

  it("falls back for null / unknown", () => {
    assert.equal(resolveModelId(null, "PRO"), "gemini-2.5-pro");
    assert.equal(resolveModelId("not-a-model", "PREMIUM"), "gemini-2.5-pro");
  });
});

describe("DEFAULT_MODEL_FOR_PLAN", () => {
  it("FREE → flash, paid → 2.5-pro, QUERY_PACK → flash", () => {
    assert.equal(DEFAULT_MODEL_FOR_PLAN.FREE, "gemini-2.5-flash");
    assert.equal(DEFAULT_MODEL_FOR_PLAN.PRO, "gemini-2.5-pro");
    assert.equal(DEFAULT_MODEL_FOR_PLAN.PREMIUM, "gemini-2.5-pro");
    assert.equal(DEFAULT_MODEL_FOR_PLAN.QUERY_PACK, "gemini-2.5-flash");
  });
});
