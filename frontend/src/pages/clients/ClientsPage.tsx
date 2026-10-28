import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";

import { EmptyState, FilterBar, Money, PageHeader, Pagination, QueryState, SearchInput, SortableTH } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Avatar, Card, TBody, TD, TH, THead, TR, Table } from "@/components/ui/primitives";
import { ClientFormDialog } from "@/features/clients/ClientForm";
import { useDebounced } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, type Paginated } from "@/lib/api";
import type { Client } from "@/lib/types";
import { toQuery } from "@/lib/utils";

export function ClientsPage() {
  const { permissions } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = React.useState(params.get("search") ?? "");
  const [creating, setCreating] = React.useState(false);
  const debounced = useDebounced(search);
  const status = params.get("status") ?? "";
  const ordering = params.get("ordering") ?? "name";
  const page = params.get("page") ?? "1";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const qs = toQuery({ search: debounced, status, ordering, page });
  const query = useQuery({ queryKey: ["clients", qs], queryFn: () => api.get<Paginated<Client>>(`/clients/${qs}`) });
  const clients = query.data?.results ?? [];
  return (
    <>
      <PageHeader title="Clients" description="Companies you work with, their contacts, projects and balances." actions={<Button onClick={() => setCreating(true)}><Plus /> New client</Button>} />
      <Card>
        <FilterBar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); set("search", v); }} placeholder="Search clients, contacts, cities…" />
          <Select aria-label="Status" value={status} onChange={(e) => set("status", e.target.value)} className="sm:w-40">
            <option value="">Active & inactive</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
            <option value="all">All, incl. archived</option>
          </Select>
        </FilterBar>
        <QueryState query={query} empty={clients.length === 0 && <EmptyState icon={Users} title={debounced ? "No clients match your search" : "No clients yet"} description="Add a client, or convert a lead from the CRM." action={<Button onClick={() => setCreating(true)}><Plus /> New client</Button>} />}>
          <Table>
            <THead>
              <tr>
                <SortableTH label="Client" field="name" ordering={ordering} onSort={(o) => set("ordering", o)} />
                <TH className="hidden md:table-cell">Contact</TH>
                <TH className="hidden lg:table-cell">Location</TH>
                <SortableTH label="Active projects" field="projects" ordering={ordering} onSort={(o) => set("ordering", o)} className="text-right" />
                {permissions.billing && <TH className="text-right">Outstanding</TH>}
                <TH className="hidden sm:table-cell">Portal</TH>
                <SortableTH label="Status" field="status" ordering={ordering} onSort={(o) => set("ordering", o)} />
              </tr>
            </THead>
            <TBody>
              {clients.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link to={`/clients/${c.id}`} className="group flex items-center gap-2.5">
                      <Avatar name={c.name} size={28} className="rounded-md" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium group-hover:text-primary">{c.name}</span>
                        <span className="text-xs text-muted">{c.industry || c.currency}</span>
                      </span>
                    </Link>
                  </TD>
                  <TD className="hidden md:table-cell">
                    <span className="block text-[13px]">{c.contact_name || "—"}</span>
                    <span className="text-xs text-muted">{c.email}</span>
                  </TD>
                  <TD className="hidden text-muted lg:table-cell">{[c.city, c.country].filter(Boolean).join(", ") || "—"}</TD>
                  <TD className="text-right tabular">{c.active_projects}</TD>
                  {permissions.billing && <TD className="text-right">{c.outstanding && Number(c.outstanding) > 0 ? <Money amount={c.outstanding} currency={c.currency} className="font-medium" /> : <span className="text-muted">—</span>}</TD>}
                  <TD className="hidden text-[13px] text-muted sm:table-cell">{c.portal_users ? `${c.portal_users} user${c.portal_users > 1 ? "s" : ""}` : "Not invited"}</TD>
                  <TD><StatusBadge kind="client" status={c.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {query.data && <Pagination page={query.data.page} totalPages={query.data.total_pages} count={query.data.count} onPage={(p) => set("page", String(p))} />}
        </QueryState>
      </Card>
      <ClientFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
