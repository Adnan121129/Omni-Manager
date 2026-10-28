import { CheckSquare, FileSignature, FolderKanban, LayoutDashboard, Receipt } from "lucide-react";
import * as React from "react";
import { NavLink, Outlet } from "react-router";

import { NotificationsBell, UserMenu } from "@/components/layout/TopbarWidgets";
import { useAuth } from "@/hooks/session";
import { cn } from "@/lib/utils";

import { usePortalSummary } from "./portalApi";

const NAV = [
  { to: "/portal", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/portal/approvals", label: "Approvals", icon: CheckSquare },
  { to: "/portal/projects", label: "Projects", icon: FolderKanban },
  { to: "/portal/documents", label: "Documents", icon: FileSignature },
  { to: "/portal/invoices", label: "Invoices", icon: Receipt },
];

function OrgMark() {
  const { org } = useAuth();
  const [logoFailed, setLogoFailed] = React.useState(false);
  if (org.has_logo && !logoFailed) {
    return <img src="/api/workspace/logo/" alt={org.name} className="h-8 max-w-[140px] object-contain" onError={() => setLogoFailed(true)} />;
  }
  return (
    <span className="flex size-8 items-center justify-center rounded-md text-sm font-bold text-white" style={{ backgroundColor: org.brand_color }} aria-hidden>
      {org.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Branded top-navigation layout for client contacts. */
export function PortalShell() {
  const { org, session } = useAuth();
  const summary = usePortalSummary();
  const pending = summary.data?.approvals.length ?? 0;
  const clientName = session.membership?.client?.name;
  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-surface/95 backdrop-blur" style={{ borderTop: `3px solid ${org.brand_color}` }}>
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <OrgMark />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold leading-tight">{org.name}</p>
            <p className="truncate text-[11px] leading-tight text-muted">Client portal{clientName ? ` · ${clientName}` : ""}</p>
          </div>
          <nav className="ml-6 hidden flex-1 items-center gap-1 md:flex" aria-label="Portal navigation">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                    isActive ? "bg-primary-soft text-primary" : "text-muted hover:bg-subtle hover:text-fg",
                  )
                }
              >
                {item.label}
                {item.label === "Approvals" && pending > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-white">{pending}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <NotificationsBell portal />
            <UserMenu portal />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-border px-2 py-1.5 scrollbar-thin md:hidden" aria-label="Portal navigation">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium",
                  isActive ? "bg-primary-soft text-primary" : "text-muted",
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
              {item.label === "Approvals" && pending > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-white">{pending}</span>
              )}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
          <Outlet />
        </div>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-8 pt-2 text-xs text-muted sm:px-6">
          {org.name}
          {org.email && (
            <>
              {" · "}Questions? <a className="hover:text-fg hover:underline" href={`mailto:${org.email}`}>{org.email}</a>
            </>
          )}
        </footer>
      </main>
    </div>
  );
}
