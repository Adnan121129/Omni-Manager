import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox, RotateCw, Search, SortAsc, SortDesc } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Skeleton, TH } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, back, meta, className }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { to: string; label: string };
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
            <ArrowLeft className="size-3.5" /> {back.label}
          </Link>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className, compact }: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8" : "py-14", className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-subtle text-muted">
        <Icon className="size-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)} role="alert">
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="size-5" />
      </div>
      <p className="text-sm font-medium">Couldn't load this</p>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2 p-4", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

export function PageLoader() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-7 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

export function QueryState({ query, children, empty, rows }: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: React.ReactNode;
  empty?: React.ReactNode | false;
  rows?: number;
}) {
  if (query.isLoading) return <LoadingRows rows={rows} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}

export function Money({ amount, currency, className, compact }: { amount: string | number | null | undefined; currency: string; className?: string; compact?: boolean }) {
  return <span className={cn("tabular whitespace-nowrap", className)}>{formatMoney(amount, currency, { compact })}</span>;
}

export function MoneyList({ list, className, empty = "—" }: { list: { currency: string; amount: string }[] | undefined; className?: string; empty?: string }) {
  if (!list || list.length === 0) return <span className={cn("tabular text-muted", className)}>{empty}</span>;
  return (
    <span className={cn("tabular inline-flex flex-wrap gap-x-2", className)}>
      {list.map((m) => (
        <span key={m.currency}>{formatMoney(m.amount, m.currency)}</span>
      ))}
    </span>
  );
}

export function StatCard({ label, value, sub, icon: Icon, to, tone, className }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  to?: string;
  tone?: "default" | "danger" | "warning" | "success";
  className?: string;
}) {
  const inner = (
    <Card className={cn("h-full p-4 transition-colors", to && "hover:border-border-strong", className)}>
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {Icon && <Icon className={cn("size-4 text-muted", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "success" && "text-success")} />}
      </div>
      <div className={cn("mt-2 text-2xl font-semibold tracking-tight tabular", tone === "danger" && "text-danger")}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-lg focus-visible:outline-2">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export function SearchInput({ value, onChange, placeholder = "Search…", className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
    </div>
  );
}

export function Pagination({ page, totalPages, count, onPage }: { page: number; totalPages: number; count: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return <div className="px-4 py-3 text-xs text-muted">{count} {count === 1 ? "result" : "results"}</div>;
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
      <span>
        {count} results · page {page} of {totalPages}
      </span>
      <div className="flex gap-1">
        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

export function SortableTH({ label, field, ordering, onSort, className }: { label: string; field: string; ordering: string; onSort: (o: string) => void; className?: string }) {
  const active = ordering.replace("-", "") === field;
  const desc = ordering.startsWith("-");
  const Icon = !active ? ChevronsUpDown : desc ? SortDesc : SortAsc;
  return (
    <TH className={className} aria-sort={active ? (desc ? "descending" : "ascending") : "none"}>
      <button type="button" className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")} onClick={() => onSort(active && !desc ? `-${field}` : field)}>
        {label}
        <Icon className="size-3.5" />
      </button>
    </TH>
  );
}

export function FilterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center", className)}>{children}</div>;
}

export function DefinitionList({ items, className }: { items: { label: string; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm">{item.value || <span className="text-muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Primary-currency amount large, other currencies on a smaller line - amounts are never summed across currencies. */
export function MoneyStack({ list, primary, empty }: { list: { currency: string; amount: string }[] | undefined; primary: string; empty?: string }) {
  const items = [...(list ?? [])].sort((a, b) => (a.currency === primary ? -1 : b.currency === primary ? 1 : a.currency.localeCompare(b.currency)));
  if (!items.length) return <span className="tabular">{empty ?? formatMoney(0, primary)}</span>;
  const [first, ...rest] = items;
  return (
    <span className="block">
      <span className="tabular">{formatMoney(first.amount, first.currency)}</span>
      {rest.length > 0 && (
        <span className="mt-1 block text-xs font-normal tracking-normal text-muted tabular">
          + {rest.map((m) => formatMoney(m.amount, m.currency)).join(" · ")}
        </span>
      )}
    </span>
  );
}
