// Registration screen. Posts to /api/v1/auth/sign-up/email — Better
// Auth's default `autoSignIn` is on, so a successful sign-up already
// yields a session cookie and we can jump straight to the dashboard.
// The display-name input maps to Better Auth's required `name` field;
// the slug `username` is server-generated, so we don't expose it here.

import { type FormEvent, useState } from "react";
import { useNavigate, Link } from "react-router";
import { register } from "../auth/api";
import { GoogleSignInButton } from "../components/GoogleSignInButton";

export function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await register({ name, email, password });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    navigate("/app/dashboard", { replace: true });
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="mb-2 text-4xl font-medium tracking-tight text-cf-text">
        Create an account
      </h1>
      <p className="mb-6 text-cf-text-muted">
        You'll get an auto-generated username you can rename later.
      </p>
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <label className="flex flex-col gap-1 text-sm font-medium text-cf-text">
          Display name
          <input
            type="text"
            autoComplete="name"
            required
            minLength={1}
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-cf-border bg-cf-bg-100 px-3 py-2 font-sans text-base text-cf-text outline-none focus:border-cf-orange"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-cf-text">
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-md border border-cf-border bg-cf-bg-100 px-3 py-2 font-sans text-base text-cf-text outline-none focus:border-cf-orange"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-cf-text">
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-md border border-cf-border bg-cf-bg-100 px-3 py-2 font-sans text-base text-cf-text outline-none focus:border-cf-orange"
          />
        </label>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-cf-orange/40 bg-cf-orange/10 px-3 py-2 text-sm text-cf-text"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="mt-2 inline-flex items-center justify-center rounded-full bg-cf-orange px-6 py-3 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-cf-orange-hover disabled:opacity-60"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
      {/* OAuth divider + Google button. Decorative divider, so
          screen readers hear only the two primary actions. */}
      <div
        className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-cf-text-muted"
        aria-hidden="true"
      >
        <span className="h-px flex-1 bg-cf-border" />
        <span>or</span>
        <span className="h-px flex-1 bg-cf-border" />
      </div>
      <GoogleSignInButton label="Continue with Google" />
      <p className="mt-6 text-sm text-cf-text-muted">
        Already have an account?{" "}
        <Link to="/app/login" className="text-cf-orange hover:underline">
          Sign in
        </Link>
        .
      </p>
    </section>
  );
}
