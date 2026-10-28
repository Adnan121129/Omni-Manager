import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, LayoutGrid, List, Plus } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { EmptyState, FilterBar, PageHeader, Pagination, QueryState, SearchInput, SortableTH } from "@/components/common/layout-bits";
import { HealthDot, PriorityIndicator, StatusBadge, statusLabel } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Segmented, Tooltip } from "@/components/ui/overlays";
import { Avatar, Card, ProgressBar, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ProjectFormDialog } from "@/features/projects/ProjectForm";
import { useClientOptions, useDebounced, useMembers } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, errorMessage, type Paginated } from "@/lib/api";
import { daysUntil, formatDateShort, formatHours } from "@/lib/format";
import type { Project, ProjectStatus } from "@/lib/types";
import { cn, safeStorage, toQuery } from "@/lib/utils";

const BOARD_COLUMNS: ProjectStatus[] = ["planning", "active", "on_hold", "completed"];

function Deadline({ date, done }: { date: string | null; done: boolean }) {
  if (!date) return <span className="text-muted">—</span>;
  const days = daysUntil(date) ?? 0;
  return (
    <span className={cn("tabular", !done && days < 0 && "font-medium text-danger", !done && days >= 0 && days <= 14 && "font-medium text-warning")}>
      {formatDateShort(date)}
      {!done && days < 0 && <span className="ml-1 text-xs">({-days}d late)</span>}
    </span>
  );
}

function HealthTip({ project }: { project: Project }) {
  if (!project.health) return null;
  const reasons = project.health.signals.filter((s) => s.level !== "ok").map((s) => s.reason);
  return (
    <Tooltip content={reasons.length ? reasons.join(" ") : project.health.signals[0]?.reason}>
      <span className="inline-flex items-center gap-1.5 text-[13px]">
        <HealthDot status={project.health.status} />
        {statusLabel("health", project.health.status)}
      </span>
    </Tooltip>
  );
}

function ProjectBoard({ projects }: { projects: Project[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dragged = React.useRef<Project | null>(null);
  const move = async (status: ProjectStatus) => {
    const project = dragged.current;
    dragged.current = null;
    if (!project || project.status === status) return;
    if (status === "completed") {
      navigate(`/projects/${project.id}?complete=1`);
      return;
    }
    if (!project.can_manage) return toast.error("Only the project's manager can change its status.");
    try {
      await api.patch(`/projects/${project.id}/`, { status });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${project.code} moved to ${statusLabel("project", status)}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="grid auto-cols-[minmax(270px,1fr)] grid-flow-col gap-3 overflow-x-auto p-4 scrollbar-thin">
      {BOARD_COLUMNS.map((status) => {
        const items = projects.filter((p) => p.status === status);
        return (
          <section key={status} onDragOver={(e) => e.preventDefault()} onDrop={() => move(status)} className="flex min-h-[16rem] flex-col rounded-lg bg-subtle/70 p-2" aria-label={statusLabel("project", status)}>
            <header className="flex items-center justify-between px-1.5 pb-2 pt-1">
              <StatusBadge kind="project" status={status} />
              <span className="text-xs text-muted tabular">{items.length}</span>
            </header>
            <div className="flex flex-col gap-2">
              {items.map((p) => (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}`}
                  draggable
                  onDragStart={() => { dragged.current = p; }}
                  className="rounded-lg border border-border bg-surface p-3 shadow-card hover:border-border-strong"
                >
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
                    <span className="font-mono text-[11px] text-muted">{p.code}</span>
                    {p.health && <span className="ml-auto"><HealthDot status={p.health.status} /></span>}
                  </div>
                  <p className="mt-1 text-[13px] font-medium leading-snug">{p.name}</p>
                  <p className="text-xs text-muted">{p.client_name}</p>
                  <div className="mt-3 space-y-1">
                    <div className="flex justify-between text-[11px] text-muted"><span>{p.progress?.tasks_done}/{p.progress?.tasks_total} tasks</span><span>{p.progress?.percent}%</span></div>
                    <ProgressBar value={p.progress?.percent ?? 0} tone="primary" />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <Deadline date={p.deadline} done={p.status === "completed"} />
                    {p.manager_detail && <Avatar name={p.manager_detail.full_name} size={20} />}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function ProjectsPage() {
  const { permissions } = useAuth();
  const [params, setParams] = useSearchParams();
  const [view, setView] = React.useState<"table" | "board">(() => (safeStorage.get("om-projects-view") as "table" | "board") || "table");
  const [search, setSearch] = React.useState(params.get("search") ?? "");
  const debounced = useDebounced(search);
  const status = params.get("status") ?? "open";
  const client = params.get("client") ?? "";
  const manager = params.get("manager") ?? "";
  const priority = params.get("priority") ?? "";
  const type = params.get("type") ?? "";
  const ordering = params.get("ordering") ?? "-created";
  const page = Number(params.get("page") ?? 1);
  const clients = useClientOptions();
  const members = useMembers();
  const [creating, setCreating] = React.useState(params.get("new") === "1");

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const qs = toQuery({
    search: debounced, status: status === "all" ? "" : status, client, manager, priority, type, ordering,
    page: view === "table" ? page : 1, page_size: view === "board" ? 200 : 25,
  });
  const query = useQuery({ queryKey: ["projects", qs], queryFn: () => api.get<Paginated<Project>>(`/projects/${qs}`) });
  const projects = query.data?.results ?? [];

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every engagement, its budget, schedule and health in one place."
        actions={
          <>
            <Segmented
              value={view}
              onChange={(v) => { setView(v); safeStorage.set("om-projects-view", v); }}
              options={[{ value: "table", label: "Table", icon: <List /> }, { value: "board", label: "Board", icon: <LayoutGrid /> }]}
            />
            {permissions.is_manager && <Button onClick={() => setCreating(true)}><Plus /> New project</Button>}
          </>
        }
      />
      <Card>
        <FilterBar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setParam("search", v); }} placeholder="Search projects or codes…" />
          <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value)} className="sm:w-40">
            <option value="open">Open projects</option>
            <option value="all">All statuses</option>
            <option value="planning">Planning</option>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          {permissions.is_manager && (
            <Select aria-label="Client" value={client} onChange={(e) => setParam("client", e.target.value)} className="sm:w-44">
              <option value="">All clients</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
          <Select aria-label="Manager" value={manager} onChange={(e) => setParam("manager", e.target.value)} className="sm:w-44">
            <option value="">Any manager</option>
            {members.data?.filter((m) => m.role !== "member").map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
          </Select>
          <Select aria-label="Priority" value={priority} onChange={(e) => setParam("priority", e.target.value)} className="sm:w-36">
            <option value="">Any priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
          <Select aria-label="Billing model" value={type} onChange={(e) => setParam("type", e.target.value)} className="sm:w-44">
            <option value="">All billing models</option>
            <option value="hourly">Time & materials</option>
            <option value="fixed">Fixed price</option>
            <option value="retainer">Retainer</option>
          </Select>
        </FilterBar>
        <QueryState
          query={query}
          empty={
            projects.length === 0 && (
              <EmptyState
                icon={FolderKanban}
                title={debounced || client || priority ? "No projects match these filters" : "No projects yet"}
                description="Projects connect clients, tasks, time, budgets and invoices."
                action={permissions.is_manager ? <Button onClick={() => setCreating(true)}><Plus /> New project</Button> : undefined}
              />
            )
          }
        >
          {view === "board" ? (
            <ProjectBoard projects={projects} />
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <SortableTH label="Project" field="name" ordering={ordering} onSort={(o) => setParam("ordering", o)} />
                    <SortableTH label="Client" field="client" ordering={ordering} onSort={(o) => setParam("ordering", o)} className="hidden md:table-cell" />
                    <TH>Status</TH>
                    <TH className="hidden lg:table-cell">Health</TH>
                    <TH className="hidden sm:table-cell">Progress</TH>
                    <TH className="hidden xl:table-cell">Budget used</TH>
                    <SortableTH label="Deadline" field="deadline" ordering={ordering} onSort={(o) => setParam("ordering", o)} />
                    <SortableTH label="Priority" field="priority" ordering={ordering} onSort={(o) => setParam("ordering", o)} className="hidden lg:table-cell" />
                    <TH className="hidden md:table-cell">Manager</TH>
                  </tr>
                </THead>
                <TBody>
                  {projects.map((p) => {
                    const used = p.budget?.used_percent ?? p.budget?.hours_percent;
                    return (
                      <TR key={p.id}>
                        <TD>
                          <Link to={`/projects/${p.id}`} className="group flex items-center gap-2.5">
                            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium group-hover:text-primary">{p.name}</span>
                              <span className="font-mono text-[11px] text-muted">{p.code}</span>
                            </span>
                          </Link>
                        </TD>
                        <TD className="hidden text-muted md:table-cell">{p.client_name}</TD>
                        <TD><StatusBadge kind="project" status={p.status} /></TD>
                        <TD className="hidden lg:table-cell"><HealthTip project={p} /></TD>
                        <TD className="hidden w-36 sm:table-cell">
                          <div className="flex items-center gap-2">
                            <ProgressBar value={p.progress?.percent ?? 0} tone="primary" className="w-20" />
                            <span className="text-xs tabular text-muted">{p.progress?.percent ?? 0}%</span>
                          </div>
                        </TD>
                        <TD className="hidden w-40 xl:table-cell">
                          {used ? (
                            <div className="flex items-center gap-2">
                              <ProgressBar value={Number(used)} className="w-20" />
                              <span className="text-xs tabular text-muted">{Number(used).toFixed(0)}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted">{p.budget ? formatHours(p.budget.hours_tracked) : "—"}</span>
                          )}
                        </TD>
                        <TD><Deadline date={p.deadline} done={["completed", "cancelled"].includes(p.status)} /></TD>
                        <TD className="hidden lg:table-cell"><PriorityIndicator priority={p.priority} /></TD>
                        <TD className="hidden md:table-cell">
                          {p.manager_detail ? <span className="inline-flex items-center gap-2"><Avatar name={p.manager_detail.full_name} size={22} /><span className="text-[13px]">{p.manager_detail.full_name}</span></span> : "—"}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              {query.data && <Pagination page={query.data.page} totalPages={query.data.total_pages} count={query.data.count} onPage={(p) => setParam("page", String(p))} />}
            </>
          )}
        </QueryState>
      </Card>
      <ProjectFormDialog open={creating} onOpenChange={(o) => { setCreating(o); if (!o && params.get("new")) setParam("new", ""); }} defaultClient={params.get("client") ? Number(params.get("client")) : undefined} />
    </>
  );
}
