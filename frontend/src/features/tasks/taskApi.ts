import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, errorMessage, type Paginated } from "@/lib/api";
import type { Task, TaskStatus } from "@/lib/types";

export const TASK_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "done", label: "Done" },
];

export function useTaskList(params: string, enabled = true) {
  return useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.get<Task[] | Paginated<Task>>(`/tasks/?${params}`),
    enabled,
  });
}

export function asList(data: Task[] | Paginated<Task> | undefined): Task[] {
  if (!data) return [];
  return Array.isArray(data) ? data : data.results;
}

/** Optimistically patches a task everywhere it is cached, then persists it. */
export function useTaskUpdater() {
  const queryClient = useQueryClient();
  return async (task: Task, changes: Partial<Task> & Record<string, unknown>) => {
    const snapshots = queryClient.getQueriesData<Task[] | Paginated<Task>>({ queryKey: ["tasks"] });
    const apply = (t: Task) => (t.id === task.id ? { ...t, ...changes } : t);
    for (const [key, data] of snapshots) {
      if (!data) continue;
      queryClient.setQueryData(key, Array.isArray(data) ? data.map(apply) : { ...data, results: data.results.map(apply) });
    }
    try {
      const updated = await api.patch<Task>(`/tasks/${task.id}/`, changes);
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      queryClient.invalidateQueries({ queryKey: ["project"] });
      return updated;
    } catch (err) {
      for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
      toast.error(errorMessage(err));
      throw err;
    }
  };
}
