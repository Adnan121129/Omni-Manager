import * as React from "react";

import { formatMoney } from "@/lib/format";

/** Chart palette shared by every chart so series read consistently across pages (light & dark). */
export const CHART = {
  primary: "#6366F1",
  success: "#22C55E",
  neutral: "#94A3B8",
  warning: "#F59E0B",
  danger: "#EF4444",
  info: "#0EA5E9",
  series: ["#6366F1", "#0EA5E9", "#22C55E", "#F59E0B", "#EC4899", "#8B5CF6", "#14B8A6", "#F97316"],
};

export const axisProps = {
  tick: { fill: "var(--muted)", fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

export function ChartTooltip({ active, payload, label, currency, unit }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  currency?: string;
  unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      {label && <p className="mb-1 font-medium">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular">
          <span className="size-2 rounded-sm" style={{ backgroundColor: p.color }} />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto pl-3 font-medium">{currency ? formatMoney(p.value, currency) : `${p.value}${unit ?? ""}`}</span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: i.color, opacity: i.dashed ? 0.6 : 1 }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function useChartReady() {
  // Recharts measures its container; delay first render until layout settles to avoid zero-width warnings.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return ready;
}
