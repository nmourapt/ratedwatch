// Shared "Continue with Google" button for the /app/login and
// /app/register screens. Kicks off Better Auth's redirect flow via
// signInWithGoogle() in ../auth/api.ts: the Worker returns a Google
// authorization URL, we navigate the window there, Google bounces
// back to /api/v1/auth/callback/google, Better Auth finalises the
// session cookie and redirects us to /app/dashboard.
//
// The button visually matches the warm cream/coral palette already in
// use by the email-password primary action (see LoginPage /
// RegisterPage). Google's brand guidelines allow either a white or
// coloured surface so long as the mark stays in its brand colours.
// We keep the background warm (canvas) and use the official Google
// SVG in its multi-colour form; the surrounding text is ink.

import { useState } from "react";
import { signInWithGoogle } from "../auth/api";

interface Props {
  label?: string;
  className?: string;
}

export function GoogleSignInButton({
  label = "Continue with Google",
  className = "",
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setSubmitting(true);
    setError(null);
    const result = await signInWithGoogle();
    // In the happy path the Worker sends us a redirect URL and we
    // navigate away — nothing below this line runs. If the provider
    // isn't configured (preview without secrets) or Google rejected
    // the request, we surface a friendly message inline instead of
    // hanging with a spinning button.
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error.message);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={submitting}
        aria-label={label}
        className={
          "inline-flex min-h-[44px] items-center justify-center gap-3 rounded-pill border " +
          "border-line bg-canvas px-6 py-3 text-sm font-medium " +
          "text-ink shadow-card transition-colors transition-shadow " +
          "hover:border-ink-muted hover:text-ink hover:shadow-lift " +
          "disabled:opacity-60 " +
          className
        }
      >
        {/* Google "G" logo — inline SVG so we don't need a build-time asset. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          width="18"
          height="18"
          className="shrink-0"
        >
          <path
            fill="#FFC107"
            d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
          />
          <path
            fill="#FF3D00"
            d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
          />
          <path
            fill="#4CAF50"
            d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
          />
          <path
            fill="#1976D2"
            d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
          />
        </svg>
        {submitting ? "Redirecting…" : label}
      </button>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
