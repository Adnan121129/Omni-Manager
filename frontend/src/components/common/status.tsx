import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUp, Minus } from "lucide-react";

import { Badge, type Tone } from "@/components/ui/primitives";
import { titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

type StatusMap = Record<string, { label: string; tone: Tone }>;

const MAPS: Record<string, StatusMap> = {
  project: {
    planning: { label: "Planning", tone: "neutral" },
    active: { label: "Active", tone: "primary" },
    on_hold: { label: "On hold", tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  },
  task: {
    todo: { label: "To do", tone: "neutral" },
    in_progress: { label: "In progress", tone: "primary" },
    in_review: { label: "In review", tone: "info" },
    done: { label: "Done", tone: "success" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  },
  entry: {
    draft: { label: "Draft", tone: "neutral" },
    submitted: { label: "Submitted", tone: "info" },
    approved: { label: "Approved", tone: "success" },
    rejected: { label: "Rejected", tone: "danger" },
    running: { label: "Running", tone: "primary" },
    invoiced: { label: "Invoiced", tone: "primary" },
  },
  invoice: {
    draft: { label: "Draft", tone: "neutral" },
    sent: { label: "Sent", tone: "info" },
    partially_paid: { label: "Partially paid", tone: "warning" },
    paid: { label: "Paid", tone: "success" },
    credited: { label: "Credited", tone: "neutral" },
    void: { label: "Void", tone: "neutral" },
    overdue: { label: "Overdue", tone: "danger" },
  },
  document: {
    draft: { label: "Draft", tone: "neutral" },
    sent: { label: "Sent", tone: "info" },
    viewed: { label: "Viewed", tone: "primary" },
    signed: { label: "Signed", tone: "success" },
    declined: { label: "Declined", tone: "danger" },
    expired: { label: "Expired", tone: "warning" },
  },
  deliverable: {
    draft: { label: "Draft", tone: "neutral" },
    pending_approval: { label: "Awaiting client", tone: "warning" },
    approved: { label: "Approved", tone: "success" },
    changes_requested: { label: "Revisions requested", tone: "danger" },
  },
  change: {
    draft: { label: "Draft", tone: "neutral" },
    pending_client: { label: "Awaiting client", tone: "warning" },
    approved: { label: "Approved", tone: "success" },
    rejected: { label: "Rejected", tone: "danger" },
    applied: { label: "Applied", tone: "primary" },
  },
  lead: {
    new: { label: "New inquiry", tone: "neutral" },
    contacted: { label: "Contacted", tone: "info" },
    qualified: { label: "Qualified", tone: "primary" },
    proposal: { label: "Proposal sent", tone: "warning" },
    won: { label: "Won", tone: "success" },
    lost: { label: "Lost", tone: "neutral" },
  },
  health: {
    healthy: { label: "Healthy", tone: "success" },
    at_risk: { label: "At risk", tone: "warning" },
    critical: { label: "Critical", tone: "danger" },
    closed: { label: "Closed", tone: "neutral" },
  },
  milestone: {
    pending: { label: "Pending", tone: "neutral" },
    in_progress: { label: "In progress", tone: "primary" },
    completed: { label: "Completed", tone: "success" },
  },
  client: {
    active: { label: "Active", tone: "success" },
    inactive: { label: "Inactive", tone: "neutral" },
    archived: { label: "Archived", tone: "neutral" },
  },
  checkout: {
    open: { label: "Open", tone: "neutral" },
    pending: { label: "Processing", tone: "info" },
    succeeded: { label: "Succeeded", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    canceled: { label: "Canceled", tone: "neutral" },
    expired: { label: "Expired", tone: "neutral" },
  },
};

export type StatusKind = keyof typeof MAPS;

export function statusLabel(kind: StatusKind, status: string): string {
  return MAPS[kind]?.[status]?.label ?? titleCase(status);
}

export function StatusBadge({ kind, status, className }: { kind: StatusKind; status: string; className?: string }) {
  const entry = MAPS[kind]?.[status] ?? { label: titleCase(status), tone: "neutral" as Tone };
  return (
    <Badge tone={entry.tone} dot className={className}>
      {entry.label}
    </Badge>
  );
}

export const PRIORITY_META: Record<string, { label: string; className: string; icon: typeof ArrowUp }> = {
  low: { label: "Low", className: "text-muted", icon: ArrowDown },
  medium: { label: "Medium", className: "text-info", icon: Minus },
  high: { label: "High", className: "text-warning", icon: ArrowUp },
  urgent: { label: "Urgent", className: "text-danger", icon: ChevronsUp },
};

export function PriorityIndicator({ priority, showLabel = true }: { priority: string; showLabel?: boolean }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.medium;
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.className)} title={`${meta.label} priority`}>
      <Icon className="size-3.5" aria-hidden />
      {showLabel && meta.label}
    </span>
  );
}

export function HealthDot({ status }: { status: string }) {
  const color = { healthy: "bg-success", at_risk: "bg-warning", critical: "bg-danger", closed: "bg-border-strong" }[status] ?? "bg-border-strong";
  return <span className={cn("inline-block size-2 rounded-full", color)} aria-label={statusLabel("health", status)} />;
}

export function OverdueFlag({ label = "Overdue" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
      <AlertTriangle className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
