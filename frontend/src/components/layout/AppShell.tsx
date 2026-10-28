import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BarChart3,
  CalendarDays,
  Clock,
  FileSignature,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Menu,
  Radar,
  Receipt,
  Settings,
  Target,
  Timer,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Button } from "@/components/ui/button";
import { TaskDrawer } from "@/features/tasks/TaskDrawer";
import { useAuth } from "@/hooks/session";
import { TimerProvider } from "@/hooks/timer";
import type { Permissions } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TimerWidget } from "./TimerWidget";
import { CommandSearch, NotificationsBell, UserMenu, WorkspaceSwitcher } from "./TopbarWidgets";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  allow?: (p: Permissions) => boolean;
}

const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: "/", label: "Overview", icon: LayoutDashboard, end: true }] },
  {
    section: "Work",
    items: [
      { to: "/projects", label: "Projects", icon: FolderKanban },
      { to: "/tasks", label: "Tasks", icon: ListChecks },
      { to: "/calendar", label: "Calendar", icon: CalendarDays },
    ],
  },
  {
    section: "Time",
    items: [
      { to: "/time", label: "Time Tracking", icon: Timer },
      { to: "/timesheets", label: "Timesheets", icon: Clock },
    ],
  },
  {
    section: "Clients",
    items: [
      { to: "/crm", label: "CRM", icon: Target, allow: (p) => p.is_manager },
      { to: "/clients", label: "Clients", icon: Users, allow: (p) => p.is_manager },
      { to: "/documents", label: "Documents & Contracts", icon: FileSignature, allow: (p) => p.is_manager },
    ],
  },
  {
    section: "Finance",
    items: [
      { to: "/invoices", label: "Invoices", icon: Receipt, allow: (p) => p.billing },
      { to: "/expenses", label: "Expenses", icon: Wallet },
      { to: "/reports", label: "Reports", icon: BarChart3, allow: (p) => p.reports },
      { to: "/revenue-radar", label: "Revenue Leak Radar", icon: Radar, allow: (p) => p.reports },
    ],
  },
  {
    section: "Workspace",
    items: [
      { to: "/team", label: "Team", icon: UsersRound },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { permissions, org } = useAuth();
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg">
      <div className="flex h-14 items-center gap-2 px-4">
        <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
          <rect width="32" height="32" rx="7" fill="#4F46E5" />
          <path d="M9 16a7 7 0 1 1 14 0a7 7 0 1 1-14 0Zm4 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z" fill="#fff" />
          <path d="M21.5 9.5 25 6" stroke="#A5B4FC" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <span className="text-[15px] font-semibold tracking-tight text-white">OmniManager</span>
      </div>
      <div className="px-3 pb-2">
        <WorkspaceSwitcher dark />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2 scrollbar-thin" aria-label="Main navigation">
        {NAV.map((group, gi) => {
          const items = group.items.filter((i) => !i.allow || i.allow(permissions));
          if (!items.length) return null;
          return (
            <div key={gi}>
              {group.section && <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">{group.section}</p>}
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors",
                          isActive ? "bg-sidebar-active text-white" : "text-sidebar-fg/85 hover:bg-sidebar-active hover:text-white",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon className={cn("size-4", isActive ? "text-indigo-300" : "text-sidebar-muted")} />
                          {item.label}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {org.is_demo && (
        <div className="m-3 rounded-md border border-sidebar-border px-3 py-2 text-[11px] leading-relaxed text-sidebar-muted">
          Demo workspace · sample data created by the seed command.
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const location = useLocation();
  React.useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <TimerProvider>
      <div className="flex h-full">
        <aside className="hidden w-60 shrink-0 border-r border-sidebar-border lg:block">
          <SidebarContent />
        </aside>
        <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden" />
            <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-64 lg:hidden" aria-describedby={undefined}>
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:gap-3 sm:px-5">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            <div className="hidden flex-1 sm:block">
              <CommandSearch />
            </div>
            <div className="flex-1 sm:hidden" />
            <TimerWidget />
            <NotificationsBell />
            <UserMenu />
          </header>
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <TaskDrawer />
    </TimerProvider>
  );
}
