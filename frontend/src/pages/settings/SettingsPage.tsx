import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, Moon, Plus, Sun, Trash2, Upload, XCircle } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useApiMutation, useExpenseCategories, useLabels, useTheme } from "@/hooks/data";
import { SESSION_KEY, useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Organization, Session } from "@/lib/types";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];
const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC", "Europe/London", "America/New_York"];

export function ProfileSettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(user.full_name);
  const [tz, setTz] = React.useState(user.timezone);
  const [pw, setPw] = React.useState({ current_password: "", new_password: "" });
  const [pwErrors, setPwErrors] = React.useState<Record<string, string[]>>({});
  const save = useApiMutation(() => api.patch<Session>("/auth/me/", { full_name: name, timezone: tz }), {
    success: "Profile saved",
    onSuccess: (s) => queryClient.setQueryData(SESSION_KEY, s),
  });
  const change = useApiMutation(() => api.post("/auth/change-password/", pw), {
    success: "Password changed",
    silentError: true,
    onSuccess: () => { setPw({ current_password: "", new_password: "" }); setPwErrors({}); },
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><div><CardTitle>Profile</CardTitle><CardDescription>Times are displayed in your timezone.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Full name" htmlFor="p-name"><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email" htmlFor="p-email" hint="Contact an administrator to change your sign-in email."><Input id="p-email" value={user.email} disabled /></Field>
          <Field label="Timezone" htmlFor="p-tz"><Select id="p-tz" value={tz} onChange={(e) => setTz(e.target.value)}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>Save profile</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Current password" htmlFor="pw-cur" error={pwErrors.current_password?.[0]}><Input id="pw-cur" type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
          <Field label="New password" htmlFor="pw-new" error={pwErrors.new_password?.[0]} hint="At least 8 characters; avoid common passwords."><Input id="pw-new" type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
          <Button
            variant="outline"
            disabled={!pw.current_password || !pw.new_password}
            loading={change.isPending}
            onClick={() => change.mutate(undefined, { onError: (err) => { if (err instanceof ApiError) setPwErrors(err.fields); toast.error(errorMessage(err)); } })}
          >
            Update password
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function WorkspaceTab() {
  const { permissions } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["workspace"], queryFn: () => api.get<Organization>("/workspace/") });
  const [v, setV] = React.useState<Partial<Organization>>({});
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (query.data) setV(query.data); }, [query.data]);
  if (!query.data) return null;
  const readOnly = !permissions.is_admin;
  const bind = (k: keyof Organization) => ({ id: `ws-${k}`, value: (v[k] as string | number | undefined) ?? "", disabled: readOnly, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value })) });
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const { has_logo: _l, is_demo: _d, slug: _s, id: _i, ...payload } = v;
      await api.patch("/workspace/", payload);
      const session = await api.get<Session>("/auth/me/");
      queryClient.setQueryData(SESSION_KEY, session);
      queryClient.invalidateQueries({ queryKey: ["workspace"] });
      toast.success("Workspace settings saved");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><div><CardTitle>Company</CardTitle><CardDescription>Shown on invoices, contracts and the client portal.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name" htmlFor="ws-name" error={errors.name?.[0]}><Input {...bind("name")} /></Field>
          <Field label="Billing email" htmlFor="ws-email"><Input type="email" {...bind("email")} /></Field>
          <Field label="Phone" htmlFor="ws-phone"><Input {...bind("phone")} /></Field>
          <Field label="Website" htmlFor="ws-website"><Input {...bind("website")} /></Field>
          <Field label="Address" htmlFor="ws-address" className="sm:col-span-2"><Textarea rows={3} {...bind("address")} /></Field>
          <Field label="Tax ID" htmlFor="ws-tax_id"><Input {...bind("tax_id")} /></Field>
          <Field label="Brand colour" htmlFor="ws-brand_color" error={errors.brand_color?.[0]}>
            <div className="flex gap-2"><input type="color" aria-label="Pick colour" value={(v.brand_color as string) || "#4F46E5"} disabled={readOnly} onChange={(e) => setV({ ...v, brand_color: e.target.value.toUpperCase() })} className="h-9 w-12 rounded border border-border" /><Input {...bind("brand_color")} /></div>
          </Field>
          <div className="flex items-center gap-4 sm:col-span-2">
            {query.data.has_logo ? <img src={`/api/workspace/logo/?v=${Date.now()}`} alt="Logo" className="h-12 max-w-[180px] rounded border border-border object-contain p-1" /> : <div className="flex h-12 w-24 items-center justify-center rounded border border-dashed border-border text-xs text-muted">No logo</div>}
            {!readOnly && (
              <>
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload /> Upload logo</Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const form = new FormData();
                    form.append("file", file);
                    try {
                      await api.post("/workspace/logo/", form);
                      queryClient.invalidateQueries({ queryKey: ["workspace"] });
                      queryClient.setQueryData(SESSION_KEY, await api.get<Session>("/auth/me/"));
                      toast.success("Logo updated");
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Regional & time</CardTitle></div></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Default currency" htmlFor="ws-default_currency"><Select {...bind("default_currency")}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Timezone" htmlFor="ws-timezone"><Select {...bind("timezone")}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Week starts on" htmlFor="ws-week_start"><Select {...bind("week_start")}><option value={0}>Monday</option><option value={6}>Sunday</option></Select></Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Invoicing</CardTitle><CardDescription>Defaults for new invoices. Numbers are allocated sequentially and never reused.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Invoice prefix" htmlFor="ws-invoice_prefix"><Input {...bind("invoice_prefix")} /></Field>
          <Field label="Next invoice number" htmlFor="ws-next" hint="Read-only"><Input id="ws-next" value={query.data.next_invoice_number} disabled /></Field>
          <Field label="Payment terms (days)" htmlFor="ws-default_payment_terms_days"><Input type="number" min="0" {...bind("default_payment_terms_days")} /></Field>
          <Field label="Default tax rate (%)" htmlFor="ws-default_tax_rate" error={errors.default_tax_rate?.[0]}><Input type="number" step="0.01" min="0" max="100" {...bind("default_tax_rate")} /></Field>
          <Field label="Tax label" htmlFor="ws-tax_label"><Input {...bind("tax_label")} placeholder="Tax, VAT, GST…" /></Field>
          <Field label="Default billing rate / hour" htmlFor="ws-default_bill_rate"><Input type="number" step="0.01" min="0" {...bind("default_bill_rate")} /></Field>
          <Field label="Invoice footer" htmlFor="ws-invoice_footer" className="sm:col-span-3" hint="e.g. bank details for transfers"><Textarea rows={2} {...bind("invoice_footer")} /></Field>
          <label className="flex items-center gap-2 text-[13px] sm:col-span-3"><Checkbox checked={Boolean(v.allow_partial_payments)} disabled={readOnly} onChange={(e) => setV({ ...v, allow_partial_payments: e.target.checked })} /> Allow clients to pay invoices partially online</label>
        </CardContent>
      </Card>
      {!readOnly && <div className="flex justify-end"><Button onClick={save} loading={busy}>Save workspace settings</Button></div>}
    </div>
  );
}

/** `kinds` limits the list, e.g. to the events a client portal user can receive. */
export function NotificationSettings({ kinds }: { kinds?: string[] }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["notification-prefs"], queryFn: () => api.get<{ kind: string; label: string; in_app: boolean; email: boolean }[]>("/workspace/notification-preferences/") });
  const update = async (kind: string, field: "in_app" | "email", value: boolean) => {
    const prefs = query.data?.map((p) => (p.kind === kind ? { ...p, [field]: value } : p)) ?? [];
    queryClient.setQueryData(["notification-prefs"], prefs);
    try {
      await api.put("/workspace/notification-preferences/", prefs);
    } catch (err) {
      toast.error(errorMessage(err));
      queryClient.invalidateQueries({ queryKey: ["notification-prefs"] });
    }
  };
  return (
    <Card>
      <CardHeader><div><CardTitle>Notification preferences</CardTitle><CardDescription>Choose what reaches you in the app and by email for this workspace.</CardDescription></div></CardHeader>
      <Table>
        <THead><tr><TH>Event</TH><TH className="w-24 text-center">In app</TH><TH className="w-24 text-center">Email</TH></tr></THead>
        <TBody>
          {query.data?.filter((p) => !kinds || kinds.includes(p.kind)).map((p) => (
            <TR key={p.kind}>
              <TD className="text-[13px]">{p.label}</TD>
              <TD className="text-center"><Switch checked={p.in_app} onCheckedChange={(c) => update(p.kind, "in_app", c)} aria-label={`${p.label} in app`} /></TD>
              <TD className="text-center"><Switch checked={p.email} onCheckedChange={(c) => update(p.kind, "email", c)} aria-label={`${p.label} by email`} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function ListsTab() {
  const { permissions } = useAuth();
  const queryClient = useQueryClient();
  const labels = useLabels();
  const categories = useExpenseCategories();
  const provider = useQuery({ queryKey: ["payment-provider"], queryFn: () => api.get<{ name: string; label: string; test_mode: boolean; simulator: boolean; configured: boolean; problem: string }>("/payments/provider/") });
  const [label, setLabel] = React.useState({ name: "", color: "#64748B" });
  const [category, setCategory] = React.useState("");
  const add = async (path: string, body: Record<string, unknown>, key: string) => {
    try {
      await api.post(path, body);
      queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async (path: string, key: string) => {
    try {
      await api.delete(path);
      queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader><div><CardTitle className="flex items-center gap-2"><CreditCard className="size-4" /> Online payments</CardTitle><CardDescription>Configured with environment variables on the server (PAYMENT_PROVIDER).</CardDescription></div></CardHeader>
        <CardContent>
          {provider.data && (
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              {provider.data.configured ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-danger" />}
              <span className="font-medium">{provider.data.label}</span>
              {provider.data.simulator && <Badge tone="warning">Local simulator — no real money moves</Badge>}
              {!provider.data.simulator && provider.data.test_mode && <Badge tone="info">Test mode</Badge>}
              {!provider.data.configured && <span className="text-danger">{provider.data.problem}</span>}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">Invoices are only marked paid after the provider confirms payment server-side (signed webhook or provider API lookup). Card details never touch OmniManager.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Task labels</CardTitle></div></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {labels.data?.map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${l.color}22`, color: l.color }}>
                {l.name}
                {permissions.is_manager && <button type="button" aria-label={`Delete ${l.name}`} onClick={() => remove(`/labels/${l.id}/`, "labels")}><Trash2 className="size-3" /></button>}
              </span>
            ))}
          </div>
          {permissions.is_manager && (
            <div className="flex gap-2">
              <Input value={label.name} onChange={(e) => setLabel({ ...label, name: e.target.value })} placeholder="New label" className="h-8" aria-label="New label name" />
              <input type="color" value={label.color} onChange={(e) => setLabel({ ...label, color: e.target.value })} aria-label="Label colour" className="h-8 w-10 rounded border border-border" />
              <Button size="sm" variant="outline" disabled={!label.name.trim()} onClick={() => { add("/labels/", label, "labels"); setLabel({ name: "", color: "#64748B" }); }}><Plus /> Add</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Expense categories</CardTitle></div></CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-1">
            {categories.data?.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-md px-2 py-1 text-[13px] hover:bg-subtle">
                <span className={c.is_active ? "" : "text-muted line-through"}>{c.name}</span>
                {permissions.is_admin && c.is_active && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.name}`} onClick={() => remove(`/expense-categories/${c.id}/`, "expense-categories")}><Trash2 /></Button>}
              </li>
            ))}
          </ul>
          {permissions.is_admin && (
            <div className="flex gap-2">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="New category" className="h-8" aria-label="New category" />
              <Button size="sm" variant="outline" disabled={!category.trim()} onClick={() => { add("/expense-categories/", { name: category }, "expense-categories"); setCategory(""); }}><Plus /> Add</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "profile";
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList className="mb-5">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="lists">Payments & lists</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>
        <TabsContent value="profile"><ProfileSettings /></TabsContent>
        <TabsContent value="workspace"><WorkspaceTab /></TabsContent>
        <TabsContent value="notifications"><NotificationSettings /></TabsContent>
        <TabsContent value="lists"><ListsTab /></TabsContent>
        <TabsContent value="appearance">
          <Card className="max-w-lg">
            <CardHeader><div><CardTitle>Theme</CardTitle><CardDescription>Saved in this browser.</CardDescription></div></CardHeader>
            <CardContent className="flex gap-3">
              {(["light", "dark"] as const).map((t) => (
                <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)} className={`flex flex-1 items-center gap-2 rounded-lg border p-3 text-[13px] font-medium ${theme === t ? "border-primary bg-primary-soft text-primary" : "border-border"}`}>
                  {t === "light" ? <Sun className="size-4" /> : <Moon className="size-4" />} {t === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
