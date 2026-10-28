import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Info, Radar, RefreshCw } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { EmptyState, ErrorState, MoneyList, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/api";
import { relativeTime, type MoneyAmount } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { cn, uid } from "@/lib/utils";

interface Alert {
  id: string;
  type: string;
  severity: "high" | "medium" | "low";
  title: string;
  explanation: string;
  project: { id: number; code: string; name: string } | null;
  client: { id: number; name: string } | null;
  amount: MoneyAmount[];
  records: { type: string; id: number; label: string; url: string }[];
  record_count: number;
  action: { kind: "generate_invoice" | "link"; label: string; url?: string; params?: { client: number; projects: number[] } };
}

interface Radar {
  generated_at: string;
  alerts: Alert[];
  summary: { total: number; high: number; by_type: Record<string, number>; unbilled_value: MoneyAmount[]; at_risk_receivables: MoneyAmount[] };
}

const TYPE_LABEL: Record<string, string> = {
  unbilled_time: "Unbilled approved time",
  unbilled_expenses: "Unbilled expenses",
  uninvoiced_milestone: "Uninvoiced milestones",
  pending_approval: "Stuck in approval",
  done_without_time: "Done without time",
  budget: "Budget risk",
  retainer_limit: "Retainer limit",
  estimate_overrun: "Estimate overruns",
  overdue_invoice: "Overdue invoices",
  partially_paid: "Partially paid",
};

const SEVERITY = {
  high: { icon: AlertOctagon, className: "text-danger", badge: "danger" as const, label: "High" },
  medium: { icon: AlertTriangle, className: "text-warning", badge: "warning" as const, label: "Medium" },
  low: { icon: Info, className: "text-info", badge: "info" as const, label: "Low" },
};

function AlertCard({ alert }: { alert: Alert }) {
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const meta = SEVERITY[alert.severity];
  const Icon = meta.icon;
  const act = async () => {
    if (alert.action.kind === "link" && alert.action.url) return navigate(alert.action.url);
    if (alert.action.kind === "generate_invoice" && alert.action.params) {
      setBusy(true);
      try {
        const inv = await api.post<Invoice>("/invoices/generate/", { ...alert.action.params, idempotency_key: uid() });
        toast.success(`Draft ${inv.number} created from unbilled work`);
        navigate(`/invoices/${inv.id}`);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <Card className="p-4" data-testid={`alert-${alert.type}`} data-alert-id={alert.id}>
      <div className="flex gap-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", meta.className)} aria-label={`${meta.label} severity`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold leading-snug">{alert.title}</p>
              <p className="mt-0.5 text-xs text-muted">
                <Badge tone="neutral" className="mr-1.5">{TYPE_LABEL[alert.type] ?? alert.type}</Badge>
                {alert.client && <Link to={`/clients/${alert.client.id}`} className="hover:underline">{alert.client.name}</Link>}
                {alert.project && <> · <Link to={`/projects/${alert.project.id}`} className="hover:underline">{alert.project.code}</Link></>}
              </p>
            </div>
            {alert.amount.length > 0 && <span className="text-[15px] font-semibold"><MoneyList list={alert.amount} /></span>}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">{alert.explanation}</p>
          {alert.records.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted hover:text-fg">Evidence: {alert.record_count} record{alert.record_count === 1 ? "" : "s"}</summary>
              <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
                {alert.records.map((r) => <li key={`${r.type}-${r.id}`}><Link to={r.url} className="hover:text-primary hover:underline">{r.label}</Link></li>)}
                {alert.record_count > alert.records.length && <li className="text-muted">…and {alert.record_count - alert.records.length} more</li>}
              </ul>
            </details>
          )}
          <div className="mt-3">
            <Button size="sm" variant={alert.action.kind === "generate_invoice" ? "primary" : "outline"} loading={busy} onClick={act}>
              {alert.action.label} <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function RevenueRadarPage() {
  const query = useQuery({ queryKey: ["revenue-leak"], queryFn: () => api.get<Radar>("/revenue-leak/") });
  const [severity, setSeverity] = React.useState<"all" | "high" | "medium" | "low">("all");
  const [type, setType] = React.useState<string>("all");
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data;
  const alerts = d.alerts.filter((a) => (severity === "all" || a.severity === severity) && (type === "all" || a.type === type));
  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2"><Radar className="size-5 text-primary" /> Revenue Leak Radar</span>}
        description="Billable work and receivables at risk of slipping through the cracks — each alert names the records behind it and why it was raised."
        actions={<Button variant="outline" onClick={() => query.refetch()} loading={query.isFetching}><RefreshCw /> Refresh</Button>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Ready to invoice" value={<MoneyList list={d.summary.unbilled_value} empty="Nothing" />} sub="Approved time, expenses and completed milestones not yet invoiced" />
        <StatCard label="Receivables at risk" value={<MoneyList list={d.summary.at_risk_receivables} empty="None" />} sub="Overdue and partially paid invoices" tone={d.summary.at_risk_receivables.length ? "danger" : "default"} />
        <StatCard label="Open alerts" value={d.summary.total} sub={`${d.summary.high} high severity`} tone={d.summary.high ? "warning" : "default"} />
        <StatCard label="Last checked" value={relativeTime(d.generated_at)} sub="Computed live from your records" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented size="sm" value={severity} onChange={setSeverity} options={[{ value: "all", label: "All" }, { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }]} />
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setType("all")} className={cn("rounded-md border px-2 py-1 text-xs", type === "all" ? "border-primary/30 bg-primary-soft text-primary" : "border-border text-muted")}>All types</button>
          {Object.entries(d.summary.by_type).map(([t, n]) => (
            <button key={t} type="button" onClick={() => setType(t)} className={cn("rounded-md border px-2 py-1 text-xs", type === t ? "border-primary/30 bg-primary-soft text-primary" : "border-border text-muted")}>
              {TYPE_LABEL[t] ?? t} · {n}
            </button>
          ))}
        </div>
      </div>
      {alerts.length === 0 ? (
        <Card><EmptyState icon={CheckCircle2} title={d.alerts.length ? "No alerts match the filter" : "No revenue leaks detected"} description="Approved work is invoiced, budgets are under control and receivables are current." /></Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">{alerts.map((a) => <AlertCard key={a.id} alert={a} />)}</div>
      )}
      <p className="mt-6 text-xs text-muted">The radar only flags what your records can show — for example a completed task with an estimate but no tracked time. It can't detect work that was never recorded anywhere.</p>
    </>
  );
}
