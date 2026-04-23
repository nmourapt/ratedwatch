// Sentry stub.
//
// Phase 1 of observability (slice #19) deliberately defers the real
// `@sentry/cloudflare` integration: the operator has not yet
// provisioned a `SENTRY_DSN` Worker secret, and the upstream package
// throws on init when the DSN is missing. We ship this tiny
// `captureException` shim today so every callsite can wire through a
// single interface; a follow-up slice swaps the implementation for
// real Sentry once the secret lands, with zero callsite churn.
//
// Interface contract: `captureException(err, ctx?)`. Synchronous,
// never throws, accepts arbitrary context as a tagged object.
// Anything that errors inside the stub itself is swallowed — this is
// error-reporting code; it must not be the source of new errors.

export interface CaptureContext {
  // Freeform tags. Keep primitives only so the eventual Sentry SDK
  // can surface them verbatim. Never include PII (email, raw request
  // bodies). See the PRD's "Privacy" section.
  [key: string]: string | number | boolean | null | undefined;
}

export function captureException(err: unknown, ctx?: CaptureContext): void {
  try {
    // Prefixed with "sentry-stub" so a grep of production logs finds
    // everything that would later land in Sentry proper, and the
    // follow-up slice can route them through the real SDK by
    // swapping this one function.
    console.error("sentry-stub: captured exception", {
      err,
      ctx: ctx ?? null,
    });
  } catch {
    // Swallow. Error-reporting code must never become the error source.
  }
}
