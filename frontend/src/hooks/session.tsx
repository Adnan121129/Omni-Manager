import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { api, ApiError } from "@/lib/api";
import { setDisplayTimeZone } from "@/lib/format";
import type { Organization, Permissions, Session } from "@/lib/types";

export const SESSION_KEY = ["session"] as const;

async function fetchSession(): Promise<Session | null> {
  try {
    return await api.get<Session>("/auth/me/");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
    throw err;
  }
}

export function useSessionQuery() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 5 * 60 * 1000, retry: 1 });
}

interface AuthContextValue {
  session: Session;
  org: Organization;
  permissions: Permissions;
  user: Session["user"];
  isClient: boolean;
  setSession: (s: Session | null) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    setDisplayTimeZone(session.user.timezone || session.organization?.timezone);
  }, [session.user.timezone, session.organization?.timezone]);
  const value = React.useMemo<AuthContextValue>(
    () => ({
      session,
      org: session.organization!,
      permissions: session.permissions!,
      user: session.user,
      isClient: Boolean(session.permissions?.is_client),
      setSession: (s) => queryClient.setQueryData(SESSION_KEY, s),
    }),
    [session, queryClient],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an authenticated route");
  return ctx;
}

export function useOptionalAuth(): AuthContextValue | null {
  return React.useContext(AuthContext);
}
