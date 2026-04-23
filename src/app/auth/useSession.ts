// Client-side session hook. Polls `/api/v1/me` once on mount and
// exposes `{ status, user, refresh }` so pages can render a loading
// state, an anonymous state, or the authenticated user's data.
//
// Kept intentionally minimal — no SWR / react-query dependency; the
// session is fetched at most a couple of times in a normal SPA
// lifecycle (mount, after sign-in/out), so a plain useEffect is fine.

import { useCallback, useEffect, useState } from "react";
import { fetchMe, type MeResponse } from "./api";

export type SessionStatus = "loading" | "authed" | "anonymous";

export interface UseSessionResult {
  status: SessionStatus;
  user: MeResponse | null;
  refresh: () => Promise<void>;
}

export function useSession(): UseSessionResult {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      if (me) {
        setUser(me);
        setStatus("authed");
      } else {
        setUser(null);
        setStatus("anonymous");
      }
    } catch {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, user, refresh };
}
