// Better Auth configuration for rated.watch.
//
// Slice 4 wires email + password only. OAuth providers arrive in slice
// 5. The D1 binding is passed as the `database` value; Better Auth's
// Kysely adapter auto-detects it by shape (batch + exec + prepare) and
// builds its own D1SqliteDialect internally — see
// node_modules/@better-auth/kysely-adapter/dist/index.mjs.
//
// Because the D1 binding is per-request, the Better Auth instance
// itself is built per-request too. `getAuth(env)` memoises per-env so
// a single Worker request only pays the wiring cost once even if
// several middlewares call it.

import { betterAuth } from "better-auth";
import { createDb } from "@/db";
import { generateSlugUsername } from "@/domain/username";

export type Auth = ReturnType<typeof betterAuth>;

// Narrow env shape we need. Keeps the module unit-testable without
// pulling in the entire generated Cloudflare Env.
export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
}

const cache = new WeakMap<AuthEnv, Auth>();

export function getAuth(env: AuthEnv): Auth {
  const cached = cache.get(env);
  if (cached) return cached;

  const auth = betterAuth({
    // Secret used for cookie signing. Provided via Worker secret in
    // production; the test harness seeds a high-entropy value via
    // miniflare bindings (see vitest.config.ts).
    secret: env.BETTER_AUTH_SECRET,
    // Auth API is mounted under the versioned API path alongside the
    // rest of our app's v1 endpoints.
    basePath: "/api/v1/auth",
    // D1 binding. Better Auth's Kysely adapter auto-detects the D1
    // shape and builds a SqliteDialect for it.
    database: env.DB,
    // In Workers we always cross HTTPS, and SPA/API share the same
    // origin, so Lax is safe and strict-enough to protect against
    // CSRF. No need to relax cookies for cross-subdomain here.
    advanced: {
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
      },
    },
    emailAndPassword: {
      enabled: true,
    },
    user: {
      // Custom `username` slug on the user row. `input: false` keeps
      // clients from setting it during sign-up; the before-create hook
      // below always overwrites it with a unique server-minted value.
      // `required: false` at the API level — the database column is
      // NOT NULL (migrations/0001_init.sql) and the hook guarantees
      // every user row gets one.
      additionalFields: {
        username: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const db = createDb(env);
            const username = await generateSlugUsername({
              exists: async (candidate) => {
                const row = await db
                  .selectFrom("user")
                  .select("id")
                  .where("username", "=", candidate)
                  .executeTakeFirst();
                return row !== undefined;
              },
            });
            return { data: { ...user, username } };
          },
        },
      },
    },
  });

  cache.set(env, auth);
  return auth;
}
