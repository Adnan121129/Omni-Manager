import { ArrowRight, CheckCircle2, Clock, GitPullRequestArrow, PackageCheck } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";

import { EmptyState, ErrorState, PageHeader, PageLoader } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { formatHours, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ApprovalRow, DueText } from "./PortalHomePage";
import { changeRequestDecision, type DecisionConfig, DecisionDialog, deliverableDecision, type PortalApproval, usePortalSummary } from "./portalApi";

type Filter = "all" | PortalApproval["type"];

function DecisionCard({ item, highlighted, onDecide }: { item: PortalApproval; highlighted: boolean; onDecide: (c: DecisionConfig) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  const isChange = item.type === "change_request";
  const Icon = isChange ? GitPullRequestArrow : PackageCheck;
  return (
    <div ref={ref}>
      <Card className={cn("p-4", highlighted && "ring-2 ring-primary")} data-testid={`approval-${item.type}-${item.id}`}>
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold leading-snug">{item.title}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {isChange ? "Change request" : `Deliverable${item.revision && item.revision > 1 ? ` · revision ${item.revision}` : ""}`}
                  {item.project && ` · ${item.project}`}
                </p>
              </div>
              <Badge tone="warning">{item.status_label}</Badge>
            </div>
            {item.description && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{item.description}</p>}
            {isChange && (
              <dl className="mt-3 grid grid-cols-2 gap-3 rounded-md bg-surface-2 p-3 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">Additional cost</dt>
                  <dd className="font-semibold tabular">{item.amount && item.currency ? formatMoney(item.amount, item.currency) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Estimated effort</dt>
                  <dd className="font-semibold tabular">{item.estimated_hours ? formatHours(item.estimated_hours) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Revised deadline</dt>
                  <dd className="font-semibold">{item.due_date ? <DueText date={item.due_date} prefix="" /> : "Unchanged"}</dd>
                </div>
              </dl>
            )}
            {!isChange && item.due_date && <p className="mt-2 text-xs text-muted"><DueText date={item.due_date} /></p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {isChange ? (
                <>
                  <Button size="sm" variant="success" onClick={() => onDecide(changeRequestDecision.approve(item))}>Approve</Button>
                  <Button size="sm" variant="danger-outline" onClick={() => onDecide(changeRequestDecision.reject(item))}>Reject</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="success" onClick={() => onDecide(deliverableDecision.approve(item))}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => onDecide(deliverableDecision.requestChanges(item))}>Request changes</Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to={item.link}>Files & discussion <ArrowRight /></Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function PortalApprovalsPage() {
  const query = usePortalSummary();
  const [params] = useSearchParams();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [decision, setDecision] = React.useState<DecisionConfig | null>(null);
  const highlightChange = Number(params.get("change_request")) || null;
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const items = query.data.approvals.filter((a) => filter === "all" || a.type === filter);
  const count = (t: PortalApproval["type"]) => query.data.approvals.filter((a) => a.type === t).length;
  const decisions = items.filter((a) => a.type === "deliverable" || a.type === "change_request");
  const links = items.filter((a) => a.type === "document" || a.type === "invoice");
  return (
    <>
      <PageHeader title="Approvals" description="Review deliverables, decide on change requests, sign documents and settle invoices — everything that is waiting on you." />
      <Segmented
        className="mb-4"
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All · ${query.data.approvals.length}` },
          { value: "deliverable", label: `Deliverables · ${count("deliverable")}` },
          { value: "change_request", label: `Changes · ${count("change_request")}` },
          { value: "document", label: `Signatures · ${count("document")}` },
          { value: "invoice", label: `Payments · ${count("invoice")}` },
        ]}
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState icon={CheckCircle2} title="Nothing waiting on you" description="New requests from the team will appear here, and you'll get a notification." />
        </Card>
      ) : (
        <div className="space-y-6">
          {decisions.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Clock className="size-4 text-muted" /> Decisions</h2>
              {decisions.map((a) => (
                <DecisionCard key={`${a.type}-${a.id}`} item={a} highlighted={a.type === "change_request" && a.id === highlightChange} onDecide={setDecision} />
              ))}
            </section>
          )}
          {links.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Signatures & payments</h2>
              <Card>
                <ul className="divide-y divide-border">{links.map((a) => <ApprovalRow key={`${a.type}-${a.id}`} item={a} />)}</ul>
              </Card>
            </section>
          )}
        </div>
      )}
      <DecisionDialog config={decision} onClose={() => setDecision(null)} />
    </>
  );
}
