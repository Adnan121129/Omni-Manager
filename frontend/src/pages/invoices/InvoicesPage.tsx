import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileStack, Plus, Receipt, Repeat } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { EmptyState, FilterBar, MoneyStack, PageHeader, Pagination, QueryState, SearchInput, SortableTH, StatCard } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Segmented } from "@/components/ui/overlays";
import { Card, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useClientOptions, useDebounced } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, type Paginated } from "@/lib/api";
import { daysUntil, formatDate, formatMoney, type MoneyAmount } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { cn, toQuery } from "@/lib/utils";

type Summary = { outstanding: MoneyAmount[]; overdue: MoneyAmount[]; draft: MoneyAmount[]; collected_this_month: MoneyAmount[] };

export function InvoicesPage() {
  const { org } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = React.useState(params.get("search") ?? "");
  const debounced = useDebounced(search);
  const clients = useClientOptions();
  const status = params.get("status") ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const ordering = params.get("ordering") ?? "-issue_date";
  const qs = toQuery({ search: debounced, status, client: params.get("client"), from: params.get("from"), to: params.get("to"), ordering, page: params.get("page") });
  const query = useQuery({ queryKey: ["invoices", qs], queryFn: () => api.get<Paginated<Invoice> & { summary: Summary }>(`/invoices/${qs}`) });
  const invoices = query.data?.results ?? [];
  const s = query.data?.summary;

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Generate invoices from approved time, expenses and milestones — each item can only be billed once."
        actions={
          <>
            <Button variant="outline" asChild><Link to="/invoices/recurring"><Repeat /> Recurring</Link></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button><Plus /> New invoice <ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => navigate("/invoices/new")}><FileStack /> From approved work</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/invoices/new?mode=manual")}><Receipt /> Manual invoice</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Outstanding" value={<MoneyStack list={s?.outstanding} primary={org.default_currency} />} to="/invoices?status=open" />
        <StatCard label="Overdue" value={<MoneyStack list={s?.overdue} primary={org.default_currency} />} to="/invoices?status=overdue" tone={s?.overdue.length ? "danger" : "default"} />
        <StatCard label="Drafts" value={<MoneyStack list={s?.draft} primary={org.default_currency} />} to="/invoices?status=draft" />
        <StatCard label="Collected this month" value={<MoneyStack list={s?.collected_this_month} primary={org.default_currency} />} tone="success" />
      </div>
      <Card>
        <div className="border-b border-border px-4 pt-3">
          <Segmented
            value={status || "all"}
            onChange={(v) => set("status", v === "all" ? "" : v)}
            options={[
              { value: "all", label: "All" },
              { value: "draft", label: "Drafts" },
              { value: "open", label: "Open" },
              { value: "overdue", label: "Overdue" },
              { value: "paid", label: "Paid" },
              { value: "void", label: "Void" },
            ]}
            className="mb-3"
          />
        </div>
        <FilterBar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); set("search", v); }} placeholder="Search number or client…" />
          <Select aria-label="Client" value={params.get("client") ?? ""} onChange={(e) => set("client", e.target.value)} className="sm:w-48">
            <option value="">All clients</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted">Issued from <input type="date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={params.get("from") ?? ""} onChange={(e) => set("from", e.target.value)} /></label>
          <label className="flex items-center gap-1.5 text-xs text-muted">to <input type="date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={params.get("to") ?? ""} onChange={(e) => set("to", e.target.value)} /></label>
        </FilterBar>
        <QueryState query={query} empty={invoices.length === 0 && <EmptyState icon={Receipt} title="No invoices found" description="Create an invoice from approved billable work or add a manual one." action={<Button onClick={() => navigate("/invoices/new")}><Plus /> New invoice</Button>} />}>
          <Table>
            <THead>
              <tr>
                <SortableTH label="Number" field="number" ordering={ordering} onSort={(o) => set("ordering", o)} />
                <SortableTH label="Client" field="client" ordering={ordering} onSort={(o) => set("ordering", o)} />
                <TH className="hidden lg:table-cell">Projects</TH>
                <SortableTH label="Issued" field="issue_date" ordering={ordering} onSort={(o) => set("ordering", o)} className="hidden md:table-cell" />
                <SortableTH label="Due" field="due_date" ordering={ordering} onSort={(o) => set("ordering", o)} />
                <SortableTH label="Total" field="total" ordering={ordering} onSort={(o) => set("ordering", o)} className="text-right" />
                <SortableTH label="Balance" field="amount_due" ordering={ordering} onSort={(o) => set("ordering", o)} className="text-right" />
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {invoices.map((inv) => {
                const days = daysUntil(inv.due_date) ?? 0;
                return (
                  <TR key={inv.id} className="cursor-pointer" onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <TD><Link to={`/invoices/${inv.id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>{inv.number}</Link></TD>
                    <TD>{inv.client_name}</TD>
                    <TD className="hidden text-xs text-muted lg:table-cell">{inv.project_codes.join(", ") || "—"}</TD>
                    <TD className="hidden text-muted md:table-cell">{formatDate(inv.issue_date)}</TD>
                    <TD className={cn("tabular", inv.is_overdue && "font-medium text-danger")}>
                      {formatDate(inv.due_date, { month: "short", day: "numeric" })}
                      {inv.is_overdue && <span className="ml-1 text-xs">({-days}d)</span>}
                    </TD>
                    <TD className="text-right tabular">{formatMoney(inv.total, inv.currency)}</TD>
                    <TD className="text-right font-medium tabular">{["void", "draft"].includes(inv.status) ? <span className="text-muted">—</span> : formatMoney(inv.amount_due, inv.currency)}</TD>
                    <TD><StatusBadge kind="invoice" status={inv.display_status} /></TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          {query.data && <Pagination page={query.data.page} totalPages={query.data.total_pages} count={query.data.count} onPage={(p) => set("page", String(p))} />}
        </QueryState>
      </Card>
    </>
  );
}
