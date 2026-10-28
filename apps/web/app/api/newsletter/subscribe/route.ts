import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { randomBytes } from "crypto";
import { sendEmail, addToNewsletterAudience } from "@usemoney/email";
import { NewsletterVerifyEmail } from "@usemoney/email/templates";
import React from "react";
import { authRateLimiter } from "@usemoney/security/rate-limit";
import {
  SubscribeSchema,
  normalizeEmail,
  handleExistingSubscriber,
  buildVerifyUrl,
  getAppUrl,
  parseIpFromHeader,
  newsletterSuccessMessage,
} from "./route-logic";

export async function POST(request: NextRequest) {
  try {
    const ip = parseIpFromHeader(request.headers.get("x-forwarded-for"));
    const rateLimitResult = await authRateLimiter.check(10, ip);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Content-type-aware parsing. The public blog card can post a native HTML
    // <form> (application/x-www-form-urlencoded or multipart/form-data) with no
    // JS, while the in-page client component posts JSON. Calling request.json()
    // on a urlencoded body throws and surfaces a raw 500 to the user, so branch
    // on content-type and pull the expected fields from formData otherwise.
    const contentType = request.headers.get("content-type") ?? "";
    let body: unknown;
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else {
      const formData = await request.formData();
      const emailField = formData.get("email");
      const nameField = formData.get("name");
      body = {
        email: typeof emailField === "string" ? emailField : undefined,
        name: typeof nameField === "string" ? nameField : undefined,
      };
    }
    const { email, name } = SubscribeSchema.parse(body);

    // Check if already subscribed
    const existing = await prisma.newsletterSubscriber.findUnique({
      where: { email: normalizeEmail(email) },
    });

    if (existing) {
      // ACTIVE / PENDING short-circuit with a "no new email sent" message;
      // UNSUBSCRIBED returns null and falls through to the re-subscribe flow.
      const existingResponse = handleExistingSubscriber(existing.status);
      if (existingResponse) {
        return NextResponse.json(
          { message: existingResponse.message },
          { status: existingResponse.status }
        );
      }

      // Re-subscribe if previously unsubscribed
      if (existing.status === "UNSUBSCRIBED") {
        const verifyToken = randomBytes(32).toString("hex");
        const resolvedName = name || existing.name || undefined;
        await prisma.newsletterSubscriber.update({
          where: { email: normalizeEmail(email) },
          data: {
            status: "PENDING",
            verifyToken,
            unsubscribedAt: null,
            name: resolvedName ?? null,
          },
        });

        // Audience-sync: re-subscribe path — user previously verified, so we
        // can re-add to the newsletter audience immediately without waiting for
        // the email verification click. Fire-and-forget; subscribe still
        // succeeds if Resend hiccups.
        const [firstName, ...rest] = (resolvedName ?? "").trim().split(" ");
        addToNewsletterAudience({
          email: email.toLowerCase(),
          firstName: firstName || undefined,
          lastName: rest.length > 0 ? rest.join(" ") : undefined,
        }).catch((err: unknown) => {
          console.error(
            "[Newsletter Subscribe] Resend audience sync failed:",
            err
          );
        });

        const verifyUrl = buildVerifyUrl(getAppUrl(), verifyToken);

        // Fire-and-forget
        sendEmail({
          to: email.toLowerCase(),
          subject: "Verify your email - UseMoney Newsletter",
          react: React.createElement(NewsletterVerifyEmail, {
            verifyUrl,
            name: firstName || undefined,
          }),
          template: "newsletter-verify",
        });

        return NextResponse.json(
          { message: newsletterSuccessMessage() },
          { status: 200 }
        );
      }
    }

    // Create new subscriber
    const verifyToken = randomBytes(32).toString("hex");
    try {
      await prisma.newsletterSubscriber.create({
        data: {
          email: email.toLowerCase(),
          name: name || null,
          status: "PENDING",
          verifyToken,
          source: "website",
        },
      });
    } catch (createError) {
      // Concurrent double-submit: another in-flight request inserted the row
      // between the findUnique above and this create. Treat the unique-key
      // violation (Prisma P2002) as the already-exists path — the winning
      // request owns the verification email — and return the same success
      // response instead of a 500.
      if (
        typeof createError === "object" &&
        createError !== null &&
        "code" in createError &&
        (createError as { code: string }).code === "P2002"
      ) {
        return NextResponse.json(
          { message: newsletterSuccessMessage() },
          { status: 200 }
        );
      }
      throw createError;
    }

    // Audience-sync: new-subscriber path — subscriber is PENDING until they
    // click the verification link, at which point apps/web/app/api/newsletter/
    // verify/route.ts (which calls addToNewsletterAudience) handles the
    // definitive audience add on confirm. We do an optimistic add here so the
    // contact appears in Resend immediately; if the user never verifies, the
    // backfill script will reconcile. Fire-and-forget — subscribe succeeds even
    // if Resend hiccups.
    const [firstNameNew, ...restNew] = (name ?? "").trim().split(" ");
    addToNewsletterAudience({
      email: email.toLowerCase(),
      firstName: firstNameNew || undefined,
      lastName: restNew.length > 0 ? restNew.join(" ") : undefined,
    }).catch((err: unknown) => {
      console.error("[Newsletter Subscribe] Resend audience sync failed:", err);
    });

    const verifyUrl = buildVerifyUrl(getAppUrl(), verifyToken);

    // Fire-and-forget
    sendEmail({
      to: email.toLowerCase(),
      subject: "Verify your email - UseMoney Newsletter",
      react: React.createElement(NewsletterVerifyEmail, {
        verifyUrl,
        name: firstNameNew || undefined,
      }),
      template: "newsletter-verify",
    });

    return NextResponse.json(
      { message: newsletterSuccessMessage() },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid input" },
        { status: 400 }
      );
    }
    console.error("[Newsletter Subscribe] Error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
