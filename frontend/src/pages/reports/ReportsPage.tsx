import { useQuery } from "@tanstack/react-query";
import { Download, Info } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { axisProps, CHART, ChartTooltip, Legend, useChartReady } from "@/components/common/charts";
import { EmptyState, ErrorState, FilterBar, MoneyList, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { HealthDot } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useClientOptions, useMembers, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api } from "@/lib/api";
import { formatHours, formatMoney, isoDate, percent, type MoneyAmount } from "@/lib/format";
import { cn, toQuery } from "@/lib/utils";

interface Report {
  period: { start: string; end: string };
  hours: { total: string; billable: string; non_billable: string };
  billable_value: MoneyAmount[];
  invoiced: MoneyAmount[];
  collected: MoneyAmount[];
  labor_cost: MoneyAmount[];
  expenses_total: MoneyAmount[];
  outstanding: MoneyAmount[];
  overdue: MoneyAmount[];
  aging: ({ currency: string } & Record<string, string>)[];
  expenses_by_category: { category: string; currency: string; amount: string; billable: string }[];
  projects: { id: number; code: string; name: string; client: string; status: string; project_type: string; currency: string; health: string; progress: number; hours_tracked: string; hours_budget: string; hours_percent: string | null; fees_used: string; fees_budget: string; fees_percent: string | null; billable_value: string; invoiced: string; collected?: string; labor_cost: string; expense_cost: string; total_cost: string; revenue_basis: string; revenue_basis_label: string; estimated_margin: string; estimated_margin_percent: string | null }[];
  clients: { id: number; name: string; hours: string; invoiced: MoneyAmount[]; collected: MoneyAmount[]; labor_cost: MoneyAmount[]; expenses: MoneyAmount[] }[];
  team: { user: { id: number; full_name: string }; capacity_hours: string; tracked_hours: string; billable_hours: string; utilization_percent: string | null; open_tasks: number; overdue_tasks: number; remaining_estimated_hours: string }[];
  approvals: { status: string; count: number; hours: string }[];
  approvals_by_user: ({ user: string } & Record<string, string>)[];
  estimate_variance: { task_id: number; title: string; project: string; estimated: string; actual: string; difference: string; status: string }[];
  /** `collected` is only present for billing users. */
  monthly: Record<string, { month: string; label: string; invoiced: string; collected?: string; expenses: string }[]>;
  definitions: Record<string, string>;
}

function presetRange(preset: string): { from: string; to: string } {
  const now = new Date();
  const to = isoDate(now);
  if (preset === "month") return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  if (preset === "quarter") return { from: isoDate(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to };
  if (preset === "year") return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to };
  return { from: isoDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)), to };
}

function ExportButton({ name, qs }: { name: string; qs: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={`/api/reports/export/${name}/${qs}`}><Download /> CSV</a>
    </Button>
  );
}

function MonthlyChart({ data, currency, showCollected }: { data: Report["monthly"][string]; currency: string; showCollected: boolean }) {
  const ready = useChartReady();
  const rows = data.map((r) => ({ label: r.label, Invoiced: Number(r.invoiced), Collected: Number(r.collected ?? 0), Expenses: Number(r.expenses) }));
  return (
    <div className="h-64" role="img" aria-label={`Monthly invoiced${showCollected ? ", collected" : ""} and expenses in ${currency}`}>
      {ready && (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={3}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} width={56} tickFormatter={(v) => formatMoney(v, currency, { compact: true })} />
            <RTooltip content={<ChartTooltip currency={currency} />} cursor={{ fill: "var(--subtle)" }} />
            <Bar dataKey="Invoiced" fill={CHART.primary} radius={[3, 3, 0, 0]} maxBarSize={22} />
            {showCollected && <Bar dataKey="Collected" fill={CHART.success} radius={[3, 3, 0, 0]} maxBarSize={22} />}
            <Bar dataKey="Expenses" fill={CHART.neutral} radius={[3, 3, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function CategoryChart({ rows }: { rows: Report["expenses_by_category"] }) {
  const ready = useChartReady();
  const currency = rows[0]?.currency ?? "USD";
  const data = rows.filter((r) => r.currency === currency).map((r) => ({ name: r.category, Cost: Number(r.amount) }));
  return (
    <div style={{ height: Math.max(160, data.length * 36) }} role="img" aria-label="Expenses by category">
      {ready && (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
            <XAxis type="number" {...axisProps} tickFormatter={(v) => formatMoney(v, currency, { compact: true })} />
            <YAxis type="category" dataKey="name" {...axisProps} width={150} />
            <RTooltip content={<ChartTooltip currency={currency} />} cursor={{ fill: "var(--subtle)" }} />
            <Bar dataKey="Cost" radius={[0, 3, 3, 0]} maxBarSize={20}>
              {data.map((_, i) => <Cell key={i} fill={CHART.series[i % CHART.series.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function ReportsPage() {
  const { org, permissions } = useAuth();
  // Receivables (collected, outstanding, aging) are only returned to billing users.
  const finance = permissions.billing;
  const [params, setParams] = useSearchParams();
  const clients = useClientOptions();
  const projects = useProjectOptions({ includeClosed: true });
  const members = useMembers();
  const preset = params.get("preset") ?? "6m";
  const range = params.get("from") ? { from: params.get("from")!, to: params.get("to") ?? isoDate(new Date()) } : presetRange(preset);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const qs = toQuery({ from: range.from, to: range.to, client: params.get("client"), project: params.get("project"), user: params.get("user") });
  const query = useQuery({ queryKey: ["report", qs], queryFn: () => api.get<Report>(`/reports/overview/${qs}`) });
  const tab = params.get("tab") ?? "overview";
  const currencies = Object.keys(query.data?.monthly ?? {});
  const [chartCurrency, setChartCurrency] = React.useState<string>("");
  const cur = chartCurrency && currencies.includes(chartCurrency) ? chartCurrency : currencies.includes(org.default_currency) ? org.default_currency : currencies[0];
  const r = query.data;
  const total = Number(r?.hours.total ?? 0);
  const billable = Number(r?.hours.billable ?? 0);

  return (
    <>
      <PageHeader title="Reports" description="Profitability, revenue, receivables and utilization — computed from your records. Amounts are never combined across currencies." actions={<Button variant="outline" asChild><Link to="/revenue-radar">Revenue Leak Radar</Link></Button>} />
      <Card className="mb-6">
        <FilterBar className="border-b-0">
          <Select aria-label="Period" value={params.get("from") ? "custom" : preset} onChange={(e) => { const next = new URLSearchParams(params); next.delete("from"); next.delete("to"); next.set("preset", e.target.value); if (e.target.value === "custom") { next.set("from", range.from); next.set("to", range.to); } setParams(next, { replace: true }); }} className="sm:w-44">
            <option value="month">This month</option>
            <option value="quarter">This quarter</option>
            <option value="6m">Last 6 months</option>
            <option value="year">Year to date</option>
            <option value="custom">Custom range</option>
          </Select>
          <input type="date" aria-label="From" className="h-9 rounded-md border border-border bg-surface px-2 text-[13px]" value={range.from} onChange={(e) => { set("from", e.target.value); if (!params.get("to")) set("to", range.to); }} />
          <input type="date" aria-label="To" className="h-9 rounded-md border border-border bg-surface px-2 text-[13px]" value={range.to} onChange={(e) => { set("to", e.target.value); if (!params.get("from")) set("from", range.from); }} />
          <Select aria-label="Client" value={params.get("client") ?? ""} onChange={(e) => set("client", e.target.value)} className="sm:w-44">
            <option value="">All clients</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select aria-label="Project" value={params.get("project") ?? ""} onChange={(e) => set("project", e.target.value)} className="sm:w-48">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
          <Select aria-label="Team member" value={params.get("user") ?? ""} onChange={(e) => set("user", e.target.value)} className="sm:w-44">
            <option value="">Everyone</option>
            {members.data?.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
          </Select>
        </FilterBar>
      </Card>
      {query.isLoading ? <PageLoader /> : query.isError || !r ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : (
        <Tabs value={tab} onValueChange={(t) => set("tab", t === "overview" ? "" : t)}>
          <TabsList className="mb-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="profitability">Project profitability</TabsTrigger>
            <TabsTrigger value="clients">Clients</TabsTrigger>
            <TabsTrigger value="expenses">Expenses</TabsTrigger>
            <TabsTrigger value="team">Team utilization</TabsTrigger>
            <TabsTrigger value="approvals">Timesheets</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="Hours tracked" value={formatHours(r.hours.total)} sub={<span className="block space-y-1.5"><span className="flex h-1.5 overflow-hidden rounded-full bg-subtle"><span className="bg-primary" style={{ width: `${total ? (billable / total) * 100 : 0}%` }} /></span><span className="block">{formatHours(r.hours.billable)} billable · {formatHours(r.hours.non_billable)} non-billable ({total ? Math.round((billable / total) * 100) : 0}% billable)</span></span>} />
              <StatCard label="Billable value (estimate)" value={<MoneyList list={r.billable_value} />} sub={r.definitions.billable_value} />
              <StatCard label="Invoiced (pre-tax)" value={<MoneyList list={r.invoiced} />} sub={r.definitions.invoiced} />
              {finance && <StatCard label="Collected (cash)" value={<MoneyList list={r.collected} />} sub={r.definitions.collected} tone="success" />}
              {finance && <StatCard label="Outstanding receivables" value={<MoneyList list={r.outstanding} />} sub={<>Overdue: <MoneyList list={r.overdue} /></>} tone={r.overdue.length ? "danger" : "default"} />}
              <StatCard label="Costs" value={<MoneyList list={r.expenses_total} />} sub={<>Expenses (actual) · labor est. <MoneyList list={r.labor_cost} /></>} />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card className={finance ? "lg:col-span-2" : "lg:col-span-3"}>
                <CardHeader>
                  <div><CardTitle>{finance ? "Invoiced vs collected" : "Invoiced and expenses"}</CardTitle><CardDescription>By month, in {cur ?? "—"}</CardDescription></div>
                  <div className="flex items-center gap-3">
                    <Legend items={[{ label: "Invoiced", color: CHART.primary }, ...(finance ? [{ label: "Collected", color: CHART.success }] : []), { label: "Expenses", color: CHART.neutral }]} />
                    {currencies.length > 1 && <Select className="h-8 w-24 text-xs" aria-label="Chart currency" value={cur} onChange={(e) => setChartCurrency(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select>}
                  </div>
                </CardHeader>
                <CardContent>{cur ? <MonthlyChart data={r.monthly[cur]} currency={cur} showCollected={finance} /> : <EmptyState compact title="No data" />}</CardContent>
              </Card>
              {finance && <Card>
                <CardHeader><div><CardTitle>Receivables aging</CardTitle><CardDescription>Open invoice balances by days overdue</CardDescription></div><ExportButton name="aging" qs={qs} /></CardHeader>
                <CardContent>
                  {r.aging.length ? r.aging.map((a) => (
                    <div key={a.currency} className="mb-4 space-y-1.5 text-[13px] last:mb-0">
                      <p className="text-xs font-medium text-muted">{a.currency}</p>
                      {[["current", "Not yet due"], ["1_30", "1–30 days"], ["31_60", "31–60 days"], ["61_90", "61–90 days"], ["90_plus", "90+ days"]].map(([k, label]) => (
                        <div key={k} className="flex justify-between"><span className={cn(k !== "current" && Number(a[k] ?? 0) > 0 && "text-danger")}>{label}</span><span className="tabular">{formatMoney(a[k] ?? 0, a.currency)}</span></div>
                      ))}
                    </div>
                  )) : <p className="text-[13px] text-muted">No open invoices.</p>}
                </CardContent>
              </Card>}
            </div>
          </TabsContent>
          <TabsContent value="profitability">
            <Card>
              <CardHeader>
                <div><CardTitle>Project profitability (estimated)</CardTitle><CardDescription>{r.definitions.estimated_margin} Labor cost uses internal cost rates.</CardDescription></div>
                <ExportButton name="projects" qs={qs} />
              </CardHeader>
              <Table>
                <THead>
                  <tr>
                    <TH>Project</TH>
                    <TH className="text-right">Budget used</TH>
                    <TH className="text-right">Revenue basis</TH>
                    <TH className="text-right">Invoiced</TH>
                    {finance && <TH className="text-right">Collected</TH>}
                    <TH className="text-right">Labor (est.)</TH>
                    <TH className="text-right">Expenses</TH>
                    <TH className="text-right">Est. margin</TH>
                  </tr>
                </THead>
                <TBody>
                  {r.projects.map((p) => (
                    <TR key={p.id}>
                      <TD>
                        <Link to={`/projects/${p.id}?tab=budget`} className="flex items-center gap-2 font-medium hover:text-primary"><HealthDot status={p.health} />{p.name}</Link>
                        <span className="text-xs text-muted">{p.code} · {p.client} · {p.project_type}</span>
                      </TD>
                      <TD className="w-36 text-right">
                        {p.fees_percent ? <div className="flex items-center justify-end gap-2"><ProgressBar value={Number(p.fees_percent)} className="w-16" /><span className="text-xs tabular">{Number(p.fees_percent).toFixed(0)}%</span></div> : <span className="text-muted">—</span>}
                      </TD>
                      <TD className="text-right tabular" title={p.revenue_basis_label}>{formatMoney(p.revenue_basis, p.currency)}<span className="block text-[11px] text-muted">{p.revenue_basis_label}</span></TD>
                      <TD className="text-right tabular">{formatMoney(p.invoiced, p.currency)}</TD>
                      {finance && <TD className="text-right tabular">{formatMoney(p.collected ?? null, p.currency)}</TD>}
                      <TD className="text-right tabular text-muted">{formatMoney(p.labor_cost, p.currency)}</TD>
                      <TD className="text-right tabular text-muted">{formatMoney(p.expense_cost, p.currency)}</TD>
                      <TD className={cn("text-right font-medium tabular", Number(p.estimated_margin) < 0 && "text-danger")}>{formatMoney(p.estimated_margin, p.currency)}<span className="block text-[11px] font-normal text-muted">{percent(p.estimated_margin_percent, 1)}</span></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="flex items-start gap-2 border-t border-border px-5 py-3 text-xs text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />Estimated margin is not accounting profit: it excludes overheads, taxes and unrecorded costs.</p>
            </Card>
          </TabsContent>
          <TabsContent value="clients">
            <Card>
              <CardHeader><div><CardTitle>Revenue and cost by client</CardTitle><CardDescription>For the selected period</CardDescription></div><ExportButton name="clients" qs={qs} /></CardHeader>
              <Table>
                <THead><tr><TH>Client</TH><TH className="text-right">Hours</TH><TH className="text-right">Invoiced</TH>{finance && <TH className="text-right">Collected</TH>}<TH className="text-right">Labor (est.)</TH><TH className="text-right">Expenses</TH></tr></THead>
                <TBody>
                  {r.clients.map((c) => (
                    <TR key={c.id}>
                      <TD><Link to={`/clients/${c.id}`} className="font-medium hover:text-primary">{c.name}</Link></TD>
                      <TD className="text-right tabular">{formatHours(c.hours)}</TD>
                      <TD className="text-right"><MoneyList list={c.invoiced} /></TD>
                      {finance && <TD className="text-right"><MoneyList list={c.collected} /></TD>}
                      <TD className="text-right text-muted"><MoneyList list={c.labor_cost} /></TD>
                      <TD className="text-right text-muted"><MoneyList list={c.expenses} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {!r.clients.length && <EmptyState compact title="No client activity in this period" />}
            </Card>
          </TabsContent>
          <TabsContent value="expenses">
            <Card>
              <CardHeader><div><CardTitle>Expenses by category</CardTitle><CardDescription>Internal cost; chargeable amounts shown in the table</CardDescription></div><ExportButton name="expenses" qs={qs} /></CardHeader>
              <CardContent className="grid gap-6 lg:grid-cols-2">
                {r.expenses_by_category.length ? <CategoryChart rows={r.expenses_by_category} /> : <EmptyState compact title="No expenses in this period" />}
                <Table>
                  <THead><tr><TH>Category</TH><TH className="text-right">Cost</TH><TH className="text-right">Chargeable</TH></tr></THead>
                  <TBody>
                    {r.expenses_by_category.map((e) => (
                      <TR key={`${e.category}-${e.currency}`}><TD>{e.category}</TD><TD className="text-right tabular">{formatMoney(e.amount, e.currency)}</TD><TD className="text-right tabular text-muted">{formatMoney(e.billable, e.currency)}</TD></TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="team">
            <Card>
              <CardHeader><div><CardTitle>Team utilization</CardTitle><CardDescription>Billable hours ÷ capacity (working days in the period × weekly capacity)</CardDescription></div><ExportButton name="team" qs={qs} /></CardHeader>
              <Table>
                <THead><tr><TH>Person</TH><TH className="text-right">Capacity</TH><TH className="text-right">Tracked</TH><TH className="text-right">Billable</TH><TH>Utilization</TH><TH className="text-right">Open tasks</TH><TH className="text-right">Remaining est.</TH></tr></THead>
                <TBody>
                  {r.team.map((t) => (
                    <TR key={t.user.id}>
                      <TD className="font-medium">{t.user.full_name}</TD>
                      <TD className="text-right tabular text-muted">{formatHours(t.capacity_hours)}</TD>
                      <TD className="text-right tabular">{formatHours(t.tracked_hours)}</TD>
                      <TD className="text-right tabular">{formatHours(t.billable_hours)}</TD>
                      <TD className="w-44"><div className="flex items-center gap-2"><ProgressBar value={Number(t.utilization_percent ?? 0)} tone={Number(t.utilization_percent ?? 0) > 100 ? "danger" : "primary"} className="w-24" /><span className="text-xs tabular">{percent(t.utilization_percent)}</span></div></TD>
                      <TD className="text-right tabular">{t.open_tasks}{t.overdue_tasks > 0 && <span className="ml-1 text-xs text-danger">({t.overdue_tasks} late)</span>}</TD>
                      <TD className="text-right tabular text-muted">{formatHours(t.remaining_estimated_hours)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          </TabsContent>
          <TabsContent value="approvals" className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-4">
              {["draft", "submitted", "approved", "rejected"].map((s) => {
                const row = r.approvals.find((a) => a.status === s);
                return <StatCard key={s} label={s[0].toUpperCase() + s.slice(1)} value={formatHours(row?.hours ?? 0)} sub={`${row?.count ?? 0} entries`} to={s === "submitted" && permissions.approve_time ? "/timesheets?tab=approvals" : undefined} />;
              })}
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader><div><CardTitle>Hours by person and status</CardTitle></div><ExportButton name="time" qs={qs} /></CardHeader>
                <Table>
                  <THead><tr><TH>Person</TH><TH className="text-right">Draft</TH><TH className="text-right">Submitted</TH><TH className="text-right">Approved</TH><TH className="text-right">Rejected</TH></tr></THead>
                  <TBody>
                    {r.approvals_by_user.map((u) => (
                      <TR key={u.user}><TD>{u.user}</TD>{["draft", "submitted", "approved", "rejected"].map((s) => <TD key={s} className="text-right tabular">{u[s] ? formatHours(u[s]) : "—"}</TD>)}</TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Planned vs actual (largest differences)</CardTitle><CardDescription>Task estimates compared with tracked time in the period</CardDescription></div></CardHeader>
                <Table>
                  <THead><tr><TH>Task</TH><TH className="text-right">Estimate</TH><TH className="text-right">Actual</TH><TH className="text-right">Difference</TH></tr></THead>
                  <TBody>
                    {r.estimate_variance.slice(0, 12).map((v) => (
                      <TR key={v.task_id}>
                        <TD><Link to={`?task=${v.task_id}`} className="hover:text-primary">{v.title}</Link><span className="block text-xs text-muted">{v.project}</span></TD>
                        <TD className="text-right tabular">{formatHours(v.estimated)}</TD>
                        <TD className="text-right tabular">{formatHours(v.actual)}</TD>
                        <TD className={cn("text-right font-medium tabular", Number(v.difference) > 0 ? "text-danger" : "text-success")}>{Number(v.difference) > 0 ? "+" : ""}{formatHours(v.difference)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
