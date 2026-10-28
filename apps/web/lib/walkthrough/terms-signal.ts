/**
 * Shared signal for TermsGate ↔ WalkthroughProvider coordination.
 *
 * TermsGate is the writer: when the terms-acceptance modal is showing
 * for an authenticated user who hasn't accepted yet, it sets
 * `blocking = true` so WalkthroughProvider knows to defer bootstrapping
 * any tour. When the user accepts (or terms aren't applicable - public
 * pages, demo sessions), it clears the flag.
 *
 * WalkthroughProvider is the reader: it skips `maybeBootstrapByRoute`
 * while blocking is true and listens for the event to re-evaluate
 * eligibility once the modal closes. Without this coordination the
 * walkthrough popover renders on top of the TermsGate modal, which is
 * the bug from the cycle-3 review.
 */
const EVENT = "um:terms-blocking-changed";

let _blocking = true; // pessimistic: assume blocking until TermsGate says otherwise

export function setTermsBlocking(blocking: boolean) {
  if (_blocking === blocking) return;
  _blocking = blocking;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { blocking } }));
  }
}

export function isTermsBlocking(): boolean {
  return _blocking;
}

export function onTermsBlockingChange(
  cb: (blocking: boolean) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ blocking: boolean }>).detail;
    if (detail) cb(detail.blocking);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
