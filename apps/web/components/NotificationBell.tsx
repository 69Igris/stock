"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@usemoney/ui/popover";
import { getUnreadCountAction } from "@/lib/actions/notifications";
import { NotificationDropdown } from "./NotificationDropdown";

const POLL_INTERVAL = 120_000; // 2 minutes

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);

  const fetchCount = useCallback(async () => {
    const result = await getUnreadCountAction();
    if (result?.success && result?.data !== undefined) {
      setUnreadCount(result?.data);
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchCount]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* pf-tb-icon-btn gives us the 36×36 bordered playful button;
            when open we tint it gold (pop-2) with a hard 2px ink shadow
            to match the "active bell" state in the design bundle */}
        <button
          type="button"
          aria-label="Notifications"
          className="pf-tb-icon-btn"
          style={
            open
              ? {
                  background: "var(--pop-2)",
                  boxShadow: "2px 2px 0 var(--ink)",
                  transform: "translate(-1px, -1px)",
                }
              : undefined
          }
        >
          <Bell
            size={15}
            strokeWidth={2.25}
            /* Bell icon stays ink-coloured normally; when open it is ink
               too (gold bg makes it readable on both themes) */
          />

          {/* Unread badge — coral dot with ink border.
              Shows plain dot when count ≤ 1; shows count otherwise
              so it degrades cleanly to a decorative dot. */}
          {unreadCount > 0 && (
            <span
              className="mono"
              style={{
                position: "absolute",
                top: -3,
                right: -3,
                minWidth: 14,
                height: 14,
                borderRadius: 999,
                background: "var(--pop-1)",
                border: "1.5px solid var(--ink)",
                color: "#f7f3e6",
                fontSize: 8,
                fontWeight: 800,
                lineHeight: 1,
                display: "grid",
                placeItems: "center",
                padding: "0 3px",
                letterSpacing: 0,
              }}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      {/* PopoverContent resets its own card chrome — we render a raw
          wrapper so NotificationDropdown can paint the pf-card itself
          with the tilt + shadow from the design bundle. */}
      <PopoverContent
        className="p-0 border-0 bg-transparent shadow-none outline-none"
        align="end"
        sideOffset={10}
        style={{ width: 360, zIndex: 50 }}
      >
        <NotificationDropdown
          onClose={() => setOpen(false)}
          onCountChange={setUnreadCount}
        />
      </PopoverContent>
    </Popover>
  );
}
