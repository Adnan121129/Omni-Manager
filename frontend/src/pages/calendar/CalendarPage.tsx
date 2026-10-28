import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";

import { PageHeader } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { isoDate } from "@/lib/format";
import { cn } from "@/lib/utils";

interface CalendarEvent {
  id: string;
  type: "task" | "milestone" | "deadline" | "invoice" | "follow_up" | "document";
  date: string;
  title: string;
  subtitle: string;
  status: string;
  color: string;
  link: string;
  done: boolean;
}

const TYPE_LABEL: Record<CalendarEvent["type"], string> = {
  task: "Task due",
  milestone: "Milestone",
  deadline: "Project deadline",
  invoice: "Invoice due",
  follow_up: "Lead follow-up",
  document: "Document expiry",
};

function monthGrid(anchor: Date, weekStart: number) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() - ((weekStart + 1) % 7) + 7) % 7; // weekStart: 0 = Monday
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function CalendarPage() {
  const [anchor, setAnchor] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [types, setTypes] = React.useState<Set<string>>(new Set(Object.keys(TYPE_LABEL)));
  const days = monthGrid(anchor, 0);
  const start = isoDate(days[0]);
  const end = isoDate(days[days.length - 1]);
  const query = useQuery({ queryKey: ["calendar", start, end], queryFn: () => api.get<CalendarEvent[]>(`/calendar/?start=${start}&end=${end}`) });
  const byDay = React.useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const e of query.data ?? []) if (types.has(e.type)) (map[e.date] ??= []).push(e);
    return map;
  }, [query.data, types]);
  const today = isoDate(new Date());
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const presentTypes = new Set((query.data ?? []).map((e) => e.type));

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Task due dates, milestones, deadlines, invoices and follow-ups."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}><ChevronLeft /></Button>
            <Button variant="outline" onClick={() => setAnchor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</Button>
            <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}><ChevronRight /></Button>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TYPE_LABEL) as CalendarEvent["type"][]).filter((t) => presentTypes.has(t) || types.has(t)).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={types.has(t)}
              onClick={() => setTypes((prev) => { const next = new Set(prev); if (next.has(t)) next.delete(t); else next.add(t); return next; })}
              className={cn("rounded-md border px-2 py-1 text-xs font-medium", types.has(t) ? "border-primary/30 bg-primary-soft text-primary" : "border-border text-muted")}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border bg-surface-2 text-center text-xs font-medium text-muted">
          {weekdays.map((d) => <div key={d} className="py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const key = isoDate(d);
            const inMonth = d.getMonth() === anchor.getMonth();
            const events = byDay[key] ?? [];
            return (
              <div key={key} className={cn("min-h-[7.5rem] border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0", !inMonth && "bg-surface-2/60")}>
                <div className={cn("mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular", key === today ? "bg-primary font-semibold text-primary-fg" : inMonth ? "text-fg" : "text-muted/60")}>
                  {d.getDate()}
                </div>
                <ul className="space-y-1">
                  {events.slice(0, 4).map((e) => (
                    <li key={e.id}>
                      <Link
                        to={e.link}
                        title={`${TYPE_LABEL[e.type]}: ${e.title} — ${e.subtitle}`}
                        className={cn("flex items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-[11px] font-medium hover:brightness-95", e.done && "line-through opacity-60")}
                        style={{ backgroundColor: `${e.color}1a`, color: e.color }}
                      >
                        {e.type === "milestone" ? "◆" : e.type === "deadline" ? "⚑" : "•"} <span className="truncate">{e.title}</span>
                      </Link>
                    </li>
                  ))}
                  {events.length > 4 && <li className="px-1.5 text-[11px] text-muted">+{events.length - 4} more</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
