import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, BadgeDollarSign, CheckCircle2, Clock, FileSignature, FolderKanban, Hourglass, Plus, Receipt, Target, TrendingUp, Wallet } from "lucide-react";
import { Link } from "react-router";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { axisProps, CHART, ChartTooltip, Legend, useChartReady } from "@/components/common/charts";
import { ActivityList } from "@/components/common/collab";
import { EmptyState, ErrorState, MoneyList, MoneyStack, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { HealthDot, PriorityIndicator, StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { DueLabel } from "@/features/tasks/TaskViews";
import { useAuth } from "@/hooks/session";
import { api } from "@/lib/api";
import { formatDate, formatDateShort, formatHours, formatMoney, type MoneyAmount } from "@/lib/format";

interface DashboardData {
  role: string;
  currency: string;
  my_work: {
    week_start: string;
    hours_this_week: string;
    billable_hours_this_week: string;
    capacity_hours: string;
    open_tasks: number;
    overdue_tasks: number;
    draft_entries: number;
    rejected_entries: number;
    tasks: { id: number; key: string; title: string; status: string; priority: string; due_date: string | null; project: string; overdue: boolean }[];
  };
  projects: {
    active: number;
    open: number;
    completed: number;
    completed_this_month: number;
    health: { healthy: number; at_risk: number; critical: number };
    attention: { id: number; code: string; name: string; client: string; health: string; progress: number; budget_used_percent: string | null; deadline: string | null; reasons: string[] }[];
  };
  activity: { id: number; verb: string; target_label: string; actor: string; created_at: string }[];
  time?: { billable_hours_this_month: string; total_hours_this_month: string; awaiting_approval_hours: string; awaiting_approval_entries: number; billable_value_this_month: MoneyAmount[] };
  approvals?: { time_entries: number; expenses: number; documents_awaiting_client: number; deliverables_awaiting_client: number };
  clients?: { active: number; new_leads_30d: number; open_leads: number; pipeline_value: MoneyAmount[]; follow_ups_due: number; recent_leads: { id: number; title: string; company: string; stage: string; value: string; currency: string }[] };
  team?: { week_start: string; overloaded: number; members: { user: { id: number; full_name: string }; capacity_hours: string; tracked_hours: string; billable_hours: string; utilization_percent: string | null; load_percent: string | null; open_tasks: number; overdue_tasks: number; overloaded: boolean; timer_running: boolean }[] };
  finance?: {
    invoiced_this_month: MoneyAmount[];
    collected_this_month: MoneyAmount[];
    outstanding: MoneyAmount[];
    overdue: MoneyAmount[];
    overdue_count: number;
    overdue_invoices: { id: number; number: string; client: string; due_date: string; days_overdue: number; amount_due: string; currency: string }[];
    upcoming_payments: { id: number; number: string; client: string; due_date: string; amount_due: string; currency: string }[];
    expenses_this_month: MoneyAmount[];
  };
  chart?: { currency: string; series: { month: string; label: string; invoiced: string; collected: string; expenses: string }[]; other_currencies: string[]; note: string };
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function RevenueChart({ chart }: { chart: NonNullable<DashboardData["chart"]> }) {
  const ready = useChartReady();
  const data = chart.series.map((s) => ({ label: s.label, Invoiced: Number(s.invoiced), Collected: Number(s.collected), Expenses: Number(s.expenses) }));
  const empty = data.every((d) => !d.Invoiced && !d.Collected && !d.Expenses);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Revenue & expenses</CardTitle>
          <CardDescription>Last 6 months · {chart.currency} · invoiced by issue date, collected by payment date</CardDescription>
        </div>
        <Legend items={[{ label: "Invoiced", color: CHART.primary }, { label: "Collected", color: CHART.success }, { label: "Expenses", color: CHART.neutral }]} />
      </CardHeader>
      <CardContent>
        {empty ? (
          <EmptyState compact icon={TrendingUp} title="No financial activity yet" description="Invoices, payments and expenses will appear here." />
        ) : (
          <div className="h-64" role="img" aria-label="Monthly invoiced, collected and expenses chart">
            {ready && (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={4}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" {...axisProps} />
                  <YAxis {...axisProps} width={56} tickFormatter={(v) => formatMoney(v, chart.currency, { compact: true })} />
                  <RTooltip content={<ChartTooltip currency={chart.currency} />} cursor={{ fill: "var(--subtle)" }} />
                  <Bar dataKey="Invoiced" fill={CHART.primary} radius={[3, 3, 0, 0]} maxBarSize={28} />
                  <Bar dataKey="Collected" fill={CHART.success} radius={[3, 3, 0, 0]} maxBarSize={28} />
                  <Line dataKey="Expenses" stroke={CHART.neutral} strokeWidth={2} dot={{ r: 3 }} type="monotone" />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        )}
        {chart.other_currencies.length > 0 && <p className="mt-2 text-xs text-muted">{chart.note} Also invoicing in {chart.other_currencies.join(", ")}.</p>}
      </CardContent>
    </Card>
  );
}

function HealthOverview({ projects }: { projects: DashboardData["projects"] }) {
  const total = projects.health.healthy + projects.health.at_risk + projects.health.critical;
  const rows = [
    { key: "healthy", label: "Healthy", value: projects.health.healthy, color: "bg-success" },
    { key: "at_risk", label: "At risk", value: projects.health.at_risk, color: "bg-warning" },
    { key: "critical", label: "Critical", value: projects.health.critical, color: "bg-danger" },
  ];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Project health</CardTitle>
          <CardDescription>{projects.open} open projects · based on budget, schedule and overdue work</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-subtle" aria-hidden>
          {rows.map((r) => r.value > 0 && <div key={r.key} className={r.color} style={{ width: `${(r.value / Math.max(total, 1)) * 100}%` }} />)}
        </div>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2 text-[13px]">
              <span className={`size-2 rounded-full ${r.color}`} />
              <span className="flex-1">{r.label}</span>
              <span className="font-medium tabular">{r.value}</span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-[13px]">
          <div>
            <p className="text-xs text-muted">Completed</p>
            <p className="font-medium tabular">{projects.completed}</p>
          </div>
          <div>
            <p className="text-xs text-muted">This month</p>
            <p className="font-medium tabular">{projects.completed_this_month}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AttentionList({ items, showBudget }: { items: DashboardData["projects"]["attention"]; showBudget: boolean }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Projects needing attention</CardTitle>
          <CardDescription>Approaching budget or deadline, or flagged by health signals</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/projects">All projects <ArrowRight /></Link></Button>
      </CardHeader>
      {items.length === 0 ? (
        <EmptyState compact icon={CheckCircle2} title="Everything is on track" description="No project is near its budget, past a deadline or carrying overdue work." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {items.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="flex flex-col gap-2 px-5 py-3 hover:bg-surface-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <HealthDot status={p.health} />
                    <span className="truncate text-[13px] font-medium">{p.name}</span>
                    <span className="font-mono text-[11px] text-muted">{p.code}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">{p.client} · {p.reasons.join(" ")}</p>
                </div>
                <div className="flex items-center gap-4 text-xs sm:w-72">
                  <div className="flex-1">
                    <div className="mb-1 flex justify-between text-muted"><span>Progress</span><span className="tabular">{p.progress}%</span></div>
                    <ProgressBar value={p.progress} tone="primary" label="Progress" />
                  </div>
                  {showBudget && p.budget_used_percent !== null && (
                    <div className="flex-1">
                      <div className="mb-1 flex justify-between text-muted"><span>Budget</span><span className="tabular">{Number(p.budget_used_percent).toFixed(0)}%</span></div>
                      <ProgressBar value={Number(p.budget_used_percent)} label="Budget used" />
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MyWork({ data }: { data: DashboardData["my_work"] }) {
  const hours = Number(data.hours_this_week);
  const capacity = Number(data.capacity_hours);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>My work</CardTitle>
          <CardDescription>Week of {formatDate(data.week_start)}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/tasks?assignee=me">My tasks <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted">Logged this week</p>
            <p className="text-lg font-semibold tabular">{formatHours(hours)} <span className="text-xs font-normal text-muted">of {formatHours(capacity)}</span></p>
            <ProgressBar value={capacity ? (hours / capacity) * 100 : 0} tone="primary" className="mt-1.5" label="Weekly capacity used" />
          </div>
          <Link to="/time?view=week" className="rounded-md p-1 hover:bg-subtle">
            <p className="text-xs text-muted">Draft entries to submit</p>
            <p className="text-lg font-semibold tabular">{data.draft_entries}</p>
          </Link>
          <Link to="/time?view=week&status=rejected" className="rounded-md p-1 hover:bg-subtle">
            <p className="text-xs text-muted">Rejected — needs correction</p>
            <p className={`text-lg font-semibold tabular ${data.rejected_entries ? "text-danger" : ""}`}>{data.rejected_entries}</p>
          </Link>
        </div>
        {data.tasks.length === 0 ? (
          <p className="text-[13px] text-muted">No open tasks assigned to you.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.tasks.map((t) => (
              <li key={t.id}>
                <Link to={`?task=${t.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                  <PriorityIndicator priority={t.priority} showLabel={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{t.title}</span>
                    <span className="block truncate text-xs text-muted">{t.key} · {t.project}</span>
                  </span>
                  <StatusBadge kind="task" status={t.status} className="hidden sm:inline-flex" />
                  <DueLabel date={t.due_date} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { user, permissions } = useAuth();
  const query = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardData>("/dashboard/"), refetchInterval: 120_000 });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data;
  const firstName = user.full_name.split(" ")[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date())}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/time"><Clock /> Log time</Link></Button>
            {permissions.is_manager && <Button asChild><Link to="/projects?new=1"><Plus /> New project</Link></Button>}
          </>
        }
      />

      {permissions.is_manager && d.time && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Active projects" value={d.projects.active} sub={`${d.projects.open} open in total`} icon={FolderKanban} to="/projects?status=active" />
          <StatCard label="Billable hours (month)" value={formatHours(d.time.billable_hours_this_month)} sub={<MoneyList list={d.time.billable_value_this_month} empty="No billable value yet" />} icon={Clock} to="/reports" />
          <StatCard label="Awaiting approval" value={formatHours(d.time.awaiting_approval_hours)} sub={`${d.time.awaiting_approval_entries} entries`} icon={Hourglass} to="/timesheets?tab=approvals" tone={d.time.awaiting_approval_entries ? "warning" : "default"} />
          {d.finance ? (
            <>
              <StatCard label="Invoiced (month)" value={<MoneyStack list={d.finance.invoiced_this_month} primary={d.currency} />} icon={Receipt} to="/invoices" />
              <StatCard label="Collected (month)" value={<MoneyStack list={d.finance.collected_this_month} primary={d.currency} />} icon={BadgeDollarSign} to="/invoices?status=paid" tone="success" />
              <StatCard
                label="Outstanding"
                value={<MoneyStack list={d.finance.outstanding} primary={d.currency} />}
                sub={d.finance.overdue_count ? <span className="text-danger">{d.finance.overdue_count} overdue invoices</span> : "Nothing overdue"}
                icon={Wallet}
                to={d.finance.overdue_count ? "/invoices?status=overdue" : "/invoices?status=open"}
                tone={d.finance.overdue_count ? "danger" : "default"}
              />
            </>
          ) : (
            <>
              <StatCard label="Active clients" value={d.clients?.active ?? 0} icon={Target} to="/clients" />
              <StatCard label="Open leads" value={d.clients?.open_leads ?? 0} sub={`${d.clients?.new_leads_30d ?? 0} new in 30 days`} icon={TrendingUp} to="/crm" />
              <StatCard label="Projects completed" value={d.projects.completed} sub={`${d.projects.completed_this_month} this month`} icon={CheckCircle2} to="/projects?status=completed" />
            </>
          )}
        </div>
      )}

      {d.chart && (
        <div className="grid gap-6 lg:grid-cols-3">
          <RevenueChart chart={d.chart} />
          <HealthOverview projects={d.projects} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {permissions.is_manager ? <AttentionList items={d.projects.attention} showBudget /> : <MyWork data={d.my_work} />}
        {d.approvals ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Pending approvals</CardTitle>
                <CardDescription>Waiting on you or on clients</CardDescription>
              </div>
            </CardHeader>
            <ul className="divide-y divide-border border-t border-border">
              {[
                { label: "Time entries to review", value: d.approvals.time_entries, to: "/timesheets?tab=approvals", icon: Clock },
                { label: "Expenses to review", value: d.approvals.expenses, to: "/expenses?tab=approvals", icon: Wallet },
                { label: "Documents awaiting signature", value: d.approvals.documents_awaiting_client, to: "/documents?status=sent,viewed", icon: FileSignature },
                { label: "Deliverables awaiting client", value: d.approvals.deliverables_awaiting_client, to: "/projects", icon: CheckCircle2 },
              ].map((row) => (
                <li key={row.label}>
                  <Link to={row.to} className="flex items-center gap-3 px-5 py-3 text-[13px] hover:bg-surface-2">
                    <row.icon className="size-4 text-muted" />
                    <span className="flex-1">{row.label}</span>
                    <Badge tone={row.value ? "warning" : "neutral"}>{row.value}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <HealthOverview projects={d.projects} />
        )}
      </div>

      {permissions.is_manager && <MyWork data={d.my_work} />}

      <div className="grid gap-6 lg:grid-cols-3">
        {d.team && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <div>
                <CardTitle>Team workload</CardTitle>
                <CardDescription>This week · tracked vs capacity · {d.team.overloaded} overloaded</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild><Link to="/team">Team <ArrowRight /></Link></Button>
            </CardHeader>
            <CardContent>
              {d.team.members.length === 0 ? (
                <p className="text-[13px] text-muted">No team members in scope.</p>
              ) : (
                <ul className="space-y-3">
                  {d.team.members.map((m) => {
                    const load = Number(m.load_percent ?? 0);
                    return (
                      <li key={m.user.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]">
                        <span className="flex items-center gap-2 truncate">
                          {m.timer_running && <span className="size-1.5 animate-pulse-dot rounded-full bg-primary" title="Timer running" />}
                          <span className="truncate">{m.user.full_name}</span>
                        </span>
                        <ProgressBar value={load} tone={m.overloaded ? "danger" : load >= 85 ? "warning" : "primary"} label={`${m.user.full_name} load`} />
                        <span className="w-28 text-right text-xs tabular text-muted">
                          {formatHours(m.tracked_hours)} / {formatHours(m.capacity_hours)}
                          {m.overdue_tasks > 0 && <span className="ml-1 text-danger">· {m.overdue_tasks} late</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
        {d.finance && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Receivables</CardTitle>
                <CardDescription>Overdue and due in the next 14 days</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {d.finance.overdue_invoices.length === 0 && d.finance.upcoming_payments.length === 0 && (
                <p className="text-[13px] text-muted">No overdue or upcoming invoices.</p>
              )}
              {d.finance.overdue_invoices.map((i) => (
                <Link key={i.id} to={`/invoices/${i.id}`} className="flex items-center gap-3 rounded-md p-1.5 text-[13px] hover:bg-subtle">
                  <AlertTriangle className="size-4 text-danger" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{i.number} · {i.client}</span>
                    <span className="text-xs text-danger">{i.days_overdue} days overdue</span>
                  </span>
                  <span className="tabular font-medium">{formatMoney(i.amount_due, i.currency)}</span>
                </Link>
              ))}
              {d.finance.upcoming_payments.map((i) => (
                <Link key={i.id} to={`/invoices/${i.id}`} className="flex items-center gap-3 rounded-md p-1.5 text-[13px] hover:bg-subtle">
                  <Receipt className="size-4 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{i.number} · {i.client}</span>
                    <span className="text-xs text-muted">Due {formatDateShort(i.due_date)}</span>
                  </span>
                  <span className="tabular">{formatMoney(i.amount_due, i.currency)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityList items={d.activity.map((a) => ({ ...a, actor: a.actor }))} />
          </CardContent>
        </Card>
        {d.clients && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Clients & pipeline</CardTitle>
                <CardDescription>{d.clients.active} active clients · {d.clients.follow_ups_due} follow-ups due</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild><Link to="/crm">CRM <ArrowRight /></Link></Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-muted">Open pipeline value</p>
                <p className="text-lg font-semibold"><MoneyList list={d.clients.pipeline_value} /></p>
              </div>
              <ul className="space-y-2">
                {d.clients.recent_leads.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate"><span className="font-medium">{l.company}</span> <span className="text-muted">· {l.title}</span></span>
                    <StatusBadge kind="lead" status={l.stage} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
