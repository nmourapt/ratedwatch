// Better Auth configuration for rated.watch.
//
// Slice 4 wired email + password. Slice 5 adds Google OAuth via Better
// Auth's built-in Google provider, driven by two Worker secrets:
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. When those aren't set
// (local dev without `.dev.vars`, or a preview without provisioned
// secrets), we skip registering the provider so the Worker still boots
// and email+password flows continue to work — an OAuth sign-in attempt
// in that state returns Better Auth's "provider not found" 404, which
// is a fine failure mode for an unconfigured preview.
//
// Account collisions — i.e. a user already has an email/password
// account and tries to register via Google with the same email — are
// REJECTED rather than implicitly linked. The slice 5 acceptance
// criteria explicitly call this out: "A user cannot register the same
// email via Google without explicit linking." Account-linking UI is a
// later slice if we ever ship it.
//
// The D1 binding is passed as the `database` value; Better Auth's
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

// We keep `Auth` a loose alias of betterAuth's return type. Using
// `ReturnType<typeof betterAuth>` directly was flaky: tsc kept
// widening the options generic so the cached value didn't assign back.
// `any` on the generic arg lets consumers hold a reference without
// fighting the generic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Auth = ReturnType<typeof betterAuth<any>>;

// Narrow env shape we need. Keeps the module unit-testable without
// pulling in the entire generated Cloudflare Env. Google creds are
// optional — see module docblock.
export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Miniflare-only. When truthy (e.g. "1"), the Google provider's
  // verifyIdToken returns `true` without contacting Google's JWKS.
  // This is the hook that lets integration tests mint locally-unsigned
  // JWTs and still exercise the full sign-in-with-ID-token code path.
  // Never set this binding in production — wrangler.jsonc does not.
  OAUTH_TEST_SKIP_VERIFY?: string;
}

const cache = new WeakMap<AuthEnv, Auth>();

export function getAuth(env: AuthEnv): Auth {
  const cached = cache.get(env);
  if (cached) return cached;

  // Build the socialProviders block only when we have real Google
  // credentials. Passing `undefined` through leaves the registry empty,
  // which is what Better Auth expects for "feature not enabled".
  const googleProvider =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          // Test-only override. Production leaves this undefined so
          // Better Auth falls back to the stock Google JWKS verifier.
          ...(env.OAUTH_TEST_SKIP_VERIFY
            ? {
                verifyIdToken: async (): Promise<boolean> => true,
              }
            : {}),
        }
      : undefined;

  const auth: Auth = betterAuth({
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
    // Reject email collisions between providers. Without this Better
    // Auth would implicitly link a Google sign-in to an existing
    // email/password user because Google marks the email as verified.
    // The slice 5 acceptance criteria require rejection instead;
    // account-linking is a conscious follow-up.
    account: {
      accountLinking: {
        enabled: false,
      },
    },
    ...(googleProvider ? { socialProviders: { google: googleProvider } } : {}),
    user: {
      // Custom `username` slug on the user row. `input: false` keeps
      // clients from setting it during sign-up; the before-create hook
      // below always overwrites it with a unique server-minted value.
      // `required: false` at the API level — the database column is
      // NOT NULL (migrations/0001_init.sql) and the hook guarantees
      // every user row gets one.
      //
      // The hook fires for OAuth sign-ups too: Better Auth routes
      // every new user row through the same `internalAdapter.createUser`
      // path (see node_modules/better-auth/dist/db/internal-adapter.mjs)
      // whether the origin is email/password or a social provider. The
      // OAuth tests in tests/integration/auth.oauth.test.ts assert the
      // generated slug shape explicitly to guard against regressions.
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
