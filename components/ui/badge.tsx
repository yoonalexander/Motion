import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium tracking-wide text-slate-700",
        className,
      )}
      {...props}
    />
  );
}
