import * as React from "react";

import { cn } from "@/lib/utils";

/* ---------- Card ---------- */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface shadow-card", className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between gap-3 px-5 pt-4 pb-3", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-[13px] text-muted", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

/* ---------- Badge ---------- */
const tones = {
  neutral: "bg-subtle text-muted ring-border",
  primary: "bg-primary-soft text-primary ring-primary/20",
  success: "bg-success-soft text-success ring-success/20",
  warning: "bg-warning-soft text-warning ring-warning/25",
  danger: "bg-danger-soft text-danger ring-danger/20",
  info: "bg-info-soft text-info ring-info/20",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "neutral", className, dot, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}
      {...props}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/* ---------- Skeleton ---------- */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-subtle", className)} {...props} />;
}

/* ---------- Avatar ---------- */
const avatarColors = ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#14B8A6", "#F97316"];
export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const color = avatarColors[(name.charCodeAt(0) + name.length) % avatarColors.length];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38), backgroundColor: color }}
      title={name}
      aria-label={name}
    >
      {letters || "?"}
    </span>
  );
}

/* ---------- Progress ---------- */
export function ProgressBar({ value, tone, className, label }: { value: number; tone?: "primary" | "success" | "warning" | "danger"; className?: string; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const auto = tone ?? (value >= 100 ? "danger" : value >= 90 ? "warning" : value >= 75 ? "warning" : "primary");
  const color = { primary: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[auto];
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-subtle", className)}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/* ---------- Table ---------- */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border bg-surface-2", className)} {...props} />;
}
export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&>tr:last-child]:border-0", className)} {...props} />;
}
export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border transition-colors hover:bg-surface-2/70 data-[selected=true]:bg-primary-soft/50", className)} {...props} />;
}
export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("h-9 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted", className)} {...props} />;
}
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

/* ---------- Separator ---------- */
export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" className={cn(vertical ? "w-px self-stretch" : "h-px w-full", "bg-border", className)} />;
}

/* ---------- Kbd ---------- */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>;
}
