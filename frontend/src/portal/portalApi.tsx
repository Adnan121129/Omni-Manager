import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { LoadingRows } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/overlays";
import { Avatar } from "@/components/ui/primitives";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime, relativeTime, type MoneyAmount } from "@/lib/format";

export const PORTAL_KEYS = {
  summary: ["portal", "summary"] as const,
  projects: ["portal", "projects"] as const,
  project: (id: string | number) => ["portal", "project", String(id)] as const,
  documents: ["portal", "documents"] as const,
  document: (id: string | number) => ["portal", "document", String(id)] as const,
  invoices: ["portal", "invoices"] as const,
  invoice: (id: string | number) => ["portal", "invoice", String(id)] as const,
  payments: ["portal", "payments"] as const,
  comments: (target: string) => ["portal", "comments", target] as const,
};

/** Notification kinds a client contact can receive; used to trim the preferences list. */
export const CLIENT_NOTIFICATION_KINDS = [
  "document_awaiting_signature",
  "deliverable_submitted",
  "change_request_sent",
  "invoice_sent",
  "invoice_due_soon",
  "invoice_overdue",
  "payment_received",
  "payment_failed",
  "comment_added",
];

export interface PortalActivity {
  id: number;
  verb: string;
  target_type: string;
  target_label: string;
  actor: string | null;
  created_at: string;
  project_id: number | null;
}

export interface PortalApproval {
  type: "document" | "deliverable" | "change_request" | "invoice";
  id: number;
  title: string;
  status: string;
  status_label: string;
  project: string | null;
  due_date: string | null;
  action: string;
  link: string;
  amount?: string;
  currency?: string;
  description?: string;
  revision?: number;
  estimated_hours?: string;
}

export interface PortalSummary {
  client: { id: number; name: string };
  organization: { name: string; email: string; brand_color: string };
  approvals: PortalApproval[];
  projects: { id: number; code: string; name: string; status: string; deadline: string | null; progress: number; manager: string | null }[];
  outstanding: MoneyAmount[];
  activity: PortalActivity[];
}

export interface PortalProgress {
  percent: number;
  basis: "tasks" | "milestones" | "none";
  tasks_total: number;
  tasks_done: number;
  tasks_overdue: number;
  milestones_total: number;
  milestones_done: number;
  milestones_overdue: number;
}

export interface PortalProjectSummary {
  id: number;
  code: string;
  name: string;
  status: string;
  start_date: string | null;
  deadline: string | null;
  completed_at: string | null;
  progress: PortalProgress;
  manager: { name: string; email: string } | null;
}

export interface PortalDeliverable {
  id: number;
  title: string;
  description: string;
  status: string;
  status_label: string;
  due_date: string | null;
  revision: number;
  submitted_at: string | null;
  decided_at: string | null;
  decision_comment: string;
  project: { id: number; name: string; code: string };
  milestone: string | null;
}

export interface PortalChangeRequest {
  id: number;
  title: string;
  description: string;
  status: string;
  status_label: string;
  estimated_hours: string;
  estimated_cost: string;
  currency: string;
  revised_deadline: string | null;
  sent_at: string | null;
  decided_at: string | null;
  decision_comment: string;
  project: { id: number; name: string; code: string };
}

export interface PortalFile {
  id: number;
  name: string;
  size: number;
  created_at: string;
  uploaded_by: string | null;
  attached_to: string;
  download_url: string;
}

export interface PortalProjectDetail extends PortalProjectSummary {
  description: string;
  milestones: { id: number; name: string; description: string; due_date: string | null; status: string; completed_at: string | null }[];
  deliverables: PortalDeliverable[];
  change_requests: PortalChangeRequest[];
  files: PortalFile[];
  activity: PortalActivity[];
}

export interface PortalDocumentSummary {
  id: number;
  title: string;
  kind: string;
  status: string;
  status_label: string;
  sent_at: string | null;
  signed_at: string | null;
  expires_at: string | null;
  total_amount: string;
  currency: string;
  project: string | null;
  version: number;
}

export interface PortalDocument extends PortalDocumentSummary {
  html: string;
  content_hash: string | null;
  decline_reason: string;
  is_signer: boolean;
  consent_text: string;
  legal_notice: string;
  signature: {
    signer_name: string;
    signer_title: string;
    method: "drawn" | "typed";
    signature_image: string;
    signed_at: string;
    content_hash: string;
  } | null;
  organization: { name: string };
}

export interface PortalInvoiceSummary {
  id: number;
  number: string;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  currency: string;
  total: string;
  amount_paid: string;
  amount_due: string;
  can_pay: boolean;
}

export interface PortalInvoice extends PortalInvoiceSummary {
  payment_terms: string;
  notes: string;
  subtotal: string;
  discount_amount: string;
  tax_label: string;
  tax_rate: string;
  tax_amount: string;
  amount_credited: string;
  lines: { description: string; quantity: string; unit: string; unit_price: string; amount: string }[];
  payments: { id: number; amount: string; method: string; received_at: string; reference: string }[];
  credit_notes: { number: string; amount: string; created_at: string }[];
  organization: { name: string; address: string; email: string };
  allow_partial_payments: boolean;
  payment_provider: { name: string; label: string; test_mode: boolean; simulator: boolean; configured: boolean; problem: string };
}

export interface PortalPayment {
  id: number;
  invoice_id: number;
  invoice_number: string;
  amount: string;
  currency: string;
  method: string;
  received_at: string;
  reference: string;
}

export function usePortalSummary() {
  return useQuery({ queryKey: PORTAL_KEYS.summary, queryFn: () => api.get<PortalSummary>("/portal/summary/") });
}

/** Refreshes every portal view after a client decision, payment or signature. */
export function useInvalidatePortal() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["portal"] });
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }, [queryClient]);
}

interface PortalComment {
  id: number;
  body: string;
  created_at: string;
  author: string;
  is_mine: boolean;
}

/** Conversation with the agency on a project, deliverable, change request or document. */
export function PortalComments({ target, placeholder = "Ask a question or leave feedback…" }: { target: string; placeholder?: string }) {
  const queryClient = useQueryClient();
  const key = PORTAL_KEYS.comments(target);
  const query = useQuery({ queryKey: key, queryFn: () => api.get<PortalComment[]>(`/portal/comments/?target=${encodeURIComponent(target)}`) });
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post("/portal/comments/", { target, body });
      setBody("");
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
              <Avatar name={c.author} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium">{c.is_mine ? "You" : c.author}</span>
                  <span className="text-xs text-muted" title={formatDateTime(c.created_at)}>{relativeTime(c.created_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No messages yet.</p>
      )}
      <div className="rounded-lg border border-border bg-surface p-2 focus-within:border-primary">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={placeholder}
          className="border-0 shadow-none focus-visible:ring-0"
          aria-label="Message"
        />
        <div className="flex justify-end px-1 pt-1">
          <Button size="sm" onClick={submit} loading={busy} disabled={!body.trim()}>
            <Send /> Send
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface DecisionConfig {
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  tone: "success" | "danger" | "primary";
  commentLabel: string;
  commentRequired: boolean;
  url: string;
  successMessage: string;
}

/** Confirmation dialog for a client decision (approve, request changes, reject) with an optional comment. */
export function DecisionDialog({ config, onClose, onDone }: { config: DecisionConfig | null; onClose: () => void; onDone?: () => void }) {
  const invalidate = useInvalidatePortal();
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setComment("");
    setError("");
  }, [config]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    if (config.commentRequired && !comment.trim()) {
      setError("Please add a comment.");
      return;
    }
    setBusy(true);
    try {
      await api.post(config.url, { comment });
      toast.success(config.successMessage);
      invalidate();
      onClose();
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.fields.comment) setError(err.fields.comment[0]);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={config !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        {config && (
          <form onSubmit={submit}>
            <DialogHeader title={config.title} description={config.description} />
            <DialogBody>
              <Field label={config.commentLabel} htmlFor="decision-comment" error={error || undefined} required={config.commentRequired}>
                <Textarea id="decision-comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant={config.tone === "danger" ? "danger" : config.tone === "success" ? "success" : "primary"} loading={busy}>
                {config.confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export const deliverableDecision = {
  approve: (d: { id: number; title: string }): DecisionConfig => ({
    title: `Approve “${d.title}”?`,
    description: "Your approval is recorded and the team is notified.",
    confirmLabel: "Approve deliverable",
    tone: "success",
    commentLabel: "Comment (optional)",
    commentRequired: false,
    url: `/portal/deliverables/${d.id}/approve/`,
    successMessage: "Deliverable approved",
  }),
  requestChanges: (d: { id: number; title: string }): DecisionConfig => ({
    title: `Request changes to “${d.title}”`,
    description: "Describe what needs to change. The team will revise and resubmit it.",
    confirmLabel: "Request changes",
    tone: "primary",
    commentLabel: "What should change?",
    commentRequired: true,
    url: `/portal/deliverables/${d.id}/request-changes/`,
    successMessage: "Revision request sent",
  }),
};

export const changeRequestDecision = {
  approve: (c: { id: number; title: string }): DecisionConfig => ({
    title: `Approve change request “${c.title}”?`,
    description: "Approving accepts the additional scope, cost and timeline described in the request.",
    confirmLabel: "Approve change",
    tone: "success",
    commentLabel: "Comment (optional)",
    commentRequired: false,
    url: `/portal/change-requests/${c.id}/approve/`,
    successMessage: "Change request approved",
  }),
  reject: (c: { id: number; title: string }): DecisionConfig => ({
    title: `Reject change request “${c.title}”?`,
    description: "The current scope stays as agreed.",
    confirmLabel: "Reject change",
    tone: "danger",
    commentLabel: "Reason (optional)",
    commentRequired: false,
    url: `/portal/change-requests/${c.id}/reject/`,
    successMessage: "Change request rejected",
  }),
};
