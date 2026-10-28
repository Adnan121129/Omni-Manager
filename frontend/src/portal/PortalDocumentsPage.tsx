import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, Eraser, FileSignature, PenLine, ShieldCheck, Type, XCircle } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { EmptyState, ErrorState, PageHeader, PageLoader } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Segmented } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, titleCase } from "@/lib/format";

import { DueText } from "./PortalHomePage";
import { PORTAL_KEYS, PortalComments, type PortalDocument, type PortalDocumentSummary, useInvalidatePortal } from "./portalApi";

export function PortalDocumentsPage() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: PORTAL_KEYS.documents, queryFn: () => api.get<PortalDocumentSummary[]>("/portal/documents/") });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <>
      <PageHeader title="Documents" description="Proposals, contracts and agreements shared with you for review and signature." />
      <Card>
        {query.data.length === 0 ? (
          <EmptyState icon={FileSignature} title="No documents yet" description="When the team sends a proposal or contract, it appears here." />
        ) : (
          <Table>
            <THead>
              <tr><TH>Document</TH><TH>Status</TH><TH>Sent</TH><TH>Signed / expires</TH><TH className="text-right">Value</TH></tr>
            </THead>
            <TBody>
              {query.data.map((d) => (
                <TR key={d.id} className="cursor-pointer" onClick={() => navigate(`/portal/documents/${d.id}`)}>
                  <TD>
                    <Link to={`/portal/documents/${d.id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>{d.title}</Link>
                    <p className="text-xs text-muted">{titleCase(d.kind)}{d.project ? ` · ${d.project}` : ""}{d.version > 1 ? ` · v${d.version}` : ""}</p>
                  </TD>
                  <TD>
                    {d.status === "sent" || d.status === "viewed" ? <Badge tone="warning" dot>Awaiting signature</Badge> : <StatusBadge kind="document" status={d.status} />}
                  </TD>
                  <TD className="text-[13px] text-muted">{formatDate(d.sent_at)}</TD>
                  <TD className="text-[13px] text-muted">
                    {d.signed_at ? `Signed ${formatDate(d.signed_at)}` : d.expires_at && (d.status === "sent" || d.status === "viewed") ? <DueText date={d.expires_at} prefix="Expires" /> : "—"}
                  </TD>
                  <TD className="text-right tabular">{Number(d.total_amount) > 0 ? formatMoney(d.total_amount, d.currency) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}

/** Freehand signature canvas. Emits a PNG data URL, or "" when cleared. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string) => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const last = React.useRef<{ x: number; y: number } | null>(null);
  const inked = React.useRef(false);
  const [hasInk, setHasInk] = React.useState(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!inked.current) {
      inked.current = true;
      setHasInk(true);
    }
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (canvasRef.current && inked.current) onChange(canvasRef.current.toDataURL("image/png"));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    setHasInk(false);
    onChange("");
  };
  return (
    <div>
      <div className="relative overflow-hidden rounded-md border border-border-strong bg-white">
        <canvas
          ref={canvasRef}
          className="block h-36 w-full touch-none cursor-crosshair"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          aria-label="Signature pad: draw your signature"
          data-testid="signature-pad"
        />
        <span className="pointer-events-none absolute inset-x-6 bottom-7 border-b border-dashed border-slate-300" aria-hidden />
        {!hasInk && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-slate-400">Sign here</span>}
      </div>
      <div className="mt-1.5 flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={!hasInk}><Eraser /> Clear</Button>
      </div>
    </div>
  );
}

function SignPanel({ doc }: { doc: PortalDocument }) {
  const { user } = useAuth();
  const invalidate = useInvalidatePortal();
  const [name, setName] = React.useState(user.full_name);
  const [title, setTitle] = React.useState("");
  const [method, setMethod] = React.useState<"drawn" | "typed">("drawn");
  const [image, setImage] = React.useState("");
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [declining, setDeclining] = React.useState(false);
  const canSign = consent && name.trim().length >= 2 && (method === "typed" || image !== "");

  const sign = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/portal/documents/${doc.id}/sign/`, {
        version: doc.version,
        content_hash: doc.content_hash,
        signer_name: name,
        signer_title: title,
        method,
        signature_image: method === "drawn" ? image : "",
        consent,
      });
      toast.success("Document signed");
      invalidate();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === "version_mismatch") invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="sign-panel">
      <CardHeader><CardTitle>Sign this document</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <Field label="Full legal name" htmlFor="sig-name" required>
          <Input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
        <Field label="Title (optional)" htmlFor="sig-title">
          <Input id="sig-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Marketing Director" />
        </Field>
        <div className="space-y-2">
          <Segmented
            size="sm"
            value={method}
            onChange={(m) => { setMethod(m); setImage(""); }}
            options={[{ value: "drawn", label: "Draw", icon: <PenLine /> }, { value: "typed", label: "Type", icon: <Type /> }]}
          />
          {method === "drawn" ? (
            <SignaturePad onChange={setImage} />
          ) : (
            <div className="flex h-36 items-center justify-center rounded-md border border-border-strong bg-white px-4" data-testid="typed-signature">
              <span className="truncate font-serif text-3xl italic text-slate-900">{name.trim() || "Your name"}</span>
            </div>
          )}
        </div>
        <label className="flex items-start gap-2.5 text-[13px] leading-relaxed">
          <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" aria-label="I agree to sign electronically" />
          <span>{doc.consent_text}</span>
        </label>
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{error}</p>}
        <Button className="w-full" size="lg" onClick={sign} disabled={!canSign} loading={busy} data-testid="sign-document">
          <FileSignature /> Sign document
        </Button>
        <p className="flex gap-2 text-xs text-muted"><ShieldCheck className="size-4 shrink-0" /> {doc.legal_notice}</p>
        <div className="border-t border-border pt-3 text-center">
          <Button variant="link" size="sm" className="text-danger" onClick={() => setDeclining(true)}>Decline to sign</Button>
        </div>
      </CardContent>
      <DeclineDialog doc={doc} open={declining} onOpenChange={setDeclining} />
    </Card>
  );
}

function DeclineDialog({ doc, open, onOpenChange }: { doc: PortalDocument; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidatePortal();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Please tell the team why you're declining.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/portal/documents/${doc.id}/decline/`, { reason });
      toast.success("Document declined — the team has been notified");
      invalidate();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader title={`Decline “${doc.title}”?`} description="The team will be notified and can send a revised version." />
          <DialogBody>
            <Field label="Reason" htmlFor="decline-reason" required error={error || undefined}>
              <Textarea id="decline-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={busy}>Decline document</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SignedPanel({ doc }: { doc: PortalDocument }) {
  const sig = doc.signature;
  if (!sig) return null;
  return (
    <Card data-testid="signed-panel">
      <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-4 text-success" /> Signed</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-white px-4 py-3">
          {sig.method === "drawn" && sig.signature_image ? (
            <img src={sig.signature_image} alt={`Signature of ${sig.signer_name}`} className="h-16 object-contain" />
          ) : (
            <p className="font-serif text-3xl italic text-slate-900">{sig.signer_name}</p>
          )}
        </div>
        <p className="text-[13px] font-medium">{sig.signer_name}{sig.signer_title ? `, ${sig.signer_title}` : ""}</p>
        <dl className="space-y-1.5 text-xs">
          <div><dt className="text-muted">Signed at</dt><dd>{formatDateTime(sig.signed_at)}</dd></div>
          <div><dt className="text-muted">Version</dt><dd>v{doc.version}</dd></div>
          <div><dt className="text-muted">Document fingerprint (SHA-256)</dt><dd className="break-all font-mono text-[10px]">{sig.content_hash}</dd></div>
        </dl>
      </CardContent>
    </Card>
  );
}

export function PortalDocumentPage() {
  const { id = "" } = useParams();
  const query = useQuery({ queryKey: PORTAL_KEYS.document(id), queryFn: () => api.get<PortalDocument>(`/portal/documents/${id}/`) });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const doc = query.data;
  const awaiting = doc.status === "sent" || doc.status === "viewed";
  return (
    <>
      <PageHeader
        back={{ to: "/portal/documents", label: "Documents" }}
        title={doc.title}
        meta={
          <>
            {awaiting ? <Badge tone="warning" dot>Awaiting signature</Badge> : <StatusBadge kind="document" status={doc.status} />}
            <span className="text-xs text-muted">{titleCase(doc.kind)} · v{doc.version} from {doc.organization.name}{doc.project ? ` · ${doc.project}` : ""}</span>
          </>
        }
        actions={
          <Button variant="outline" asChild>
            <a href={`/api/portal/documents/${doc.id}/pdf/`}><Download /> Download PDF</a>
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card className="px-5 py-6 sm:px-10 sm:py-10">
            <article className="om-document" dangerouslySetInnerHTML={{ __html: doc.html }} data-testid="document-body" />
          </Card>
          <Card>
            <CardHeader><CardTitle>Questions about this document?</CardTitle></CardHeader>
            <CardContent><PortalComments target={`document:${doc.id}`} placeholder="Ask the team about a clause, the scope or pricing…" /></CardContent>
          </Card>
        </div>
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {Number(doc.total_amount) > 0 && (
            <Card className="p-4">
              <p className="text-[13px] text-muted">Total value</p>
              <p className="mt-1 text-2xl font-semibold tabular">{formatMoney(doc.total_amount, doc.currency)}</p>
              {awaiting && doc.expires_at && <p className="mt-1 text-xs text-muted"><DueText date={doc.expires_at} prefix="Offer expires" /></p>}
            </Card>
          )}
          {awaiting && doc.is_signer && <SignPanel key={`${doc.id}-${doc.version}`} doc={doc} />}
          {awaiting && !doc.is_signer && (
            <Card className="p-4 text-[13px]">
              <p className="font-medium">Awaiting signature from another contact</p>
              <p className="mt-1 text-muted">This document was sent to a different signer at your organization. You can review it and ask questions.</p>
            </Card>
          )}
          {doc.status === "signed" && <SignedPanel doc={doc} />}
          {doc.status === "declined" && (
            <Card className="p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold"><XCircle className="size-4 text-danger" /> Declined</p>
              {doc.decline_reason && <p className="mt-2 whitespace-pre-wrap text-[13px] text-muted">“{doc.decline_reason}”</p>}
              <p className="mt-2 text-xs text-muted">The team has been notified and may send a revised version.</p>
            </Card>
          )}
          {doc.status === "expired" && (
            <Card className="p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold"><AlertTriangle className="size-4 text-warning" /> This offer has expired</p>
              <p className="mt-2 text-xs text-muted">Contact the team if you'd like them to send an updated version.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
