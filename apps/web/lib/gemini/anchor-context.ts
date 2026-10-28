/**
 * Loading the anchored report — MONEY-1274 / MONEY-1155 #32. SERVER ONLY.
 *
 * `parsePageAnchor` reads WHICH report the user is on out of `pagePath`; this
 * is the seam that fetches it. Split from the pure renderer in
 * `anchor-report.ts` for the same reason `investor/context.ts` splits from its
 * formatter: the rendering is unit-testable without a database, and the I/O
 * has one place to be careful in.
 *
 * ## Ownership is the whole security story here
 *
 * `pagePath` arrives in the REQUEST BODY. It is not derived from the session,
 * not validated by routing, and entirely under the caller's control — so
 * `/analysis/<someone-elses-session-id>` is a string anyone can send. Every
 * query below is scoped by `userId`, and that is load-bearing: without it this
 * is an IDOR that leaks another user's research INTO THE MODEL'S CONTEXT, and
 * therefore into the reply text. A `findUnique` on `sessionId` alone would look
 * completely ordinary and be exactly that bug.
 *
 * ## Never throws
 *
 * Same contract as `assembleUserContext`: best-effort, `""` on any miss or
 * error. This block is an enhancement — chat must keep working without it.
 */

import { prisma } from "@usemoney/database";
import type { PageAnchor } from "@usemoney/core/gemini";
import { formatAnchoredReport, type AnchoredReport } from "./anchor-report";
import { formatAnchoredRoast } from "./anchor-roast";

/**
 * `/analysis/<id>` serves TWO different tables. `isAnalysisSessionId` picks
 * between them by id PREFIX, and the client does the same when it loads the
 * page — so the discriminator is duplicated by necessity, not by accident.
 * Kept as a literal list here rather than imported so this server module does
 * not pull in the client routing bundle; the prefixes are pinned by test.
 */
const ANALYSIS_ID_PREFIXES = ["l3-", "l4-"] as const;

function isAnalysisSessionId(sessionId: string): boolean {
  return ANALYSIS_ID_PREFIXES.some((p) => sessionId.startsWith(p));
}

const SELECT = {
  query: true,
  symbols: true,
  status: true,
  report: true,
} as const;

/**
 * The report block for whatever the user has on screen, or `""`.
 *
 * Only the `research` anchor loads anything today. A stock or screener anchor
 * is already fully described by its path, and fetching a company's figures here
 * would duplicate the tools rather than ground the answer in something the user
 * can see.
 */
/** The stored roast fields the renderer needs. Module scope, like SELECT. */
const SELECT_ROAST = {
  mode: true,
  assetType: true,
  status: true,
  score: true,
  result: true,
} as const;

export async function assembleAnchorContext(
  anchor: PageAnchor,
  userId: string,
  sanitize: (text: string) => string
): Promise<string> {
  if (!userId) return "";
  if (!anchor) return "";

  // MONEY-1274 (#43) — the roast page. The anchor already told the model to
  // "ground answers in THIS roast's findings"; until now nothing loaded them,
  // so it was instructed to cite findings it could not see. See anchor-roast.ts.
  if (anchor.kind === "roast") {
    return assembleRoastContext(anchor.roastId, userId, sanitize);
  }

  if (anchor.kind !== "research") return "";

  try {
    const sessionId = anchor.sessionId;

    // userId is in the WHERE, not checked after the read — a post-hoc check is
    // one early return away from being skipped.
    const row: AnchoredReport | null = isAnalysisSessionId(sessionId)
      ? await prisma.analysisSession.findFirst({
          where: { sessionId, userId },
          select: SELECT,
        })
      : await prisma.researchSession.findFirst({
          where: { sessionId, userId },
          select: SELECT,
        });

    if (!row) return "";
    return formatAnchoredReport(row, sanitize);
  } catch {
    // Best-effort. A memory/context failure must never break the chat.
    return "";
  }
}

/**
 * The roast block for `/roast/<id>` — MONEY-1274 (MONEY-1155 #43).
 *
 * ## The id is TWO things
 *
 * `/roast/<id>` carries EITHER a `sessionId` (a UUID, from the async flow) OR
 * the row's Mongo ObjectId. The page itself discriminates on
 * `roastId.includes("-")` (`app/roast/[id]/client.tsx`), because UUIDs have
 * hyphens and ObjectIds do not. This mirrors that rather than guessing: reading
 * only one of the two would return nothing for half the links, and returning
 * nothing here is INVISIBLE — the block is best-effort, so the chat would
 * simply go back to generic answers with no error anywhere.
 *
 * A malformed ObjectId makes Prisma THROW rather than return null, which the
 * outer catch swallows to "" — correct, and the reason the `where` is built
 * defensively rather than trusting the shape.
 *
 * Ownership is scoped exactly as the research read is, and for the same reason:
 * `pagePath` is request-body input, so an unscoped read would leak another
 * user's portfolio findings into this user's model context.
 */
async function assembleRoastContext(
  roastId: string,
  userId: string,
  sanitize: (text: string) => string
): Promise<string> {
  if (!roastId) return "";
  try {
    // `/roast/<id>` carries either a sessionId (UUID) or a Mongo ObjectId, and
    // this used to guess between them with `roastId.includes("-")`. That works
    // only while ObjectIds stay dash-free: any future id format containing a
    // dash would query the wrong column, find nothing, and degrade to "" with
    // no error — the same silent-empty failure this module exists to remove.
    // Ask both instead. `sessionId` is @unique and `id` is the primary key, so
    // the OR matches at most one row, and the userId filter applies to both
    // arms rather than being repeated per branch.
    // The `id` arm is included only when the string COULD be an ObjectId.
    // Prisma rejects a non-ObjectId value for an @db.ObjectId field by throwing
    // for the WHOLE query, so an unconditional OR would blow up on every UUID
    // sessionId — the common case — and degrade to "". This is a validity test
    // the driver requires, not a guess about which column the caller meant: a
    // string that cannot be an ObjectId cannot be an `id`, so dropping that arm
    // loses no match.
    const couldBeObjectId = /^[0-9a-f]{24}$/i.test(roastId);
    const row = await prisma.portfolioRoast.findFirst({
      where: {
        userId,
        OR: couldBeObjectId
          ? [{ sessionId: roastId }, { id: roastId }]
          : [{ sessionId: roastId }],
      },
      select: SELECT_ROAST,
    });
    if (!row) return "";
    return formatAnchoredRoast(row, sanitize);
  } catch (err) {
    // Best-effort, like the research branch — and logged for the same reason.
    console.error("[anchor-context] roast anchor read failed", err);
    return "";
  }
}
