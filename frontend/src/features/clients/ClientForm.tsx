import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/overlays";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Client } from "@/lib/types";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];
const FIELDS = ["name", "contact_name", "email", "phone", "website", "industry", "billing_email", "tax_id", "address_line1", "address_line2", "city", "state", "postal_code", "country", "currency", "payment_terms_days", "status", "notes"] as const;
type Values = Record<(typeof FIELDS)[number], string>;

export function ClientFormDialog({ open, onOpenChange, client }: { open: boolean; onOpenChange: (o: boolean) => void; client?: Client | null }) {
  const { org } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const blank = Object.fromEntries(FIELDS.map((f) => [f, ""])) as Values;
  const [v, setV] = React.useState<Values>(blank);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setV(client
      ? (Object.fromEntries(FIELDS.map((f) => [f, client[f] === null || client[f] === undefined ? "" : String(client[f])])) as Values)
      : { ...blank, currency: org.default_currency, status: "active" });
  }, [open, client]); // eslint-disable-line react-hooks/exhaustive-deps
  const bind = (k: keyof Values) => ({ id: `c-${k}`, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value })), "aria-invalid": Boolean(errors[k]) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={client ? `Edit ${client.name}` : "New client"} description="Contact and billing details are used on invoices and contracts." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            const payload = { ...v, payment_terms_days: v.payment_terms_days === "" ? null : Number(v.payment_terms_days) };
            try {
              const saved = client ? await api.patch<Client>(`/clients/${client.id}/`, payload) : await api.post<Client>("/clients/", payload);
              queryClient.invalidateQueries({ queryKey: ["clients"] });
              queryClient.invalidateQueries({ queryKey: ["client"] });
              queryClient.invalidateQueries({ queryKey: ["client-options"] });
              toast.success(client ? "Client updated" : "Client created");
              onOpenChange(false);
              if (!client) navigate(`/clients/${saved.id}`);
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fields);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="space-y-6">
            <section className="grid gap-4 sm:grid-cols-2">
              <Field label="Company / client name" htmlFor="c-name" required error={errors.name?.[0]} className="sm:col-span-2"><Input {...bind("name")} required autoFocus /></Field>
              <Field label="Primary contact" htmlFor="c-contact_name"><Input {...bind("contact_name")} /></Field>
              <Field label="Email" htmlFor="c-email" error={errors.email?.[0]}><Input type="email" {...bind("email")} /></Field>
              <Field label="Phone" htmlFor="c-phone"><Input {...bind("phone")} /></Field>
              <Field label="Website" htmlFor="c-website"><Input {...bind("website")} placeholder="https://" /></Field>
              <Field label="Industry" htmlFor="c-industry"><Input {...bind("industry")} /></Field>
              {client && (
                <Field label="Status" htmlFor="c-status">
                  <Select {...bind("status")}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="archived">Archived</option>
                  </Select>
                </Field>
              )}
            </section>
            <section className="grid gap-4 rounded-lg border border-border bg-surface-2 p-4 sm:grid-cols-2">
              <p className="text-[13px] font-semibold sm:col-span-2">Billing</p>
              <Field label="Billing email" htmlFor="c-billing_email" error={errors.billing_email?.[0]} hint="Invoices are emailed here (falls back to the contact email)."><Input type="email" {...bind("billing_email")} /></Field>
              <Field label="Tax / VAT ID" htmlFor="c-tax_id"><Input {...bind("tax_id")} /></Field>
              <Field label="Currency" htmlFor="c-currency"><Select {...bind("currency")}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
              <Field label="Payment terms (days)" htmlFor="c-payment_terms_days" hint={`Leave blank to use the workspace default (${org.default_payment_terms_days} days).`}><Input type="number" min="0" {...bind("payment_terms_days")} /></Field>
              <Field label="Address" htmlFor="c-address_line1" className="sm:col-span-2"><Input {...bind("address_line1")} placeholder="Street address" /></Field>
              <Input {...bind("address_line2")} id="c-address_line2" placeholder="Address line 2" aria-label="Address line 2" className="sm:col-span-2" />
              <div className="grid grid-cols-2 gap-2 sm:col-span-2 sm:grid-cols-4">
                <Input {...bind("city")} placeholder="City" aria-label="City" />
                <Input {...bind("state")} placeholder="State / region" aria-label="State" />
                <Input {...bind("postal_code")} placeholder="Postal code" aria-label="Postal code" />
                <Input {...bind("country")} placeholder="Country" aria-label="Country" />
              </div>
            </section>
            <Field label="Internal notes" htmlFor="c-notes" hint="Never shown to the client."><Textarea {...bind("notes")} rows={3} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>{client ? "Save changes" : "Create client"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
