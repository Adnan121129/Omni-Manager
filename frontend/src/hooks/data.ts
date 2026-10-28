import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { api, errorMessage, type Paginated } from "@/lib/api";
import type { Client, Label, Member, Project } from "@/lib/types";

import { useAuth } from "./session";

export function useMembers(options: { includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: ["members", "staff", options.includeInactive ?? false],
    queryFn: () =>
      api.get<Paginated<Member>>(`/team/members/?role=staff&page_size=200${options.includeInactive ? "" : "&status=active"}`).then((r) => r.results),
    staleTime: 60_000,
  });
}

/**
 * People a task on this project may be assigned to. The API accepts anyone from the project's manager (or an
 * admin), but only project members, owners and admins from everyone else.
 */
export function useAssigneeOptions(projectId: number | null | undefined, enabled = true) {
  const members = useMembers();
  const on = Boolean(projectId) && enabled;
  const project = useQuery({
    queryKey: ["assignee-scope", "project", projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}/`),
    enabled: on,
    staleTime: 60_000,
  });
  const projectMembers = useQuery({
    queryKey: ["assignee-scope", "members", projectId],
    queryFn: () => api.get<{ user: { id: number } }[]>(`/projects/${projectId}/members/`),
    enabled: on && project.data !== undefined && !project.data.can_manage,
    staleTime: 60_000,
  });
  const all = members.data ?? [];
  if (!projectId || project.data?.can_manage) return all;
  const onProject = new Set((projectMembers.data ?? []).map((m) => m.user.id));
  return all.filter((m) => onProject.has(m.user.id) || m.role === "owner" || m.role === "admin");
}

export function useProjectOptions(options: { includeClosed?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["project-options", options.includeClosed ?? false],
    queryFn: () =>
      api.get<Paginated<Project>>(`/projects/?page_size=200&ordering=code${options.includeClosed ? "" : "&status=open"}`).then((r) => r.results),
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
}

export function useClientOptions(enabled = true) {
  const { permissions } = useAuth();
  return useQuery({
    queryKey: ["client-options"],
    queryFn: () => api.get<Paginated<Client>>("/clients/?page_size=200&ordering=name").then((r) => r.results),
    staleTime: 60_000,
    enabled: enabled && permissions.is_manager,
  });
}

export function useLabels() {
  return useQuery({ queryKey: ["labels"], queryFn: () => api.get<Label[]>("/labels/"), staleTime: 5 * 60_000 });
}

export function useExpenseCategories() {
  return useQuery({
    queryKey: ["expense-categories"],
    queryFn: () => api.get<{ id: number; name: string; is_active: boolean }[]>("/expense-categories/"),
    staleTime: 5 * 60_000,
  });
}

/** Mutation with consistent toast feedback and cache invalidation. */
export function useApiMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult, vars: TVars) => void; silentError?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      for (const key of opts.invalidate ?? []) queryClient.invalidateQueries({ queryKey: key });
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(result) : opts.success);
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => {
      if (!opts.silentError) toast.error(errorMessage(err));
    },
  });
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function useTheme() {
  const [theme, setTheme] = React.useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const apply = React.useCallback((next: "light" | "dark") => {
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("om-theme", next);
    } catch {
      /* storage unavailable - theme still applies for this session */
    }
    setTheme(next);
  }, []);
  return { theme, setTheme: apply, toggle: () => apply(theme === "dark" ? "light" : "dark") };
}
