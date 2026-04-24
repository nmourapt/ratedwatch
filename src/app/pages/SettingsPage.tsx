// Settings screen. Current slice only lets the user rename their
// username; email change, password change, and account deletion land
// in later (currently unplanned) slices.
//
// The form validates client-side with the same `updateMeSchema` used
// by the server, so inline errors match what the API would return
// and we avoid a round-trip for obviously-bad input. Server-side
// errors (duplicate username, invalid input we somehow let through,
// expired session) are surfaced beneath the field too.

import { type FormEvent, useEffect, useState } from "react";
import { updateMeSchema, formatUpdateMeErrors } from "@/schemas/user";
import { updateMe } from "../auth/api";
import { useSession } from "../auth/useSession";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function SettingsPage() {
  const { status: sessionStatus, user, refresh } = useSession();
  const [username, setUsername] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Pre-fill the editable username input once the session resolves.
  // We only sync when the backing user changes, so subsequent edits
  // aren't clobbered by re-renders.
  useEffect(() => {
    if (user?.username) {
      setUsername(user.username);
    }
  }, [user?.username]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldError(null);

    // Client-side validation against the shared Zod schema.
    const parsed = updateMeSchema.safeParse({ username });
    if (!parsed.success) {
      const errors = formatUpdateMeErrors(parsed.error);
      setFieldError(errors.username ?? "Invalid username");
      setStatus({ kind: "idle" });
      return;
    }

    setStatus({ kind: "submitting" });
    const result = await updateMe({ username: parsed.data.username });
    if (!result.ok) {
      const fieldMsg = result.error.fieldErrors?.username;
      if (fieldMsg) {
        setFieldError(fieldMsg);
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "error", message: result.error.message });
      return;
    }

    // Show the server-confirmed username (trimmed to match server
    // behaviour) and refresh the session so the dashboard reflects
    // the change on next navigation.
    setUsername(result.user.username ?? parsed.data.username);
    setStatus({ kind: "success", message: "Username updated" });
    void refresh();
  }

  return (
    <section className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-4xl font-medium tracking-tight text-ink">Settings</h1>

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Email
          <input
            type="email"
            readOnly
            value={user?.email ?? ""}
            className="rounded-md border border-line bg-surface px-3 py-2 font-sans text-base text-ink-muted outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Username
          <input
            type="text"
            name="username"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            minLength={2}
            maxLength={30}
            disabled={sessionStatus !== "authed" || status.kind === "submitting"}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              if (fieldError) setFieldError(null);
              if (status.kind === "success" || status.kind === "error") {
                setStatus({ kind: "idle" });
              }
            }}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "username-error" : undefined}
            className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
          />
          {fieldError ? (
            <span id="username-error" role="alert" className="text-sm text-accent">
              {fieldError}
            </span>
          ) : (
            <span className="text-sm text-ink-muted">
              2–30 characters. Letters, numbers, <code>_</code>, <code>.</code>,{" "}
              <code>-</code>.
            </span>
          )}
        </label>

        {status.kind === "error" ? (
          <p
            role="alert"
            className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
          >
            {status.message}
          </p>
        ) : null}
        {status.kind === "success" ? (
          <p
            role="status"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            {status.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={
            sessionStatus !== "authed" ||
            status.kind === "submitting" ||
            username.trim() === (user?.username ?? "")
          }
          className="mt-2 inline-flex items-center justify-center self-start rounded-full bg-accent px-6 py-3 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {status.kind === "submitting" ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}
