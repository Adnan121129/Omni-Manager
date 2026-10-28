import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Building2, Check, CheckCheck, ChevronDown, FileText, FolderKanban, LogOut, Moon, Receipt, Search, Settings, Sun, User, Users, ListChecks, Target } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Avatar, Kbd } from "@/components/ui/primitives";
import { useDebounced, useTheme } from "@/hooks/data";
import { SESSION_KEY, useAuth } from "@/hooks/session";
import { api, errorMessage, type Paginated } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Notification, Session } from "@/lib/types";
import { cn } from "@/lib/utils";

export function NotificationsBell({ portal = false }: { portal?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<Paginated<Notification> & { unread_count: number }>("/notifications/?page_size=20"),
    refetchInterval: 45_000,
  });
  const unread = query.data?.unread_count ?? 0;
  const markRead = async (n: Notification) => {
    if (!n.is_read) {
      await api.post(`/notifications/${n.id}/read/`).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
    setOpen(false);
    if (n.link) navigate(portal && !n.link.startsWith("/portal") ? "/portal" : n.link);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={!unread}
            onClick={async () => {
              await api.post("/notifications/read-all/");
              queryClient.invalidateQueries({ queryKey: ["notifications"] });
            }}
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-[26rem] overflow-y-auto scrollbar-thin">
          {query.data?.results.length ? (
            query.data.results.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => markRead(n)}
                className={cn("flex w-full gap-3 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-surface-2", !n.is_read && "bg-primary-soft/40")}
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.is_read ? "bg-transparent" : "bg-primary")} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-snug">{n.title}</span>
                  {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                  <span className="mt-1 block text-[11px] text-muted">{relativeTime(n.created_at)}</span>
                </span>
              </button>
            ))
          ) : (
            <p className="px-4 py-10 text-center text-[13px] text-muted">{query.isLoading ? "Loading…" : "You're all caught up."}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function UserMenu({ portal = false }: { portal?: boolean }) {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-md p-1 hover:bg-subtle" aria-label="Account menu">
          <Avatar name={user.full_name} size={28} />
          <ChevronDown className="hidden size-3.5 text-muted sm:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-medium text-fg">{user.full_name}</span>
          <span className="block truncate font-normal">{user.email}</span>
          {session.membership && <span className="mt-1 block font-normal">{session.membership.role_label}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!portal && (
          <DropdownMenuItem onSelect={() => navigate("/settings?tab=profile")}>
            <User /> Profile & preferences
          </DropdownMenuItem>
        )}
        {portal && (
          <DropdownMenuItem onSelect={() => navigate("/portal/account")}>
            <Settings /> Account settings
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggle(); }}>
          {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await api.post("/auth/logout/");
            queryClient.clear();
            queryClient.setQueryData(SESSION_KEY, null);
            navigate("/login");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceSwitcher({ dark = false }: { dark?: boolean }) {
  const { session, org } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = React.useState(false);
  const switchTo = async (id: number) => {
    try {
      const next = await api.post<Session>("/auth/switch-workspace/", { organization_id: id });
      queryClient.clear();
      queryClient.setQueryData(SESSION_KEY, next);
      navigate(next.permissions?.is_client ? "/portal" : "/");
      toast.success(`Switched to ${next.organization?.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
              dark ? "hover:bg-sidebar-active" : "hover:bg-subtle",
            )}
            aria-label="Switch workspace"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white" style={{ backgroundColor: org.brand_color }}>
              {org.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13px] font-semibold", dark ? "text-white" : "text-fg")}>{org.name}</span>
              <span className={cn("block truncate text-[11px]", dark ? "text-sidebar-muted" : "text-muted")}>{session.membership?.role_label}</span>
            </span>
            <ChevronDown className={cn("size-3.5", dark ? "text-sidebar-muted" : "text-muted")} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {session.workspaces.map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => w.id !== org.id && switchTo(w.id)}>
              <Building2 />
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === org.id && <Check className="!text-primary" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Building2 /> Create a workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          className="space-y-4 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const next = await api.post<Session>("/auth/workspaces/", { name });
              queryClient.clear();
              queryClient.setQueryData(SESSION_KEY, next);
              onOpenChange(false);
              navigate("/");
              toast.success("Workspace created");
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 className="text-base font-semibold">Create a workspace</h2>
          <p className="text-[13px] text-muted">Workspaces keep clients, projects and billing completely separate.</p>
          <input
            className="h-9 w-full rounded-md border border-border bg-surface px-3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            aria-label="Workspace name"
            required
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SEARCH_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  project: FolderKanban,
  task: ListChecks,
  client: Users,
  lead: Target,
  document: FileText,
  invoice: Receipt,
};

interface SearchResult {
  type: string;
  id: number;
  title: string;
  subtitle: string;
  link: string;
}

export function CommandSearch() {
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState("");
  const [active, setActive] = React.useState(0);
  const debounced = useDebounced(term, 200);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<{ results: SearchResult[] }>(`/search/?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.trim().length >= 2,
  });
  const results = query.data?.results ?? [];
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  React.useEffect(() => setActive(0), [debounced]);
  const go = (r: SearchResult) => {
    setOpen(false);
    setTerm("");
    navigate(r.link);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-[13px] text-muted hover:border-border-strong"
        aria-label="Search"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search projects, tasks, clients…</span>
        <span className="hidden sm:inline-flex">
          <Kbd>⌘K</Kbd>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="top-[12vh] overflow-hidden" aria-describedby={undefined}>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 text-muted" />
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === "Enter" && results[active]) go(results[active]);
              }}
              placeholder="Search by name, code (e.g. ACME-001-4) or invoice number"
              className="h-12 flex-1 bg-transparent text-sm outline-none"
              aria-label="Search everything"
            />
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-2 scrollbar-thin" role="listbox">
            {debounced.trim().length < 2 ? (
              <p className="px-3 py-8 text-center text-[13px] text-muted">Type at least two characters.</p>
            ) : query.isLoading ? (
              <p className="px-3 py-8 text-center text-[13px] text-muted">Searching…</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-muted">No matches for “{debounced}”.</p>
            ) : (
              results.map((r, i) => {
                const Icon = SEARCH_ICONS[r.type] ?? Search;
                return (
                  <button
                    key={`${r.type}-${r.id}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left", i === active && "bg-subtle")}
                  >
                    <Icon className="size-4 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{r.title}</span>
                      <span className="block truncate text-xs text-muted">{r.subtitle}</span>
                    </span>
                    <span className="text-[11px] capitalize text-muted">{r.type}</span>
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
