import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface BentoGridProps {
  className?: string;
  children: ReactNode;
}

export const BentoGrid = ({ className, children }: BentoGridProps) => {
  return (
    <div
      className={cn(
        "mx-auto grid max-w-7xl grid-cols-1 gap-4 md:auto-rows-[18rem] md:grid-cols-3",
        className
      )}
    >
      {children}
    </div>
  );
};

interface BentoGridItemProps {
  className?: string;
  title?: string | ReactNode;
  description?: string | ReactNode;
  header?: ReactNode;
  icon?: ReactNode;
}

export const BentoGridItem = ({
  className,
  title,
  description,
  header,
  icon,
}: BentoGridItemProps) => {
  return (
    <div
      className={cn(
        "group/bento row-span-1 flex flex-col justify-between space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 transition duration-200 hover:border-[var(--border-hover)] hover:bg-[var(--bg-card-hover)] hover:shadow-lg",
        className
      )}
    >
      {header}
      <div className="transition duration-200 group-hover/bento:translate-x-2">
        {/* Icon + title on the same line.
            On narrow viewports the title can wrap below the icon if needed
            via `flex-wrap`, but the icon stays on the leading edge so it
            never reads as a separate row. */}
        <div className="flex items-center gap-2 flex-wrap mb-2">
          {icon && <span className="shrink-0 inline-flex">{icon}</span>}
          <div className="font-sans font-bold text-[var(--text-primary)] leading-none">
            {title}
          </div>
        </div>
        <div className="font-sans text-xs font-normal text-[var(--text-dim)]">
          {description}
        </div>
      </div>
    </div>
  );
};
