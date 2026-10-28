/**
 * Global timer state. The server is the source of truth: the client only renders
 * elapsed = accumulated + (server-adjusted now − segment_started_at), so closing the tab,
 * refreshing or losing the network never loses time.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { api, ApiError, errorMessage } from "@/lib/api";
import type { TimeEntry } from "@/lib/types";
import { uid } from "@/lib/utils";

interface TimerPayload {
  entry: TimeEntry | null;
  server_now: string;
}

export interface StartArgs {
  project: number;
  task?: number | null;
  description?: string;
  billable?: boolean | null;
}

interface TimerContextValue {
  entry: TimeEntry | null;
  elapsed: number;
  isLoading: boolean;
  busy: boolean;
  start: (args: StartArgs) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
  update: (fields: Partial<{ project: number; task: number | null; description: string; billable: boolean }>) => Promise<void>;
  conflict: { args: StartArgs; message: string } | null;
  resolveConflict: (switchTimer: boolean) => Promise<void>;
}

const TimerContext = React.createContext<TimerContextValue | null>(null);

export function computeElapsed(entry: TimeEntry | null, nowMs: number, offsetMs: number): number {
  if (!entry) return 0;
  if (entry.timer_state === "running" && entry.segment_started_at) {
    const started = new Date(entry.segment_started_at).getTime();
    return entry.accumulated_seconds + Math.max(0, Math.floor((nowMs + offsetMs - started) / 1000));
  }
  return entry.accumulated_seconds;
}

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const offsetRef = React.useRef(0);
  const [busy, setBusy] = React.useState(false);
  const [conflict, setConflict] = React.useState<{ args: StartArgs; message: string } | null>(null);
  const query = useQuery({
    queryKey: ["timer"],
    queryFn: async () => {
      const t0 = Date.now();
      const data = await api.get<TimerPayload>("/timer/");
      const latency = (Date.now() - t0) / 2;
      offsetRef.current = new Date(data.server_now).getTime() - (Date.now() - latency);
      return data;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const entry = query.data?.entry ?? null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (entry?.timer_state !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [entry?.timer_state]);

  const applyPayload = React.useCallback(
    (data: TimerPayload) => {
      offsetRef.current = new Date(data.server_now).getTime() - Date.now();
      queryClient.setQueryData(["timer"], data);
      setNow(Date.now());
    },
    [queryClient],
  );

  const invalidateWork = React.useCallback(() => {
    for (const key of [["time-entries"], ["timesheet"], ["tasks"], ["task"], ["dashboard"], ["project"]]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient]);

  const run = React.useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        toast.error(errorMessage(err));
        await queryClient.invalidateQueries({ queryKey: ["timer"] });
      } finally {
        setBusy(false);
      }
    },
    [queryClient],
  );

  const doStart = React.useCallback(
    async (args: StartArgs, switchTimer: boolean) => {
      setBusy(true);
      try {
        const data = await api.post<TimerPayload>("/timer/start/", { ...args, request_id: uid(), switch: switchTimer });
        applyPayload(data);
        invalidateWork();
        toast.success("Timer started");
      } catch (err) {
        if (err instanceof ApiError && err.code === "timer_running") {
          setConflict({ args, message: err.message });
        } else {
          toast.error(errorMessage(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [applyPayload, invalidateWork],
  );

  const value: TimerContextValue = {
    entry,
    elapsed: computeElapsed(entry, now, offsetRef.current),
    isLoading: query.isLoading,
    busy,
    conflict,
    start: (args) => doStart(args, false),
    resolveConflict: async (switchTimer) => {
      const pending = conflict;
      setConflict(null);
      if (switchTimer && pending) await doStart(pending.args, true);
    },
    pause: () => run(async () => applyPayload(await api.post<TimerPayload>("/timer/pause/"))),
    resume: () => run(async () => applyPayload(await api.post<TimerPayload>("/timer/resume/"))),
    stop: () =>
      run(async () => {
        const result = await api.post<{ entry: TimeEntry | null; discarded?: boolean; server_now: string }>("/timer/stop/", { entry_id: entry?.id });
        applyPayload({ entry: null, server_now: result.server_now });
        invalidateWork();
        toast.success(result.discarded ? "Timer discarded (no time recorded)" : "Time entry saved as draft");
      }),
    discard: () =>
      run(async () => {
        applyPayload(await api.post<TimerPayload>("/timer/discard/"));
        toast.success("Timer discarded");
      }),
    update: (fields) =>
      run(async () => {
        applyPayload(await api.patch<TimerPayload>("/timer/current/", fields));
      }),
  };
  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimer(): TimerContextValue {
  const ctx = React.useContext(TimerContext);
  if (!ctx) throw new Error("useTimer must be used inside TimerProvider");
  return ctx;
}
