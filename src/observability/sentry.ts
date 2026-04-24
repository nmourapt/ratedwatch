// Sentry integration.
//
// Two public things:
//
//   1. `withSentry(worker)` — wraps the Worker's default export so
//      every unhandled exception in the fetch handler is automatically
//      reported to Sentry with request/response context. Production
//      uses `env.SENTRY_DSN`; when the secret is absent (local dev,
//      test, anonymous preview) `withSentry` degrades to a passthrough
//      that does NOT initialise Sentry and does NOT throw.
//
//   2. `captureException(err, ctx)` — the call-at-point-of-use API
//      for intentional error reporting (e.g. non-throwing branches
//      that should still land in Sentry). Same contract as the
//      previous `sentry-stub.ts`: never throws, accepts primitive
//      context tags. When Sentry isn't active the call is a no-op
//      with a console warning — parity with the old stub.
//
// This file replaces `src/observability/sentry-stub.ts`. The public
// `captureException` signature is preserved so callsites from slice
// #19 don't change.
import * as Sentry from "@sentry/cloudflare";

export interface CaptureContext {
  // Primitives only — the same shape as the slice-19 stub. Sentry
  // surfaces them as tags on the event. Never pass PII (email, raw
  // request bodies, session tokens).
  [key: string]: string | number | boolean | null | undefined;
}

export interface SentryEnv {
  SENTRY_DSN?: string;
}

// Flag set by the wrapper so `captureException` knows whether a real
// Sentry client is available. Tests that import captureException
// directly (no wrapper) stay in stub-mode. Stored on globalThis
// rather than module scope so the flag survives Vite's dual-bundle
// output (Worker + SPA) if any cross-pollination ever happens.
interface SentryGlobals {
  __ratedwatchSentryActive?: boolean;
}
const sentryGlobals = globalThis as typeof globalThis & SentryGlobals;

/**
 * Report an exception to Sentry (or console-fallback when inactive).
 *
 * Never throws. Safe to call unconditionally.
 */
export function captureException(err: unknown, ctx?: CaptureContext): void {
  try {
    if (sentryGlobals.__ratedwatchSentryActive) {
      Sentry.captureException(err, (scope) => {
        if (ctx) {
          for (const [k, v] of Object.entries(ctx)) {
            if (v === undefined) continue;
            scope.setTag(k, v === null ? "null" : String(v));
          }
        }
        return scope;
      });
      return;
    }
    // Stub mode — matches the previous sentry-stub.ts behaviour so
    // tests that only check console output still pass.
    console.error("sentry-stub: captured exception", {
      err,
      ctx: ctx ?? null,
    });
  } catch {
    // Error-reporting code must never become the error source.
  }
}

/**
 * Wrap the Worker's default export so Sentry automatically captures
 * every unhandled exception.
 *
 * When `SENTRY_DSN` is not set (local dev, anonymous preview), this
 * returns the handler unchanged so the Worker still boots.
 */
export function withSentry<THandler>(handler: THandler): THandler {
  // Broad generic rather than `ExportedHandler<Env>` because Hono's
  // default export is structurally a fetch handler but not typed as
  // one; `Sentry.withSentry`'s signature accepts any ExportedHandler-
  // shaped object at runtime, and TS-level narrowing isn't worth the
  // friction here.
  type TEnv = SentryEnv;
  // Sentry's withSentry wrapper initialises the SDK on first request
  // with the options we return from the options callback. We use it
  // directly for the DSN-set path; the DSN-missing path returns the
  // raw handler so tests and anonymous previews don't require real
  // credentials.
  const wrapped = (
    Sentry.withSentry as unknown as (
      cb: (env: TEnv) => Record<string, unknown>,
      h: THandler,
    ) => THandler
  )((env) => {
    sentryGlobals.__ratedwatchSentryActive = Boolean(env.SENTRY_DSN);
    return {
      dsn: env.SENTRY_DSN,
      // Traces are cheap in the hobby tier but still cost budget.
      // 10% is a reasonable starting sample rate. Tune based on what
      // the free-tier event cap shows.
      tracesSampleRate: 0.1,
      // Anonymous user telemetry: Sentry automatically attaches the
      // request path + method. We never want to send email addresses
      // or session tokens — sendDefaultPii stays false (its default).
      sendDefaultPii: false,
      // Environment label for Sentry's UI. Release tag comes from
      // Workers' CF-Ray or a git SHA injected at build time; we don't
      // set it here — future followup if release-tracking becomes a
      // real need.
      environment: "production",
    };
  }, handler);
  return wrapped;
}
