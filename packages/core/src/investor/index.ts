/**
 * Investor self-learning model (MONEY-787, B2).
 *
 * Public surface:
 *   - `mastery`  — pure BKT/IRT math (dependency-free).
 *   - `concepts`   — static concept taxonomy + prerequisite DAG (dependency-free).
 *   - `types`      — plain TS interfaces (dependency-free).
 *   - `signal-map` — pure behaviour-signal → concept maps (dependency-free, B3).
 *   - `profile`    — pure `seedProfile`/`updateConceptMastery` PLUS the prisma DB
 *     seams (`applyConceptSignal`, `ensureSeededProfile`).
 *   - `capture`    — prisma DB seams that translate research/chat/roast activity
 *     into mastery nudges + `UserEvent` rows (B3).
 *   - `context`    — prisma DB seam (`assembleUserContext`) + pure formatter
 *     (`formatInvestorContext`) that render the durable investor-memory block
 *     injected into the chat + research prompts (B5).
 *   - `bandit`     — pure outcome-bandit math (dependency-free, B6): Beta priors
 *     from 👍/👎 win-rates + variant selection over explanation framings.
 *   - `bandit-select` — prisma DB seam (`pickExplanationVariant`) that primes the
 *     bandit from a user's recent `ResultFeedback` (B6).
 *
 * Import the granular subpaths (`@usemoney/core/investor/mastery`,
 * `/concepts`, `/signal-map`, `/profile`, `/capture`, `/context`, `/bandit`)
 * from client code to avoid pulling the prisma-backed `profile.ts` /
 * `capture.ts` / `context.ts` / `bandit-select.ts` into a bundle that doesn't
 * need it.
 */

export * from "./types";
export * from "./mastery";
export * from "./concepts";
export * from "./signal-map";
export * from "./profile";
export * from "./capture";
export * from "./context";
export * from "./bandit";
export * from "./bandit-select";
