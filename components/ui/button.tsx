import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variants = {
  primary: "bg-slate-950 text-white hover:bg-slate-800",
  secondary: "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
};

export function Button({ className, variant = "primary", type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
