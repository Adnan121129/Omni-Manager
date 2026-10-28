import { LayoutGrid, List, ListChecks, Plus } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";

import { EmptyState, FilterBar, PageHeader, Pagination, QueryState, SearchInput } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Segmented } from "@/components/ui/overlays";
import { Card } from "@/components/ui/primitives";
import { asList, useTaskList } from "@/features/tasks/taskApi";
import { TaskCreateDialog } from "@/features/tasks/TaskDrawer";
import { TaskBoard, TaskTable } from "@/features/tasks/TaskViews";
import { useDebounced, useLabels, useMembers, useProjectOptions } from "@/hooks/data";
import type { Paginated } from "@/lib/api";
import type { Task } from "@/lib/types";
import { safeStorage, toQuery } from "@/lib/utils";

export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = React.useState<"list" | "board">(() => (safeStorage.get("om-tasks-view") as "list" | "board") || "list");
  const [search, setSearch] = React.useState(params.get("search") ?? "");
  const [creating, setCreating] = React.useState(false);
  const debounced = useDebounced(search);
  const projects = useProjectOptions();
  const members = useMembers();
  const labels = useLabels();
  const get = (k: string, d = "") => params.get(k) ?? d;
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const status = get("status", "open");
  const qs = toQuery({
    search: debounced,
    project: get("project"),
    assignee: get("assignee"),
    status: status === "all" ? "" : status,
    priority: get("priority"),
    due: get("due"),
    label: get("label"),
    ordering: get("ordering", view === "board" ? "position" : "due"),
    ...(view === "board" ? { all: 1, parent: "none" } : { page: get("page", "1"), page_size: 50 }),
  }).slice(1);
  const query = useTaskList(qs);
  const tasks = asList(query.data);
  const paged = !Array.isArray(query.data) ? (query.data as Paginated<Task> | undefined) : undefined;
  const filtered = Boolean(debounced || get("project") || get("assignee") || get("priority") || get("due") || get("label"));

  return (
    <>
      <PageHeader
        title="Tasks"
        description="All work across your projects. Changes save immediately and appear everywhere."
        actions={
          <>
            <Segmented
              value={view}
              onChange={(v) => { setView(v); safeStorage.set("om-tasks-view", v); }}
              options={[{ value: "list", label: "List", icon: <List /> }, { value: "board", label: "Board", icon: <LayoutGrid /> }]}
            />
            <Button onClick={() => setCreating(true)}><Plus /> New task</Button>
          </>
        }
      />
      <Card className={view === "board" ? "mb-4" : undefined}>
        <FilterBar className={view === "board" ? "border-b-0" : undefined}>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setParam("search", v); }} placeholder="Search tasks…" />
          <Select aria-label="Project" value={get("project")} onChange={(e) => setParam("project", e.target.value)} className="sm:w-52">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
          <Select aria-label="Assignee" value={get("assignee")} onChange={(e) => setParam("assignee", e.target.value)} className="sm:w-44">
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {members.data?.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
          </Select>
          {view === "list" && (
            <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value)} className="sm:w-36">
              <option value="open">Open</option>
              <option value="all">All statuses</option>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="in_review">In review</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          )}
          <Select aria-label="Due" value={get("due")} onChange={(e) => setParam("due", e.target.value)} className="sm:w-36">
            <option value="">Any due date</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="week">Next 7 days</option>
          </Select>
          <Select aria-label="Priority" value={get("priority")} onChange={(e) => setParam("priority", e.target.value)} className="sm:w-32">
            <option value="">Any priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
          <Select aria-label="Label" value={get("label")} onChange={(e) => setParam("label", e.target.value)} className="sm:w-32">
            <option value="">Any label</option>
            {labels.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          {view === "list" && (
            <Select aria-label="Sort" value={get("ordering", "due")} onChange={(e) => setParam("ordering", e.target.value)} className="sm:w-40">
              <option value="due">Due date</option>
              <option value="-priority">Priority</option>
              <option value="-updated">Recently updated</option>
              <option value="title">Title</option>
            </Select>
          )}
        </FilterBar>
        {view === "list" && (
          <QueryState
            query={query}
            empty={tasks.length === 0 && <EmptyState icon={ListChecks} title={filtered ? "No tasks match these filters" : "No open tasks"} description="Create a task or adjust the filters." action={<Button onClick={() => setCreating(true)}><Plus /> New task</Button>} />}
          >
            <TaskTable tasks={tasks} />
            {paged && <Pagination page={paged.page} totalPages={paged.total_pages} count={paged.count} onPage={(p) => setParam("page", String(p))} />}
          </QueryState>
        )}
      </Card>
      {view === "board" && (
        <QueryState query={query}>
          <TaskBoard tasks={tasks.filter((t) => t.status !== "cancelled")} />
        </QueryState>
      )}
      <TaskCreateDialog open={creating} onOpenChange={setCreating} projectId={get("project") ? Number(get("project")) : undefined} />
    </>
  );
}
