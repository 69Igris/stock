import { cn } from "@usemoney/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted/60 animate-shimmer",
        "bg-[length:200%_100%]",
        "bg-gradient-to-r from-slate-800/60 via-slate-700/30 to-slate-800/60",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
