import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/overlays";
import { useClientOptions, useMembers } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Project } from "@/lib/types";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];
const COLORS = ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#14B8A6", "#64748B"];

const decimal = z.string().refine((v) => v === "" || (!Number.isNaN(Number(v)) && Number(v) >= 0), "Enter a positive number");

const schema = z
  .object({
    name: z.string().min(2, "Give the project a name"),
    client: z.string().min(1, "Choose a client"),
    code: z.string().regex(/^$|^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/, "2-20 letters, digits or dashes"),
    project_type: z.enum(["fixed", "hourly", "retainer"]),
    status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    manager: z.string(),
    start_date: z.string(),
    deadline: z.string(),
    currency: z.string(),
    budget_amount: decimal,
    budget_hours: decimal,
    hourly_rate: decimal,
    estimated_expenses: decimal,
    retainer_amount: decimal,
    retainer_hours: decimal,
    description: z.string(),
    client_visible: z.boolean(),
    color: z.string(),
  })
  .refine((v) => !v.start_date || !v.deadline || v.deadline >= v.start_date, { message: "Deadline must be after the start date", path: ["deadline"] });

type Values = z.infer<typeof schema>;

function toValues(p?: Project | null, defaults?: Partial<Values>): Values {
  return {
    name: p?.name ?? "",
    client: p ? String(p.client) : defaults?.client ?? "",
    code: p?.code ?? "",
    project_type: p?.project_type ?? "hourly",
    status: p?.status ?? "planning",
    priority: p?.priority ?? "medium",
    manager: p?.manager ? String(p.manager) : "",
    start_date: p?.start_date ?? "",
    deadline: p?.deadline ?? "",
    currency: p?.currency ?? "",
    budget_amount: p?.budget_amount ?? "",
    budget_hours: p?.budget_hours ?? "",
    hourly_rate: p?.hourly_rate ?? "",
    estimated_expenses: p?.estimated_expenses ?? "",
    retainer_amount: p?.retainer_amount ?? "",
    retainer_hours: p?.retainer_hours ?? "",
    description: p?.description ?? "",
    client_visible: p?.client_visible ?? true,
    color: p?.color ?? COLORS[0],
  };
}

export function ProjectFormDialog({ open, onOpenChange, project, defaultClient }: { open: boolean; onOpenChange: (o: boolean) => void; project?: Project | null; defaultClient?: number }) {
  const { permissions, org } = useAuth();
  const clients = useClientOptions(open);
  const members = useMembers();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(project, { client: defaultClient ? String(defaultClient) : "" }) });
  React.useEffect(() => {
    if (open) form.reset(toValues(project, { client: defaultClient ? String(defaultClient) : "" }));
  }, [open, project, defaultClient]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = form.watch("project_type");
  const clientId = form.watch("client");
  const selectedClient = clients.data?.find((c) => String(c.id) === clientId);
  const canFinance = !project || project.can_manage;
  const managers = members.data?.filter((m) => ["owner", "admin", "project_manager"].includes(m.role)) ?? [];
  const e = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    const payload: Record<string, unknown> = {
      name: v.name, client: Number(v.client), project_type: v.project_type, priority: v.priority,
      start_date: v.start_date || null, deadline: v.deadline || null, description: v.description,
      client_visible: v.client_visible, color: v.color, budget_hours: v.budget_hours || "0", retainer_hours: v.retainer_hours || "0",
    };
    if (v.code) payload.code = v.code.toUpperCase();
    if (v.status !== "completed") payload.status = v.status;
    if (v.manager) payload.manager = Number(v.manager);
    if (v.currency) payload.currency = v.currency;
    if (canFinance) {
      Object.assign(payload, {
        budget_amount: v.budget_amount || "0", estimated_expenses: v.estimated_expenses || "0",
        hourly_rate: v.hourly_rate || null, retainer_amount: v.retainer_amount || "0",
      });
    }
    try {
      const saved = project ? await api.patch<Project>(`/projects/${project.id}/`, payload) : await api.post<Project>("/projects/", payload);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project"] });
      queryClient.invalidateQueries({ queryKey: ["project-options"] });
      toast.success(project ? "Project updated" : `Project ${saved.code} created`);
      onOpenChange(false);
      if (!project) navigate(`/projects/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) for (const [k, msgs] of Object.entries(err.fields)) form.setError(k as keyof Values, { message: msgs[0] });
      toast.error(errorMessage(err));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={project ? `Edit ${project.code}` : "New project"} description="Budgets and rates drive time valuation, health signals and the Revenue Leak Radar." />
        <form onSubmit={onSubmit} className="contents" noValidate>
          <DialogBody className="space-y-6">
            <section className="grid gap-4 sm:grid-cols-2">
              <Field label="Project name" htmlFor="p-name" required error={e.name?.message} className="sm:col-span-2">
                <Input id="p-name" {...form.register("name")} aria-invalid={!!e.name} autoFocus />
              </Field>
              <Field label="Client" htmlFor="p-client" required error={e.client?.message}>
                <Select id="p-client" {...form.register("client")} aria-invalid={!!e.client} disabled={!!project}>
                  <option value="">Select a client…</option>
                  {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Project code" htmlFor="p-code" error={e.code?.message} hint={project ? undefined : "Leave blank to generate one, e.g. ACME-003."}>
                <Input id="p-code" {...form.register("code")} placeholder="Auto" className="uppercase" />
              </Field>
              <Field label="Status" htmlFor="p-status">
                <Select id="p-status" {...form.register("status")} disabled={project?.status === "completed"}>
                  <option value="planning">Planning</option>
                  <option value="active">Active</option>
                  <option value="on_hold">On hold</option>
                  <option value="cancelled">Cancelled</option>
                  {project?.status === "completed" && <option value="completed">Completed</option>}
                </Select>
              </Field>
              <Field label="Priority" htmlFor="p-priority">
                <Select id="p-priority" {...form.register("priority")}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </Field>
              {permissions.is_admin && (
                <Field label="Project manager" htmlFor="p-manager">
                  <Select id="p-manager" {...form.register("manager")}>
                    <option value="">Me</option>
                    {managers.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Start date" htmlFor="p-start">
                <Input id="p-start" type="date" {...form.register("start_date")} />
              </Field>
              <Field label="Deadline" htmlFor="p-deadline" error={e.deadline?.message}>
                <Input id="p-deadline" type="date" {...form.register("deadline")} />
              </Field>
            </section>

            <section className="space-y-4 rounded-lg border border-border bg-surface-2 p-4">
              <div>
                <p className="text-[13px] font-semibold">Billing & budget</p>
                <p className="text-xs text-muted">Hours budgets are visible to the team; monetary values only to managers.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Billing model" htmlFor="p-type">
                  <Select id="p-type" {...form.register("project_type")}>
                    <option value="hourly">Time & materials</option>
                    <option value="fixed">Fixed price</option>
                    <option value="retainer">Retainer (monthly)</option>
                  </Select>
                </Field>
                <Field label="Currency" htmlFor="p-currency" hint={!project ? `Defaults to ${selectedClient?.currency ?? org.default_currency}` : undefined}>
                  <Select id="p-currency" {...form.register("currency")}>
                    <option value="">{selectedClient?.currency ?? "Client default"}</option>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </Select>
                </Field>
                {canFinance && (
                  <Field label="Hourly rate" htmlFor="p-rate" error={e.hourly_rate?.message} hint="Default billing rate">
                    <Input id="p-rate" type="number" step="0.01" min="0" {...form.register("hourly_rate")} placeholder={org.default_bill_rate} />
                  </Field>
                )}
                {type === "retainer" ? (
                  <>
                    {canFinance && (
                      <Field label="Monthly retainer fee" htmlFor="p-ret-amt" error={e.retainer_amount?.message}>
                        <Input id="p-ret-amt" type="number" step="0.01" min="0" {...form.register("retainer_amount")} />
                      </Field>
                    )}
                    <Field label="Hours included / month" htmlFor="p-ret-hours" error={e.retainer_hours?.message}>
                      <Input id="p-ret-hours" type="number" step="0.5" min="0" {...form.register("retainer_hours")} />
                    </Field>
                  </>
                ) : (
                  <>
                    {canFinance && (
                      <Field label={type === "fixed" ? "Fixed fee" : "Fee budget"} htmlFor="p-budget" error={e.budget_amount?.message}>
                        <Input id="p-budget" type="number" step="0.01" min="0" {...form.register("budget_amount")} />
                      </Field>
                    )}
                    <Field label="Budgeted hours" htmlFor="p-hours" error={e.budget_hours?.message}>
                      <Input id="p-hours" type="number" step="0.5" min="0" {...form.register("budget_hours")} />
                    </Field>
                  </>
                )}
                {canFinance && (
                  <Field label="Estimated expenses" htmlFor="p-exp" error={e.estimated_expenses?.message}>
                    <Input id="p-exp" type="number" step="0.01" min="0" {...form.register("estimated_expenses")} />
                  </Field>
                )}
              </div>
            </section>

            <section className="grid gap-4">
              <Field label="Description" htmlFor="p-desc">
                <Textarea id="p-desc" rows={3} {...form.register("description")} />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox {...form.register("client_visible")} /> Share progress with the client portal
                </label>
                <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Project colour">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={form.watch("color") === c}
                      aria-label={c}
                      onClick={() => form.setValue("color", c)}
                      className="size-5 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-fg"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </section>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={form.formState.isSubmitting}>{project ? "Save changes" : "Create project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
