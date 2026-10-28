"use client";

/**
 * usePfConfirm — styled, promise-based replacement for `window.confirm`
 * (MONEY-764: native browser dialogs leaked into the playful UI).
 *
 * Keeps the imperative call-site shape native confirm had:
 *
 *   const { confirm, confirmDialog } = usePfConfirm();
 *   ...
 *   const ok = await confirm({ title, description, variant: "destructive" });
 *   if (!ok) return;
 *   ...
 *   return <>{...}{confirmDialog}</>;   // render once, anywhere in the tree
 *
 * The dialog is the app-standard `ConfirmationDialog` (playful AlertDialog
 * reskin, portal-rendered) so it overlays dropdown menus and chat panels
 * alike. Promise bookkeeping lives in the pure `confirm-controller` module.
 */

import { useMemo, useState } from "react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  createConfirmController,
  type ConfirmOptions,
} from "@/components/ui/confirm-controller";

export type { ConfirmOptions };

export function usePfConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: React.ReactNode;
} {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  // One controller per hook instance; identity is stable across renders so
  // `confirm` is safe inside useCallback deps at call sites.
  const controller = useMemo(() => createConfirmController(setPending), []);

  const confirmDialog = pending ? (
    <ConfirmationDialog
      open
      onOpenChange={(open) => {
        // Esc / overlay / cancel all land here as close — that's a "no".
        if (!open) controller.settle(false);
      }}
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      onConfirm={() => controller.settle(true)}
      variant={pending.variant}
    />
  ) : null;

  return { confirm: controller.request, confirmDialog };
}
