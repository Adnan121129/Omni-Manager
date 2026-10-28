import { useQuery } from "@tanstack/react-query";
import { Pause, Play, Square, Timer, Trash2 } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { useProjectOptions } from "@/hooks/data";
import { useTimer } from "@/hooks/timer";
import { api, type Paginated } from "@/lib/api";
import { formatClock } from "@/lib/format";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

export function useProjectTasks(projectId: number | null | undefined) {
  return useQuery({
    queryKey: ["task-options", projectId],
    queryFn: () => api.get<Paginated<Task>>(`/tasks/?project=${projectId}&status=open&page_size=200&ordering=title`).then((r) => r.results),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

function StartForm({ onStarted }: { onStarted: () => void }) {
  const timer = useTimer();
  const projects = useProjectOptions();
  const [project, setProject] = React.useState<number | "">("");
  const [task, setTask] = React.useState<number | "">("");
  const [description, setDescription] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const tasks = useProjectTasks(project || null);

  return (
    <form
      className="space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!project) return;
        await timer.start({ project: Number(project), task: task ? Number(task) : null, description, billable });
        onStarted();
      }}
    >
      <p className="text-sm font-semibold">Start a timer</p>
      <Field label="Project" htmlFor="timer-project" required>
        <Select id="timer-project" value={project} onChange={(e) => { setProject(e.target.value ? Number(e.target.value) : ""); setTask(""); }} required>
          <option value="">Select a project…</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Task" htmlFor="timer-task">
        <Select
          id="timer-task"
          value={task}
          disabled={!project}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : "";
            setTask(id);
            const t = tasks.data?.find((x) => x.id === id);
            if (t) setBillable(t.billable);
          }}
        >
          <option value="">No task</option>
          {tasks.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} · {t.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="What are you working on?" htmlFor="timer-desc">
        <Input id="timer-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable
      </label>
      <Button type="submit" className="w-full" loading={timer.busy} disabled={!project}>
        <Play /> Start timer
      </Button>
    </form>
  );
}

function RunningEditor() {
  const timer = useTimer();
  const entry = timer.entry!;
  const [description, setDescription] = React.useState(entry.description);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  React.useEffect(() => setDescription(entry.description), [entry.description]);
  return (
    <div className="space-y-3 p-4">
      <div>
        <p className="text-xs text-muted">{entry.project_detail.client_name}</p>
        <p className="text-sm font-semibold">
          {entry.project_detail.code} · {entry.project_detail.name}
        </p>
        {entry.task_detail && <p className="text-[13px] text-muted">{entry.task_detail.key} · {entry.task_detail.title}</p>}
      </div>
      <div className="text-center text-3xl font-semibold tabular tracking-tight">{formatClock(timer.elapsed)}</div>
      <Field label="Description" htmlFor="running-desc">
        <Input
          id="running-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== entry.description && timer.update({ description })}
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox checked={entry.billable} onChange={(e) => timer.update({ billable: e.target.checked })} /> Billable
      </label>
      <div className="grid grid-cols-2 gap-2">
        {entry.timer_state === "running" ? (
          <Button variant="outline" onClick={timer.pause} loading={timer.busy}>
            <Pause /> Pause
          </Button>
        ) : (
          <Button variant="outline" onClick={timer.resume} loading={timer.busy}>
            <Play /> Resume
          </Button>
        )}
        <Button variant="danger" onClick={timer.stop} loading={timer.busy}>
          <Square /> Stop
        </Button>
      </div>
      <Button variant="ghost" size="sm" className="w-full text-muted" onClick={() => setConfirmDiscard(true)}>
        <Trash2 /> Discard timer
      </Button>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this timer?"
        description="The tracked time will not be saved."
        confirmLabel="Discard"
        onConfirm={async () => {
          await timer.discard();
          setConfirmDiscard(false);
        }}
      />
    </div>
  );
}

export function TimerWidget() {
  const timer = useTimer();
  const [open, setOpen] = React.useState(false);
  const entry = timer.entry;
  const running = entry?.timer_state === "running";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {entry ? (
          <div
            className={cn(
              "flex h-9 items-center gap-1 rounded-md border pl-2.5 pr-1",
              running ? "border-primary/30 bg-primary-soft" : "border-warning/30 bg-warning-soft",
            )}
          >
            <PopoverTrigger asChild>
              <button type="button" className="flex items-center gap-2 text-left" aria-label="Timer details" data-testid="timer-display">
                <span className={cn("size-2 rounded-full", running ? "animate-pulse-dot bg-primary" : "bg-warning")} aria-hidden />
                <span className="hidden max-w-[10rem] truncate text-[13px] font-medium md:inline">
                  {entry.task_detail?.title ?? entry.project_detail.name}
                </span>
                <span className="font-mono text-[13px] font-semibold tabular" aria-live="off">
                  {formatClock(timer.elapsed)}
                </span>
              </button>
            </PopoverTrigger>
            {running ? (
              <Button variant="ghost" size="icon-sm" onClick={timer.pause} disabled={timer.busy} aria-label="Pause timer">
                <Pause />
              </Button>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={timer.resume} disabled={timer.busy} aria-label="Resume timer">
                <Play />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={timer.stop} disabled={timer.busy} aria-label="Stop timer" className="text-danger">
              <Square />
            </Button>
          </div>
        ) : (
          <PopoverTrigger asChild>
            <Button variant="outline" size="md" aria-label="Start timer" data-testid="timer-start-open">
              <Timer /> <span className="hidden sm:inline">Start timer</span>
            </Button>
          </PopoverTrigger>
        )}
        <PopoverContent className="w-80">{entry ? <RunningEditor /> : <StartForm onStarted={() => setOpen(false)} />}</PopoverContent>
      </Popover>
      <ConfirmDialog
        open={Boolean(timer.conflict)}
        onOpenChange={(o) => !o && timer.resolveConflict(false)}
        title="A timer is already running"
        description="Only one timer can run at a time. Switching will stop the current timer, save its time as a draft entry, and start the new one."
        confirmLabel="Stop current & start new"
        tone="primary"
        onConfirm={() => timer.resolveConflict(true)}
      />
    </>
  );
}
