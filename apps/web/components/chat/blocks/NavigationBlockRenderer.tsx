"use client";

import type { NavigationBlock } from "@usemoney/types";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getIcon } from "@/lib/chat/icon-map";
import "./chat-blocks.css";

interface NavigationBlockRendererProps {
  block: NavigationBlock;
  onLoadReport?: (sessionId: string) => void;
}

export default function NavigationBlockRenderer({
  block,
  onLoadReport,
}: NavigationBlockRendererProps) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        margin: "6px 0",
      }}
    >
      {block.links.map((link, index) => {
        const IconComponent = getIcon(link.icon);

        /* "Load Full Report" / "Show Summary" toggle links */
        const loadReportMatch = link.href.match(
          /^#(?:load-report|collapse-report):(.+)$/
        );
        if (loadReportMatch && onLoadReport) {
          const sessionId = decodeURIComponent(loadReportMatch[1]!);
          return (
            <button
              key={index}
              type="button"
              className="cb-nav-link primary"
              onClick={() => onLoadReport(sessionId)}
            >
              {IconComponent && (
                <IconComponent style={{ width: 13, height: 13 }} />
              )}
              {link.label}
              <ChevronRight style={{ width: 12, height: 12, opacity: 0.7 }} />
            </button>
          );
        }

        return (
          <Link key={index} href={link.href} className="cb-nav-link">
            {IconComponent && (
              <IconComponent style={{ width: 13, height: 13 }} />
            )}
            {link.label}
            <ChevronRight style={{ width: 12, height: 12, opacity: 0.5 }} />
          </Link>
        );
      })}
    </div>
  );
}
