// Sign-in screen. Posts to /api/v1/auth/sign-in/email and redirects
// to the dashboard on success. No "remember me" UI yet — Better
// Auth's default (remember) is on, which is the right choice for a
// hobbyist accuracy-tracking app.

import { type FormEvent, useState } from "react";
import { useNavigate, Link } from "react-router";
import { login } from "../auth/api";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await login({ email, password });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    navigate("/app/dashboard", { replace: true });
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="mb-6 text-4xl font-medium tracking-tight text-cf-text">Sign in</h1>
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
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
            autoComplete="current-password"
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
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-6 text-sm text-cf-text-muted">
        New here?{" "}
        <Link to="/app/register" className="text-cf-orange hover:underline">
          Create an account
        </Link>
        .
      </p>
    </section>
  );
}
