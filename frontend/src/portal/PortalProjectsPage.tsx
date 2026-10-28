import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleDot, Download, FileText, FolderKanban, Mail, MessageSquare, Paperclip, Upload } from "lucide-react";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ActivityList } from "@/components/common/collab";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Card, CardContent, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/api";
import { fileSize, formatDate, formatHours, formatMoney, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { DueText } from "./PortalHomePage";
import {
  changeRequestDecision,
  type DecisionConfig,
  DecisionDialog,
  deliverableDecision,
  PORTAL_KEYS,
  PortalComments,
  type PortalChangeRequest,
  type PortalDeliverable,
  type PortalProgress,
  type PortalProjectDetail,
  type PortalProjectSummary,
  useInvalidatePortal,
} from "./portalApi";

function progressText(p: PortalProgress) {
  if (p.basis === "tasks") return `${p.tasks_done} of ${p.tasks_total} tasks complete`;
  if (p.basis === "milestones") return `${p.milestones_done} of ${p.milestones_total} milestones complete`;
  return "No tracked work items yet";
}

export function PortalProjectsPage() {
  const query = useQuery({ queryKey: PORTAL_KEYS.projects, queryFn: () => api.get<PortalProjectSummary[]>("/portal/projects/") });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <>
      <PageHeader title="Projects" description="Projects your agency has shared with you, with live progress." />
      {query.data.length === 0 ? (
        <Card><EmptyState icon={FolderKanban} title="No shared projects yet" description="Projects appear here once the team shares them with you." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {query.data.map((p) => (
            <Link key={p.id} to={`/portal/projects/${p.id}`} className="block rounded-lg focus-visible:outline-2">
              <Card className="h-full p-5 transition-colors hover:border-border-strong">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted">{p.code}</p>
                    <p className="mt-0.5 truncate text-[15px] font-semibold">{p.name}</p>
                  </div>
                  <StatusBadge kind="project" status={p.status} />
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <ProgressBar value={p.progress.percent} tone={p.progress.percent >= 100 ? "success" : "primary"} label={`${p.name} progress`} />
                  <span className="text-[13px] font-semibold tabular">{p.progress.percent}%</span>
                </div>
                <p className="mt-1.5 text-xs text-muted">{progressText(p.progress)}</p>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {p.manager && <span>Project manager: {p.manager.name}</span>}
                  {p.completed_at ? <span>Completed {formatDate(p.completed_at)}</span> : p.deadline && <DueText date={p.deadline} prefix="Deadline" />}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function MilestoneIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 className="size-4 text-success" />;
  if (status === "in_progress") return <CircleDot className="size-4 text-primary" />;
  return <Circle className="size-4 text-muted" />;
}

function DeliverableCard({ d, highlighted, onDecide }: { d: PortalDeliverable; highlighted: boolean; onDecide: (c: DecisionConfig) => void }) {
  const [discuss, setDiscuss] = React.useState(highlighted);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  return (
    <div ref={ref}>
      <Card className={cn("p-4", highlighted && "ring-2 ring-primary")} data-testid={`deliverable-${d.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">{d.title}</p>
            <p className="mt-0.5 text-xs text-muted">
              {d.milestone ? `${d.milestone} · ` : ""}Revision {d.revision}
              {d.submitted_at && ` · submitted ${relativeTime(d.submitted_at)}`}
              {d.due_date && <> · <DueText date={d.due_date} /></>}
            </p>
          </div>
          <StatusBadge kind="deliverable" status={d.status} />
        </div>
        {d.description && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{d.description}</p>}
        {d.decision_comment && d.decided_at && (
          <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
            <span className="text-xs text-muted">Your feedback · {formatDate(d.decided_at)}</span>
            <span className="mt-0.5 block whitespace-pre-wrap">{d.decision_comment}</span>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {d.status === "pending_approval" && (
            <>
              <Button size="sm" variant="success" onClick={() => onDecide(deliverableDecision.approve(d))}>Approve</Button>
              <Button size="sm" variant="outline" onClick={() => onDecide(deliverableDecision.requestChanges(d))}>Request changes</Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDiscuss((v) => !v)} aria-expanded={discuss}>
            <MessageSquare /> {discuss ? "Hide discussion" : "Discussion"}
          </Button>
        </div>
        {discuss && (
          <div className="mt-4 border-t border-border pt-4">
            <PortalComments target={`deliverable:${d.id}`} />
          </div>
        )}
      </Card>
    </div>
  );
}

function ChangeRequestCard({ c, onDecide }: { c: PortalChangeRequest; onDecide: (c: DecisionConfig) => void }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">{c.title}</p>
          <p className="mt-0.5 text-xs text-muted">{c.sent_at ? `Sent ${formatDate(c.sent_at)}` : ""}{c.decided_at ? ` · decided ${formatDate(c.decided_at)}` : ""}</p>
        </div>
        <StatusBadge kind="change" status={c.status} />
      </div>
      {c.description && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{c.description}</p>}
      <dl className="mt-3 grid grid-cols-3 gap-3 rounded-md bg-surface-2 p-3 text-[13px]">
        <div><dt className="text-xs text-muted">Additional cost</dt><dd className="font-semibold tabular">{formatMoney(c.estimated_cost, c.currency)}</dd></div>
        <div><dt className="text-xs text-muted">Effort</dt><dd className="font-semibold tabular">{formatHours(c.estimated_hours)}</dd></div>
        <div><dt className="text-xs text-muted">Revised deadline</dt><dd className="font-semibold">{c.revised_deadline ? formatDate(c.revised_deadline) : "Unchanged"}</dd></div>
      </dl>
      {c.decision_comment && <p className="mt-2 text-[13px] text-muted">Your comment: {c.decision_comment}</p>}
      {c.status === "pending_client" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="success" onClick={() => onDecide(changeRequestDecision.approve(c))}>Approve</Button>
          <Button size="sm" variant="danger-outline" onClick={() => onDecide(changeRequestDecision.reject(c))}>Reject</Button>
        </div>
      )}
    </Card>
  );
}

function FilesPanel({ project }: { project: PortalProjectDetail }) {
  const invalidate = useInvalidatePortal();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        await api.post(`/portal/projects/${project.id}/files/`, form);
      }
      toast.success(files.length > 1 ? `${files.length} files shared with the team` : "File shared with the team");
      invalidate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Files</CardTitle>
          <p className="mt-1 text-[13px] text-muted">Files the team shared with you, and files you've uploaded.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} loading={busy}>
          <Upload /> Upload
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} aria-label="Upload files" />
      </CardHeader>
      {project.files.length ? (
        <ul className="divide-y divide-border border-t border-border">
          {project.files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
              <FileText className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{f.name}</p>
                <p className="text-xs text-muted">{fileSize(f.size)} · {f.uploaded_by ?? "—"} · {relativeTime(f.created_at)}{f.attached_to !== "project" ? ` · on a ${f.attached_to === "changerequest" ? "change request" : f.attached_to}` : ""}</p>
              </div>
              <Button variant="ghost" size="icon-sm" asChild aria-label={`Download ${f.name}`}>
                <a href={f.download_url}><Download /></a>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Paperclip} title="No files yet" description="PDF, images, Office documents and ZIP files up to 15 MB." />
      )}
    </Card>
  );
}

const TABS = ["overview", "deliverables", "changes", "files", "discussion"] as const;

export function PortalProjectDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const highlightDeliverable = Number(params.get("deliverable")) || null;
  const rawTab = params.get("tab") ?? (highlightDeliverable ? "deliverables" : "overview");
  const tab = (TABS as readonly string[]).includes(rawTab) ? rawTab : "overview";
  const [decision, setDecision] = React.useState<DecisionConfig | null>(null);
  const query = useQuery({ queryKey: PORTAL_KEYS.project(id), queryFn: () => api.get<PortalProjectDetail>(`/portal/projects/${id}/`) });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const p = query.data;
  const pendingDeliverables = p.deliverables.filter((d) => d.status === "pending_approval").length;
  const pendingChanges = p.change_requests.filter((c) => c.status === "pending_client").length;
  return (
    <>
      <PageHeader
        back={{ to: "/portal/projects", label: "Projects" }}
        title={p.name}
        meta={<><span className="text-xs text-muted">{p.code}</span><StatusBadge kind="project" status={p.status} /></>}
        actions={p.manager && (
          <Button variant="outline" asChild>
            <a href={`mailto:${p.manager.email}?subject=${encodeURIComponent(`${p.code} · ${p.name}`)}`}><Mail /> Email {p.manager.name.split(" ")[0]}</a>
          </Button>
        )}
      />
      <Card className="mb-6 p-5">
        <div className="grid gap-5 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <p className="text-[13px] text-muted">Progress</p>
            <div className="mt-2 flex items-center gap-3">
              <ProgressBar value={p.progress.percent} tone={p.progress.percent >= 100 ? "success" : "primary"} className="h-2" label="Project progress" />
              <span className="text-lg font-semibold tabular">{p.progress.percent}%</span>
            </div>
            <p className="mt-1 text-xs text-muted">{progressText(p.progress)}</p>
          </div>
          <div>
            <p className="text-[13px] text-muted">Timeline</p>
            <p className="mt-2 text-[13px] font-medium">{formatDate(p.start_date)} → {p.completed_at ? formatDate(p.completed_at) : formatDate(p.deadline)}</p>
            {!p.completed_at && p.deadline && <p className="text-xs text-muted"><DueText date={p.deadline} prefix="Deadline" /></p>}
          </div>
          <div>
            <p className="text-[13px] text-muted">Project manager</p>
            <p className="mt-2 text-[13px] font-medium">{p.manager?.name ?? "—"}</p>
            {p.manager && <a href={`mailto:${p.manager.email}`} className="text-xs text-muted hover:underline">{p.manager.email}</a>}
          </div>
        </div>
        {p.description && <p className="mt-4 whitespace-pre-wrap border-t border-border pt-4 text-[13px] leading-relaxed text-muted">{p.description}</p>}
      </Card>
      <Tabs value={tab} onValueChange={(v) => setParams((prev) => { const n = new URLSearchParams(prev); n.set("tab", v); n.delete("deliverable"); return n; }, { replace: true })}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="deliverables">Deliverables{pendingDeliverables ? ` · ${pendingDeliverables}` : ""}</TabsTrigger>
          <TabsTrigger value="changes">Change requests{pendingChanges ? ` · ${pendingChanges}` : ""}</TabsTrigger>
          <TabsTrigger value="files">Files · {p.files.length}</TabsTrigger>
          <TabsTrigger value="discussion">Discussion</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>Milestones</CardTitle></CardHeader>
              {p.milestones.length ? (
                <ol className="space-y-0 px-5 pb-4">
                  {p.milestones.map((m, i) => (
                    <li key={m.id} className="relative flex gap-3 pb-4 last:pb-0">
                      {i < p.milestones.length - 1 && <span className="absolute left-[7px] top-5 h-full w-px bg-border" aria-hidden />}
                      <span className="relative mt-0.5 bg-surface"><MilestoneIcon status={m.status} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[13px] font-medium">{m.name}</p>
                          <span className="text-xs text-muted">
                            {m.completed_at ? `Completed ${formatDate(m.completed_at)}` : m.due_date ? <DueText date={m.due_date} /> : "No date"}
                          </span>
                        </div>
                        {m.description && <p className="mt-0.5 text-xs text-muted">{m.description}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState compact title="No milestones shared yet" />
              )}
            </Card>
            <Card>
              <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
              <CardContent><ActivityList items={p.activity} empty="No shared activity yet." /></CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="deliverables" className="space-y-3">
          {p.deliverables.length ? (
            p.deliverables.map((d) => <DeliverableCard key={d.id} d={d} highlighted={d.id === highlightDeliverable} onDecide={setDecision} />)
          ) : (
            <Card><EmptyState title="No deliverables yet" description="When the team submits work for your review, it appears here." /></Card>
          )}
        </TabsContent>
        <TabsContent value="changes" className="space-y-3">
          {p.change_requests.length ? (
            p.change_requests.map((c) => <ChangeRequestCard key={c.id} c={c} onDecide={setDecision} />)
          ) : (
            <Card><EmptyState title="No change requests" description="Changes to scope, cost or timeline are proposed here for your approval." /></Card>
          )}
        </TabsContent>
        <TabsContent value="files"><FilesPanel project={p} /></TabsContent>
        <TabsContent value="discussion">
          <Card>
            <CardHeader><CardTitle>Discussion with {p.manager?.name ?? "the team"}</CardTitle></CardHeader>
            <CardContent><PortalComments target={`project:${p.id}`} /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <DecisionDialog config={decision} onClose={() => setDecision(null)} />
    </>
  );
}
