/**
 * MONEY-766 — Client Trust helpers for the custom Clerk sign-in flows.
 *
 * `resolveSignInNextStep` is the single router for Clerk sign-in statuses
 * (sign-in + forgot-password flows): it guards against the "unknown status
 * dead-ends the form" class of bug that `needs_client_trust` exposed.
 * `pickClientTrustFactor` selects the verification factor from Clerk's
 * `supportedSecondFactors` (prefers email_code, falls back to phone_code)
 * and is deliberately defensive about runtime shape.
 *
 * Source: apps/web/components/auth/client-trust.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSignInNextStep,
  pickClientTrustFactor,
} from "@/components/auth/client-trust";

describe("resolveSignInNextStep", () => {
  it("routes complete", () => {
    assert.equal(resolveSignInNextStep("complete"), "complete");
  });

  it("routes needs_second_factor to the TOTP step", () => {
    assert.equal(resolveSignInNextStep("needs_second_factor"), "second_factor");
  });

  it("routes needs_client_trust to the device-verification step", () => {
    assert.equal(resolveSignInNextStep("needs_client_trust"), "client_trust");
  });

  it("treats other known Clerk statuses as unsupported (caller surfaces them)", () => {
    assert.equal(resolveSignInNextStep("needs_new_password"), "unsupported");
    assert.equal(resolveSignInNextStep("needs_first_factor"), "unsupported");
    assert.equal(resolveSignInNextStep("needs_identifier"), "unsupported");
  });

  it("treats null/undefined/garbage as unsupported", () => {
    assert.equal(resolveSignInNextStep(null), "unsupported");
    assert.equal(resolveSignInNextStep(undefined), "unsupported");
    assert.equal(resolveSignInNextStep("client_trust_state"), "unsupported");
  });
});

describe("pickClientTrustFactor", () => {
  const email = {
    strategy: "email_code",
    emailAddressId: "idn_email_1",
    safeIdentifier: "s•••@gmail.com",
  };
  const phone = {
    strategy: "phone_code",
    phoneNumberId: "idn_phone_1",
    safeIdentifier: "+91••••••21",
  };

  it("prefers email_code over phone_code regardless of order", () => {
    assert.equal(pickClientTrustFactor([phone, email])?.strategy, "email_code");
    assert.equal(pickClientTrustFactor([email, phone])?.strategy, "email_code");
  });

  it("carries the ids + masked identifier through", () => {
    const f = pickClientTrustFactor([email]);
    assert.equal(f?.emailAddressId, "idn_email_1");
    assert.equal(f?.safeIdentifier, "s•••@gmail.com");
    assert.equal(f?.phoneNumberId, undefined);
  });

  it("falls back to phone_code when email is not offered", () => {
    const f = pickClientTrustFactor([phone]);
    assert.equal(f?.strategy, "phone_code");
    assert.equal(f?.phoneNumberId, "idn_phone_1");
  });

  it("ignores junk entries and unknown strategies", () => {
    const f = pickClientTrustFactor([
      null,
      42,
      "totp",
      { strategy: "totp" },
      phone,
    ]);
    assert.equal(f?.strategy, "phone_code");
  });

  it("returns null for non-arrays and empty/no-match arrays", () => {
    assert.equal(pickClientTrustFactor(null), null);
    assert.equal(pickClientTrustFactor(undefined), null);
    assert.equal(pickClientTrustFactor("email_code"), null);
    assert.equal(pickClientTrustFactor([]), null);
    assert.equal(pickClientTrustFactor([{ strategy: "totp" }]), null);
  });

  it("drops non-string id fields instead of propagating them", () => {
    const f = pickClientTrustFactor([
      { strategy: "email_code", emailAddressId: 123, safeIdentifier: null },
    ]);
    assert.equal(f?.strategy, "email_code");
    assert.equal(f?.emailAddressId, undefined);
    assert.equal(f?.safeIdentifier, undefined);
  });
});
