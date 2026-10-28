import { CalendarClock, GitBranch, Link2, Lock } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";

import { PriorityIndicator, StatusBadge } from "@/components/common/status";
import { Select } from "@/components/ui/input";
import { Avatar, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { daysUntil, formatDateShort, formatDuration } from "@/lib/format";
import type { Task, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TASK_COLUMNS, useTaskUpdater } from "./taskApi";

export function useOpenTask() {
  const [params, setParams] = useSearchParams();
  return (id: number) => {
    const next = new URLSearchParams(params);
    next.set("task", String(id));
    setParams(next);
  };
}

export function DueLabel({ date, done }: { date: string | null; done?: boolean }) {
  if (!date) return <span className="text-muted">—</span>;
  const days = daysUntil(date) ?? 0;
  const tone = done ? "text-muted" : days < 0 ? "text-danger font-medium" : days <= 2 ? "text-warning font-medium" : "text-muted";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs tabular", tone)}>
      <CalendarClock className="size-3.5" aria-hidden />
      {days === 0 && !done ? "Today" : formatDateShort(date)}
    </span>
  );
}

function TaskCard({ task, onOpen, onDragStart, onDropBefore }: { task: Task; onOpen: () => void; onDragStart: (e: React.DragEvent) => void; onDropBefore: (e: React.DragEvent) => void }) {
  const done = task.status === "done";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropBefore}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      role="button"
      tabIndex={0}
      aria-label={`${task.key} ${task.title}`}
      data-testid={`task-card-${task.id}`}
      className="group cursor-grab rounded-lg border border-border bg-surface p-3 shadow-card transition-shadow hover:border-border-strong hover:shadow-md active:cursor-grabbing"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted">{task.key}</span>
        <PriorityIndicator priority={task.priority} showLabel={false} />
      </div>
      <p className={cn("mt-1 text-[13px] font-medium leading-snug", done && "text-muted line-through")}>{task.title}</p>
      {task.label_details.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.label_details.map((l) => (
            <span key={l.id} className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${l.color}1f`, color: l.color }}>
              {l.name}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2 text-xs text-muted">
        <DueLabel date={task.due_date} done={done} />
        {task.subtask_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3.5" />
            {task.subtask_done}/{task.subtask_count}
          </span>
        )}
        {task.is_blocked && (
          <span className="inline-flex items-center gap-1 text-warning" title="Blocked by another task">
            <Lock className="size-3.5" />
          </span>
        )}
        {task.tracked_seconds > 0 && <span className="tabular">{formatDuration(task.tracked_seconds)}</span>}
        <span className="ml-auto">{task.assignee_detail ? <Avatar name={task.assignee_detail.full_name} size={20} /> : null}</span>
      </div>
    </div>
  );
}

export function TaskBoard({ tasks, showProject = true }: { tasks: Task[]; showProject?: boolean }) {
  const open = useOpenTask();
  const update = useTaskUpdater();
  const dragId = React.useRef<number | null>(null);
  const [over, setOver] = React.useState<TaskStatus | null>(null);
  const byStatus = React.useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const col of TASK_COLUMNS) map[col.status] = [];
    for (const t of tasks) if (map[t.status]) map[t.status].push(t);
    for (const list of Object.values(map)) list.sort((a, b) => a.position - b.position || a.id - b.id);
    return map;
  }, [tasks]);

  const move = (status: TaskStatus, beforeTask?: Task) => {
    const id = dragId.current;
    dragId.current = null;
    setOver(null);
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const column = byStatus[status].filter((t) => t.id !== task.id);
    let position: number;
    if (beforeTask && beforeTask.id !== task.id) {
      const idx = column.findIndex((t) => t.id === beforeTask.id);
      const prev = column[idx - 1];
      position = prev ? (prev.position + beforeTask.position) / 2 : beforeTask.position - 1000;
    } else {
      position = (column[column.length - 1]?.position ?? 0) + 1000;
    }
    if (task.status === status && task.position === position) return;
    update(task, { status, position }).catch(() => undefined);
  };

  return (
    <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 scrollbar-thin">
      {TASK_COLUMNS.map((col) => (
        <section
          key={col.status}
          aria-label={col.label}
          data-testid={`column-${col.status}`}
          onDragOver={(e) => { e.preventDefault(); setOver(col.status); }}
          onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
          onDrop={(e) => { e.preventDefault(); move(col.status); }}
          className={cn("flex min-h-[18rem] flex-col rounded-lg bg-subtle/70 p-2 transition-colors", over === col.status && "bg-primary-soft ring-1 ring-primary/30")}
        >
          <header className="flex items-center justify-between px-1.5 pb-2 pt-1">
            <div className="flex items-center gap-2">
              <StatusBadge kind="task" status={col.status} />
            </div>
            <span className="text-xs tabular text-muted">{byStatus[col.status].length}</span>
          </header>
          <div className="flex flex-1 flex-col gap-2">
            {byStatus[col.status].map((task) => (
              <TaskCard
                key={task.id}
                task={showProject ? task : { ...task }}
                onOpen={() => open(task.id)}
                onDragStart={(e) => { dragId.current = task.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(task.id)); }}
                onDropBefore={(e) => { e.preventDefault(); e.stopPropagation(); move(col.status, task); }}
              />
            ))}
            {byStatus[col.status].length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">Drop tasks here</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

export function TaskTable({ tasks, showProject = true }: { tasks: Task[]; showProject?: boolean }) {
  const open = useOpenTask();
  const update = useTaskUpdater();
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-28">Key</TH>
          <TH>Task</TH>
          {showProject && <TH className="hidden md:table-cell">Project</TH>}
          <TH className="hidden sm:table-cell">Assignee</TH>
          <TH>Status</TH>
          <TH className="hidden lg:table-cell">Priority</TH>
          <TH>Due</TH>
          <TH className="hidden text-right md:table-cell">Tracked / est.</TH>
        </tr>
      </THead>
      <TBody>
        {tasks.map((t) => (
          <TR key={t.id} className="cursor-pointer" onClick={() => open(t.id)}>
            <TD className="font-mono text-xs text-muted">{t.key}</TD>
            <TD>
              <div className="flex items-center gap-2">
                {t.parent && <Link2 className="size-3.5 text-muted" aria-label="Subtask" />}
                <span className={cn("font-medium", t.status === "done" && "text-muted line-through")}>{t.title}</span>
                {t.is_blocked && <Lock className="size-3.5 text-warning" aria-label="Blocked" />}
                {t.subtask_count > 0 && <span className="text-xs text-muted">{t.subtask_done}/{t.subtask_count}</span>}
              </div>
            </TD>
            {showProject && <TD className="hidden text-muted md:table-cell">{t.project_code}</TD>}
            <TD className="hidden sm:table-cell">
              {t.assignee_detail ? (
                <span className="inline-flex items-center gap-2"><Avatar name={t.assignee_detail.full_name} size={22} /><span className="text-[13px]">{t.assignee_detail.full_name}</span></span>
              ) : (
                <span className="text-muted">Unassigned</span>
              )}
            </TD>
            <TD onClick={(e) => e.stopPropagation()}>
              <Select
                aria-label={`Status of ${t.title}`}
                value={t.status}
                onChange={(e) => update(t, { status: e.target.value as TaskStatus }).catch(() => undefined)}
                className="h-7 w-[8.5rem] text-xs"
              >
                {[...TASK_COLUMNS, { status: "cancelled" as TaskStatus, label: "Cancelled" }].map((c) => (
                  <option key={c.status} value={c.status}>{c.label}</option>
                ))}
              </Select>
            </TD>
            <TD className="hidden lg:table-cell"><PriorityIndicator priority={t.priority} /></TD>
            <TD><DueLabel date={t.due_date} done={t.status === "done"} /></TD>
            <TD className="hidden text-right text-xs tabular text-muted md:table-cell">
              {formatDuration(t.tracked_seconds)} / {t.estimated_hours ? `${Number(t.estimated_hours)}h` : "—"}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
