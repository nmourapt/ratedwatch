import { expect, test } from "@playwright/test";

// Smoke test for the full add-watch flow:
//
//   register → /app/watches/new → type a movement query →
//   pick a match from the typeahead → submit → assert the new
//   watch is visible on /app/dashboard.
//
// This exercises slices 4 (auth), 7 (movements taxonomy), and 8
// (watches CRUD + SPA pages) end-to-end against a real Worker, so
// it additionally verifies:
//   * The movements seed is present on the preview D1 database
//     (so the typeahead returns something for "ETA"). IMPORTANT:
//     migrations 0002 (movements) + 0003 (watches) must have run
//     against the production D1 before this test can pass on a
//     preview — preview deploys reuse the prod D1. The PR body
//     calls this out as a pre-merge operator action.
//   * The SPA's dashboard re-fetches after a post-submit redirect
//     (the new watch really is persisted, not just a render-local
//     optimistic state).
//
// Keep it ONE test. Single-route behaviour belongs in integration
// tests; this file exists only to prove the pieces hang together
// across the browser boundary.

test("register → add watch via typeahead → dashboard shows it", async ({ page }) => {
  // Early check: ensure the movements taxonomy is reachable before we
  // waste minutes driving a full register + form fill. On a preview
  // deploy whose D1 hasn't had migration 0002 applied, this call
  // returns 500 and the typeahead will never populate.
  const healthRes = await page.request.get("/api/v1/movements?q=eta");
  if (healthRes.status() !== 200) {
    throw new Error(
      `Movements API returned ${healthRes.status()} for ?q=eta. ` +
        "Operator needs to run `wrangler d1 migrations apply rated-watch-db --remote` " +
        "before the preview deploy can serve the add-watch flow.",
    );
  }
  const healthBody = (await healthRes.json()) as {
    approved: Array<{ id: string; canonical_name: string }>;
  };
  if (!healthBody.approved.some((m) => m.canonical_name === "ETA 2824-2")) {
    throw new Error(
      "Movements taxonomy is reachable but does not include ETA 2824-2. " +
        "Run `npm run db:seed:movements` against the production D1 before " +
        "this E2E can pass.",
    );
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-watch-${uniqueSuffix}@rated.watch.test`;
  const password = "e2e-smoke-password";
  const name = "E2E Watches User";
  const watchName = `Smoke watch ${uniqueSuffix}`;

  // ---- 1. Register + arrive on dashboard --------------------------
  await page.goto("/app/register");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/app/dashboard", { timeout: 15_000 });

  // ---- 2. Navigate to the add-watch form --------------------------
  // Two "add" links can appear: the top-right "Add watch" CTA and the
  // empty-state "Add your first watch" link. `name: "Add watch"` is an
  // exact match on the accessible name and only picks the top CTA.
  await page.getByRole("link", { name: "Add watch", exact: true }).click();
  await page.waitForURL("**/app/watches/new", { timeout: 10_000 });

  // ---- 3. Fill the form + pick a movement from the typeahead ------
  await page.getByLabel("Name").fill(watchName);

  const movementInput = page.getByLabel("Movement");
  await movementInput.fill("ETA");

  // The listbox renders approved movements asynchronously. Wait for
  // a concrete match; "ETA 2824-2" is a seeded approved row that
  // ships with the taxonomy.
  const option = page.getByRole("listbox").getByText(/^ETA 2824-2$/);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();

  // After selection, the typeahead swaps to the read-only pill.
  await expect(page.getByText("ETA 2824-2")).toBeVisible();

  // ---- 4. Submit and land on the detail page ----------------------
  await page.getByRole("button", { name: /add watch/i }).click();
  await page.waitForURL(/\/app\/watches\/[^/]+$/, { timeout: 15_000 });

  // Detail page shows the watch name and the movement.
  await expect(page.getByRole("heading", { level: 1, name: watchName })).toBeVisible();

  // ---- 5. Back to dashboard — the card is there -------------------
  await page.getByRole("link", { name: /← back to dashboard/i }).click();
  await page.waitForURL("**/app/dashboard", { timeout: 10_000 });
  await expect(page.getByRole("heading", { level: 2, name: watchName })).toBeVisible();
});
