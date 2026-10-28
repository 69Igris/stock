/**
 * Pull likely stock tickers out of a chat-context message stream so the
 * sidebar can offer "Build from this chat" for feeds / alerts.
 *
 * Strategy:
 *   1. Explicit `$TICKER` mentions always win.
 *   2. Bare uppercase tokens 3-12 chars that look like NSE symbols
 *      (letters / digits / -, &) — minus common English caps like RBI,
 *      GST, FY27 etc.
 *
 * This is an MVP — once symbol grounding in the chat pipeline lands,
 * swap to that authoritative list.
 */

const TOKEN_RE =
  /\$([A-Z][A-Z0-9&\-]{1,11})|(?:\b|^)([A-Z][A-Z0-9&\-]{2,11})\b/g;

const STOP_WORDS = new Set([
  // English caps that look like tickers
  "RBI",
  "SEBI",
  "GST",
  "ITR",
  "IPO",
  "NFO",
  "ETF",
  "MF",
  "SIP",
  "STP",
  "SWP",
  "AMC",
  "AUM",
  "NAV",
  "EPS",
  "ROE",
  "ROA",
  "ROI",
  "ROCE",
  "ROIC",
  "EBIT",
  "EBITDA",
  "P&L",
  "PNL",
  "FCF",
  "DCF",
  "API",
  "URL",
  "UI",
  "UX",
  "FAQ",
  "PDF",
  "CSV",
  "USA",
  "USD",
  "INR",
  "EUR",
  "GBP",
  "JPY",
  "EU",
  "UK",
  "CEO",
  "CFO",
  "CTO",
  "COO",
  "MD",
  "VP",
  "HR",
  "IT",
  // Quarter / year shorthand
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "H1",
  "H2",
  "FY",
  "CY",
  // Misc
  "TLDR",
  "TBD",
  "AKA",
  "OK",
  "BTW",
  "IMO",
  "IIRC",
]);

const QUARTER_RE = /^(Q[1-4]|H[1-2])(FY)?\d{0,4}$/;
const FY_RE = /^FY\d{2,4}$/;
const CY_RE = /^CY\d{2,4}$/;

export function detectSymbolsFromText(text: string): string[] {
  if (!text) return [];
  const matches = new Set<string>();
  // Manual regex walk so we don't depend on matchAll() — the web app's
  // tsconfig doesn't enable downlevelIteration, and we want to keep
  // this util small.
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let result: RegExpExecArray | null = re.exec(text);
  while (result) {
    const sym = (result[1] ?? result[2] ?? "").toUpperCase();
    if (
      sym &&
      sym.length >= 2 &&
      !STOP_WORDS.has(sym) &&
      !QUARTER_RE.test(sym) &&
      !FY_RE.test(sym) &&
      !CY_RE.test(sym)
    ) {
      matches.add(sym);
    }
    result = re.exec(text);
  }
  return Array.from(matches);
}

export function detectSymbolsFromMessages(
  messages: Array<{ role?: string; content?: string }>
): string[] {
  // Walk the most recent 6 messages so the prompt card reflects what's
  // *currently* being discussed, not the entire conversation history.
  const recent = messages.slice(-6);
  const acc = new Set<string>();
  for (const m of recent) {
    if (!m?.content) continue;
    for (const sym of detectSymbolsFromText(m.content)) acc.add(sym);
  }
  return Array.from(acc).slice(0, 8);
}
