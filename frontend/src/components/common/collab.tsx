import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, EyeOff, FileText, Paperclip, Send, Trash2, Upload } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox, Textarea } from "@/components/ui/input";
import { Avatar, Badge } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import { useAuth } from "@/hooks/session";
import { api, errorMessage } from "@/lib/api";
import { fileSize, formatDateTime, relativeTime } from "@/lib/format";
import type { Activity, Attachment, Comment } from "@/lib/types";
import { cn } from "@/lib/utils";

import { EmptyState, LoadingRows } from "./layout-bits";

const VERBS: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  changed_status: "changed status of",
  reassigned: "reassigned",
  commented: "commented on",
  uploaded_file: "uploaded a file to",
  added_member: "added a member to",
  removed_member: "removed a member from",
  submitted_time: "submitted time on",
  approved_time: "approved time on",
  rejected_time: "rejected time on",
  reopened_time: "reopened approved time on",
  completed_project: "completed",
  reopened_project: "reopened",
  completed_milestone: "completed milestone",
  reopened_milestone: "reopened milestone",
  submitted_deliverable: "submitted for approval",
  approved_deliverable: "approved",
  requested_revisions: "requested revisions on",
  withdrew_deliverable: "withdrew",
  sent_change_request: "sent change request",
  applied_change_request: "applied change request",
  change_request_approved: "approved change request",
  change_request_rejected: "rejected change request",
  generated_invoice: "generated invoice",
  created_invoice: "created invoice",
  sent_invoice: "sent invoice",
  voided_invoice: "voided invoice",
  recorded_payment: "recorded a payment on",
  reversed_payment: "reversed a payment on",
  issued_credit_note: "issued a credit note on",
  started_checkout: "started an online payment for",
  payment_failed: "payment failed for",
  viewed_invoice: "viewed invoice",
  sent_document: "sent",
  signed_document: "signed",
  declined_document: "declined",
  revised_document: "revised",
  created_document: "created",
  converted_lead: "converted lead",
  moved_lead: "moved lead",
  budget_threshold: "budget alert on",
  submitted_expense: "submitted expense",
  approved_expense: "approved expense",
  rejected_expense: "rejected expense",
  client_commented: "commented on",
  client_uploaded_file: "uploaded a file to",
  archived: "archived",
  restored: "restored",
  invited_member: "invited",
  joined_workspace: "joined the workspace",
  generated_recurring_invoice: "generated recurring invoice",
};

export function activityText(a: Pick<Activity, "verb" | "target_label" | "metadata">): string {
  const verb = VERBS[a.verb] ?? a.verb.replace(/_/g, " ");
  if (a.verb === "changed_status" && a.metadata?.to_status) {
    return `moved ${a.target_label} to ${String(a.metadata.to_status).replace(/_/g, " ")}`;
  }
  if (a.verb === "joined_workspace") return verb;
  return `${verb} ${a.target_label}`;
}

export function ActivityList({ items, empty = "No activity yet." }: { items: { id: number; actor: string | null; verb: string; target_label: string; created_at: string; metadata?: Record<string, unknown> }[]; empty?: string }) {
  if (!items.length) return <EmptyState compact title={empty} />;
  return (
    <ol className="space-y-3">
      {items.map((a) => (
        <li key={a.id} className="flex gap-3">
          <Avatar name={a.actor ?? "System"} size={24} className="mt-0.5" />
          <div className="min-w-0 text-[13px] leading-snug">
            <span className="font-medium">{a.actor ?? "System"}</span>{" "}
            <span className="text-muted">{activityText({ verb: a.verb, target_label: a.target_label, metadata: a.metadata ?? {} })}</span>
            <div className="mt-0.5 text-[11px] text-muted" title={formatDateTime(a.created_at)}>
              {relativeTime(a.created_at)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ActivityFeed({ params }: { params: string }) {
  const query = useQuery({ queryKey: ["activity", params], queryFn: () => api.get<Activity[]>(`/activity/?${params}`) });
  if (query.isLoading) return <LoadingRows rows={4} />;
  return (
    <ActivityList
      items={(query.data ?? []).map((a) => ({ id: a.id, actor: a.actor?.full_name ?? null, verb: a.verb, target_label: a.target_label, created_at: a.created_at, metadata: a.metadata }))}
    />
  );
}

export function CommentsThread({ target, allowClientShare = false }: { target: string; allowClientShare?: boolean }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const key = ["comments", target];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Comment[]>(`/comments/?target=${target}`) });
  const [body, setBody] = React.useState("");
  const [share, setShare] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post("/comments/", { target, body, client_visible: share });
      setBody("");
      setShare(false);
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      {query.isLoading ? (
        <LoadingRows rows={2} />
      ) : query.data?.length ? (
        <ul className="space-y-4">
          {query.data.map((c) => (
            <li key={c.id} className="flex gap-3">
              <Avatar name={c.author?.full_name ?? "Former user"} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium">{c.author?.full_name ?? "Former user"}</span>
                  {c.author_is_client && <Badge tone="info">Client</Badge>}
                  {c.client_visible && !c.author_is_client && <Badge tone="primary">Shared with client</Badge>}
                  <span className="text-xs text-muted" title={formatDateTime(c.created_at)}>{relativeTime(c.created_at)}</span>
                  {c.author?.id === user.id && (
                    <button
                      type="button"
                      className="ml-auto text-xs text-muted hover:text-danger"
                      onClick={async () => {
                        await api.delete(`/comments/${c.id}/`);
                        queryClient.invalidateQueries({ queryKey: key });
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No comments yet. Start the discussion.</p>
      )}
      <div className="rounded-lg border border-border bg-surface p-2 focus-within:border-primary">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Write a comment… (⌘/Ctrl + Enter to send)"
          className="border-0 shadow-none focus-visible:ring-0"
          aria-label="Comment"
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          {allowClientShare ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              <Checkbox checked={share} onChange={(e) => setShare(e.target.checked)} /> Visible to client
            </label>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={submit} loading={busy} disabled={!body.trim()}>
            <Send /> Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AttachmentsPanel({ target, allowClientShare = false, canManage = false }: { target: string; allowClientShare?: boolean; canManage?: boolean }) {
  const queryClient = useQueryClient();
  const key = ["files", target];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Attachment[]>(`/files/?target=${target}`) });
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const { user } = useAuth();
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("target", target);
        form.append("file", file);
        await api.post("/files/", form);
      }
      toast.success(files.length > 1 ? `${files.length} files uploaded` : "File uploaded");
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
        className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-4 py-6 text-center transition-colors", dragging && "border-primary bg-primary-soft")}
      >
        <Upload className="mb-2 size-5 text-muted" />
        <p className="text-[13px]">Drag files here or</p>
        <Button variant="link" size="sm" onClick={() => inputRef.current?.click()} loading={busy}>
          browse to upload
        </Button>
        <p className="text-xs text-muted">PDF, images, Office documents, ZIP · up to 15 MB</p>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} aria-label="Upload files" />
      </div>
      {query.isLoading ? (
        <LoadingRows rows={2} />
      ) : query.data?.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {query.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{f.original_name}</p>
                <p className="text-xs text-muted">
                  {fileSize(f.size)} · {f.uploaded_by?.full_name ?? "—"} · {relativeTime(f.created_at)}
                </p>
              </div>
              {f.client_visible && <Badge tone="primary">Shared</Badge>}
              {allowClientShare && canManage && (
                <Tooltip content={f.client_visible ? "Hide from client" : "Share with client"}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={f.client_visible ? "Hide from client" : "Share with client"}
                    onClick={async () => {
                      try {
                        await api.patch(`/files/${f.id}/`, { client_visible: !f.client_visible });
                        queryClient.invalidateQueries({ queryKey: key });
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    {f.client_visible ? <EyeOff /> : <Eye />}
                  </Button>
                </Tooltip>
              )}
              <Button variant="ghost" size="icon-sm" asChild aria-label={`Download ${f.original_name}`}>
                <a href={f.download_url}>
                  <Download />
                </a>
              </Button>
              {(canManage || f.uploaded_by?.id === user.id) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${f.original_name}`}
                  onClick={async () => {
                    await api.delete(`/files/${f.id}/`);
                    queryClient.invalidateQueries({ queryKey: key });
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Paperclip className="size-4" /> No files yet.
        </p>
      )}
    </div>
  );
}
