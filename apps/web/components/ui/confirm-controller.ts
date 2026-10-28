/**
 * Pure promise bookkeeping behind `usePfConfirm` (MONEY-764).
 *
 * `window.confirm` call sites read imperatively — `const ok = await
 * confirm(...)` — so the styled replacement keeps that shape: `request()`
 * returns a promise that settles when the user answers the dialog. This
 * module owns ONLY the resolver state (no React, no DOM) so the contract is
 * unit-testable: one pending request at a time, a newer request cancels the
 * older one (resolves false), dismiss == cancel, double-settle is a no-op.
 */

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

export interface ConfirmController {
  /** Open a confirm; resolves true (confirm) / false (cancel or dismissed). */
  request(options: ConfirmOptions): Promise<boolean>;
  /** Settle the pending request (dialog button / dismiss). No-op when idle. */
  settle(ok: boolean): void;
  /** The options of the pending request, or null when idle. */
  pending(): ConfirmOptions | null;
}

/**
 * @param onChange notified with the pending options (or null when settled) —
 * the hook bridges this to React state to mount/unmount the dialog.
 */
export function createConfirmController(
  onChange?: (pending: ConfirmOptions | null) => void
): ConfirmController {
  let resolver: ((ok: boolean) => void) | null = null;
  let current: ConfirmOptions | null = null;

  function settle(ok: boolean): void {
    const resolve = resolver;
    resolver = null;
    current = null;
    if (resolve) {
      onChange?.(null);
      resolve(ok);
    }
  }

  return {
    request(options: ConfirmOptions): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        // A second confirm while one is open cancels the first — the caller
        // awaiting it unblocks with false instead of hanging forever.
        settle(false);
        resolver = resolve;
        current = options;
        onChange?.(options);
      });
    },
    settle,
    pending(): ConfirmOptions | null {
      return current;
    },
  };
}
