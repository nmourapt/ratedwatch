// Session gate. Loads the Better Auth session (cookie or bearer token)
// and sets `c.var.user` + `c.var.session`. On miss it returns a 401
// JSON response so API consumers (the SPA, the future Expo client)
// can uniformly treat "not authed" as an error shape.
//
// The middleware is generic over the bindings because different routes
// may have different Env extensions, but all of them must carry the
// Better Auth prerequisites (DB + BETTER_AUTH_SECRET).

import type { MiddlewareHandler } from "hono";
import { getAuth, type Auth, type AuthEnv } from "@/server/auth";

type SessionUser =
  ReturnType<Auth["api"]["getSession"]> extends Promise<infer R>
    ? R extends null
      ? never
      : R extends { user: infer U }
        ? U
        : never
    : never;

type SessionObject =
  ReturnType<Auth["api"]["getSession"]> extends Promise<infer R>
    ? R extends null
      ? never
      : R extends { session: infer S }
        ? S
        : never
    : never;

export interface RequireAuthVariables {
  user: SessionUser;
  session: SessionObject;
}

export const requireAuth: MiddlewareHandler<{
  Bindings: AuthEnv & { [key: string]: unknown };
  Variables: RequireAuthVariables;
}> = async (c, next) => {
  const auth = getAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("user", session.user as SessionUser);
  c.set("session", session.session as SessionObject);
  await next();
  return;
};
