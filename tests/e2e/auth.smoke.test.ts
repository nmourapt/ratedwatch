import { expect, test } from "@playwright/test";

// Smoke test: register → redirect to /app/dashboard → see the slug
// username. This exercises the same happy path that integration tests
// cover in-process, but drives a real browser against a real Worker,
// so it additionally verifies:
//   - Vite-built SPA bundles are served correctly by Workers Assets
//   - React Router's client-side redirect fires on sign-up
//   - Better Auth's session cookie survives the SPA navigation to
//     /app/dashboard and is accepted by RequireAuth's /api/v1/me check
//
// Keep it ONE test. Add more e2e specs for genuinely cross-boundary
// behaviour only. Everything single-route belongs in integration tests.

// Slug format: `${adjective}-${noun}-${000..999}` — see the username
// generator hook in src/server/auth.ts. Matching loosely but strictly
// enough to catch regressions (empty username, collision-fallback UUIDs).
const SLUG_PATTERN = /^[a-z]+-[a-z]+-\d{3}$/;

test("register → redirects to dashboard → shows slug username", async ({ page }) => {
  // Unique email per run. Date.now() alone is fine because tests are
  // serial (workers: 1) and the D1 database accumulates users across
  // runs against the same preview deploy.
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${uniqueSuffix}@rated.watch.test`;
  const password = "e2e-smoke-password";
  const name = "E2E Smoke User";

  await page.goto("/app/register");

  // Fill the form. Using labels is more resilient than classnames.
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);

  await page.getByRole("button", { name: /create account/i }).click();

  // Expect the post-register redirect. `waitForURL` is a hard assertion.
  await page.waitForURL("**/app/dashboard", { timeout: 15_000 });

  // Dashboard shows `Logged in as @<slug>`. `.text-accent` is the
  // span wrapping the slug; grab it by the on-screen copy so we're not
  // coupled to CSS.
  const loggedInLine = page.getByText(/^Logged in as @/);
  await expect(loggedInLine).toBeVisible();

  const lineText = (await loggedInLine.textContent())?.trim() ?? "";
  // The dashboard renders "Logged in as @<slug>." with a trailing full
  // stop. Capture the slug *without* the punctuation — using `\S+`
  // would eat the `.` because `\.?$` is optional and non-greedy doesn't
  // help here (backtracking still prefers the greedy match).
  const match = /^Logged in as @(?<slug>[a-z0-9-]+)\.?\s*$/i.exec(lineText);
  expect(match, `"${lineText}" should match "Logged in as @<slug>"`).not.toBeNull();
  const slug = match!.groups!.slug!;
  expect(slug).toMatch(SLUG_PATTERN);
});
