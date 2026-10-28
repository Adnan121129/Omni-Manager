import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, FileSignature, Radar, Receipt } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { SESSION_KEY, useSessionQuery } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Session } from "@/lib/types";

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#4F46E5" />
        <path d="M9 16a7 7 0 1 1 14 0a7 7 0 1 1-14 0Zm4 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z" fill="#fff" />
        <path d="M21.5 9.5 25 6" stroke="#A5B4FC" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-semibold tracking-tight">OmniManager</span>
    </div>
  );
}

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_minmax(0,560px)]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Brand />
          <h1 className="mt-10 text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-[13px] text-muted">{footer}</div>}
        </div>
      </div>
      <aside className="relative hidden overflow-hidden bg-sidebar px-12 py-16 text-sidebar-fg lg:flex lg:flex-col lg:justify-center">
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "22px 22px" }} />
        <div className="relative max-w-md">
          <p className="text-[13px] font-medium uppercase tracking-wider text-indigo-300">Client work, end to end</p>
          <p className="mt-4 text-3xl font-semibold leading-tight tracking-tight text-white">
            Plan the work. Manage the client. Track every hour. Control every budget. Deliver. Get paid.
          </p>
          <ul className="mt-10 space-y-4 text-[13px]">
            {[
              [Clock, "Reliable timers and approved timesheets"],
              [Receipt, "Invoices generated from approved work — never billed twice"],
              [FileSignature, "Contracts with auditable electronic acceptance"],
              [Radar, "Revenue Leak Radar surfaces unbilled work and budget risk"],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof Clock;
              return (
                <li key={i} className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-md bg-white/5 ring-1 ring-white/10">
                    <I className="size-4 text-indigo-300" />
                  </span>
                  {text as string}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function useAfterLogin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (session: Session) => {
    queryClient.clear();
    queryClient.setQueryData(SESSION_KEY, session);
    const next = params.get("next");
    if (session.permissions?.is_client) navigate(next?.startsWith("/portal") ? next : "/portal", { replace: true });
    else navigate(next && !next.startsWith("/portal") ? next : "/", { replace: true });
  };
}

const loginSchema = z.object({
  email: z.string().min(1, "Enter your email").email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export function LoginPage() {
  const session = useSessionQuery();
  const afterLogin = useAfterLogin();
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  if (session.data?.membership) return <Navigate to={session.data.permissions?.is_client ? "/portal" : "/"} replace />;
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      afterLogin(await api.post<Session>("/auth/login/", values));
    } catch (err) {
      setFormError(errorMessage(err));
    }
  });
  return (
    <AuthLayout
      title="Sign in to your workspace"
      subtitle="Welcome back. Team members and clients use the same sign-in."
      footer={
        <>
          New to OmniManager? <Link to="/signup" className="font-medium text-primary hover:underline">Create a workspace</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && (
          <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {formError}
          </div>
        )}
        <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </Field>
        <Field
          label={
            <span className="flex w-full items-center justify-between">
              Password
              <Link to="/forgot-password" className="text-xs font-normal text-primary hover:underline">
                Forgot password?
              </Link>
            </span>
          }
          htmlFor="password"
          error={form.formState.errors.password?.message}
        >
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

const signupSchema = z.object({
  full_name: z.string().min(2, "Enter your full name"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Use at least 8 characters").regex(/[^0-9]/, "Use letters as well as numbers"),
  organization_name: z.string().min(2, "Name your workspace"),
  currency: z.string(),
});

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

export function SignupPage() {
  const afterLogin = useAfterLogin();
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: { full_name: "", email: "", password: "", organization_name: "", currency: "USD" },
  });
  const [formError, setFormError] = React.useState<string | null>(null);
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      afterLogin(await api.post<Session>("/auth/signup/", { ...values, timezone: tz }));
      toast.success("Your workspace is ready");
    } catch (err) {
      if (err instanceof ApiError) {
        for (const [field, messages] of Object.entries(err.fields)) {
          form.setError(field as keyof z.infer<typeof signupSchema>, { message: messages[0] });
        }
        if (!Object.keys(err.fields).length) setFormError(err.message);
      } else setFormError(errorMessage(err));
    }
  });
  const e = form.formState.errors;
  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="Set up your agency in under a minute. You'll be the workspace owner."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link></>}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{formError}</div>}
        <Field label="Full name" htmlFor="full_name" error={e.full_name?.message}>
          <Input id="full_name" autoComplete="name" aria-invalid={!!e.full_name} {...form.register("full_name")} />
        </Field>
        <Field label="Work email" htmlFor="email" error={e.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!e.email} {...form.register("email")} />
        </Field>
        <Field label="Password" htmlFor="password" error={e.password?.message} hint="At least 8 characters; avoid common passwords.">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!e.password} {...form.register("password")} />
        </Field>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label="Workspace name" htmlFor="organization_name" error={e.organization_name?.message}>
            <Input id="organization_name" placeholder="e.g. Northwind Studio" aria-invalid={!!e.organization_name} {...form.register("organization_name")} />
          </Field>
          <Field label="Currency" htmlFor="currency">
            <Select id="currency" {...form.register("currency")}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new password." footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      {sent ? (
        <div className="flex gap-3 rounded-md border border-success/30 bg-success-soft p-4 text-[13px] text-success" role="status">
          <CheckCircle2 className="size-5 shrink-0" /> {sent}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api.post<{ message: string }>("/auth/password-reset/", { email });
              setSent(r.message);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <AuthLayout title="Choose a new password" footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (password !== confirm) return setError("Passwords do not match.");
          setBusy(true);
          try {
            await api.post("/auth/password-reset/confirm/", { uid: params.get("uid"), token: params.get("token"), password });
            toast.success("Password updated. Please sign in.");
            navigate("/login");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{error}</div>}
        <Field label="New password" htmlFor="pw"><Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" /></Field>
        <Field label="Confirm password" htmlFor="pw2"><Input id="pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
        <Button type="submit" className="w-full" loading={busy}>Update password</Button>
      </form>
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const afterLogin = useAfterLogin();
  const info = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api.get<{ email: string; organization: string; role_label: string; account_exists: boolean }>(`/auth/invitations/${token}/`),
    enabled: Boolean(token),
    retry: false,
  });
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  if (!token || info.isError) {
    return (
      <AuthLayout title="Invitation unavailable" footer={<Link to="/login" className="font-medium text-primary hover:underline">Go to sign in</Link>}>
        <p className="text-[13px] text-muted">This invitation link is invalid, has expired or was already used. Ask the person who invited you to send a new one.</p>
      </AuthLayout>
    );
  }
  if (info.isLoading || !info.data) return <AuthLayout title="Loading invitation…"><div /></AuthLayout>;
  const d = info.data;
  return (
    <AuthLayout title={`Join ${d.organization}`} subtitle={<>You've been invited as <strong className="text-fg">{d.role_label}</strong> with {d.email}.</>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            afterLogin(await api.post<Session>(`/auth/invitations/${token}/`, d.account_exists ? { password } : { full_name: fullName, password }));
            toast.success(`Welcome to ${d.organization}`);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{error}</div>}
        {!d.account_exists && (
          <Field label="Full name" htmlFor="name"><Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus /></Field>
        )}
        <Field label={d.account_exists ? "Your existing password" : "Create a password"} htmlFor="pw" hint={d.account_exists ? "You already have an OmniManager account." : "At least 8 characters."}>
          <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>Accept invitation</Button>
      </form>
    </AuthLayout>
  );
}

export function NoWorkspacePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <AuthLayout title="You're not part of an active workspace" subtitle="Your access may have been removed. Create a new workspace or ask an administrator to invite you again.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const next = await api.post<Session>("/auth/workspaces/", { name });
            queryClient.setQueryData(SESSION_KEY, next);
            navigate("/");
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Workspace name" htmlFor="ws"><Input id="ws" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Button type="submit" className="w-full" loading={busy}>Create workspace</Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={async () => {
            await api.post("/auth/logout/");
            queryClient.setQueryData(SESSION_KEY, null);
            navigate("/login");
          }}
        >
          Sign out
        </Button>
      </form>
    </AuthLayout>
  );
}
