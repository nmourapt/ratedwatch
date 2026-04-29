import { expect, test } from "@playwright/test";

// Slice #7 of PRD #99 (issue #106). Confirmation page DOM tests.
//
// The confirmation page is the anti-cheat heart of the verified-
// reading flow: after the user uploads a photo, they see the VLM's
// predicted MM:SS and adjust ± seconds before confirming. The page
// MUST NEVER show the deviation, because seeing the deviation lets
// the user dial up to "make their watch look perfect".
//
// Why we route-mock /draft and /confirm here:
//
//   * /draft normally calls a real OpenAI VLM via Cloudflare AI
//     Gateway. That round-trip costs money, has variable latency,
//     and depends on a fixture having a recent EXIF timestamp (the
//     verifier rejects EXIF older than 5 min as `exif_clock_skew`).
//     Strapping a fixture on the SPA's resize pipeline that happens
//     to land inside the bounds window is fragile.
//
//   * /confirm normally writes a row to D1 + moves a photo on R2,
//     polluting the preview's state. We're testing the SPA, not
//     the route.
//
// Mocking both gives us a deterministic harness that exercises the
// real React component, the real CSS, and the real router. The
// route handlers themselves are covered by the integration suite
// in `tests/integration/readings.verified.test.ts`.

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

function tinyPngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

test("verified-reading confirmation: deviation never rendered, ± buttons adjust seconds, confirm posts user-adjusted MM:SS", async ({
  page,
}) => {
  // Pre-flight: the preview's movements taxonomy must be live, same
  // as the existing verified-reading.smoke test.
  const healthRes = await page.request.get("/api/v1/movements?q=eta");
  if (healthRes.status() !== 200) {
    throw new Error(
      `Movements API returned ${healthRes.status()} for ?q=eta. ` +
        "Operator needs to run `wrangler d1 migrations apply rated-watch-db --remote` " +
        "before the preview deploy can serve the add-watch flow.",
    );
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-confirm-${uniqueSuffix}@rated.watch.test`;
  const password = "e2e-smoke-password";
  const name = "E2E Confirm User";
  const watchName = `Confirm smoke ${uniqueSuffix}`;

  // ---- Route-mock /draft and /confirm BEFORE registering ----------
  //
  // We register a fake reading_token (the SPA only uses it as an
  // opaque string to echo back at /confirm) and a placeholder photo
  // URL. The placeholder URL points at a 1×1 PNG inline data URL so
  // the <img> renders something visible without hitting R2.
  //
  // Captured state lets the test assert the SPA POSTs the user-
  // adjusted final_mm_ss, not the predicted MM:SS.
  const FAKE_TOKEN = "fake-token.fake-sig";
  const PREDICTED = { m: 19, s: 34 };
  const PHOTO_DATA_URL =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

  let draftCalls = 0;
  await page.route("**/api/v1/watches/**/readings/verified/draft", (route) => {
    draftCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reading_token: FAKE_TOKEN,
        predicted_mm_ss: PREDICTED,
        photo_url: PHOTO_DATA_URL,
        hour_from_server_clock: 14,
        reference_source: "server",
        expires_at_unix: Math.floor(Date.now() / 1000) + 300,
      }),
    });
  });

  let confirmBody: {
    reading_token: string;
    final_mm_ss: { m: number; s: number };
    is_baseline?: boolean;
  } | null = null;
  await page.route("**/api/v1/watches/**/readings/verified/confirm", async (route) => {
    const req = route.request();
    const raw = req.postData();
    confirmBody = raw ? JSON.parse(raw) : null;
    // Return a plausible reading row. The SPA's parent panel
    // (`WatchDetailPage`) calls `reloadReadings()` after the
    // confirm; we don't need to mock that — `reloadReadings`
    // hits the real /readings endpoint which returns whatever
    // is in D1 (empty in this case, which is fine — the panel
    // still renders).
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "fake-reading-id",
        watch_id: "fake-watch-id",
        user_id: "fake-user-id",
        reference_timestamp: Date.now(),
        deviation_seconds: 0,
        is_baseline: false,
        verified: true,
        notes: null,
        created_at: new Date().toISOString(),
      }),
    });
  });

  // ---- 1. Register + add a watch ---------------------------------
  await page.goto("/app/register");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/app/dashboard", { timeout: 15_000 });

  await page.getByRole("link", { name: "Add watch", exact: true }).click();
  await page.waitForURL("**/app/watches/new", { timeout: 10_000 });

  await page.getByLabel("Name").fill(watchName);
  const movementInput = page.getByLabel("Movement");
  await movementInput.fill("ETA");
  const option = page.getByRole("listbox").getByText(/^ETA 2824-2$/);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await page.getByRole("button", { name: /add watch/i }).click();
  await page.waitForURL(/\/app\/watches\/[^/]+$/, { timeout: 15_000 });

  // ---- 2. Verified-reading panel renders -------------------------
  const panel = page.getByRole("region", { name: "Verified reading" });
  await expect(panel).toBeVisible();

  // ---- 3. Choose a file, submit → /draft fires → confirm renders -
  const fileInput = panel.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "dial.png",
    mimeType: "image/png",
    buffer: tinyPngBuffer(),
  });
  await panel.getByRole("button", { name: /submit verified reading/i }).click();

  const confirmation = panel.getByTestId("verified-reading-confirmation");
  await expect(confirmation).toBeVisible({ timeout: 15_000 });
  expect(draftCalls).toBe(1);

  // Photo is rendered inline — anything in the <img src> is fine,
  // the data-URL we returned in the mock or any other URL would do.
  await expect(confirmation.getByTestId("confirmation-photo")).toBeVisible();

  // Prediction display shows the predicted MM:SS verbatim.
  const predictionEl = confirmation.getByTestId("prediction-mm-ss");
  await expect(predictionEl).toContainText("19");
  await expect(predictionEl).toContainText("34");

  // ---- 4. Anti-cheat DOM probe -----------------------------------
  //
  // Critical assertion. The whole point of the slice is that the
  // user can't see "you're +5s ahead" or similar — the deviation
  // is server-internal until /confirm saves and the user reaches
  // the readings list. If a future refactor accidentally renders
  // the deviation here, this assertion fails and CI blocks the
  // change.
  await expect(confirmation.locator('[data-testid="deviation"]')).toHaveCount(0);
  await expect(confirmation.getByText(/drift|deviation|[+-]\d+\s*s\b/i)).toHaveCount(0);

  // ---- 5. ± buttons adjust seconds in 1s steps -------------------
  const plusBtn = confirmation.getByTestId("confirmation-plus");
  for (let i = 0; i < 4; i += 1) {
    await plusBtn.click();
  }
  // After 4 clicks: 34 → 35 → 36 → 37 → 38. The minutes display
  // should still be "19".
  await expect(confirmation.getByTestId("confirmation-seconds")).toHaveText("38");
  await expect(confirmation.getByTestId("confirmation-minutes")).toHaveText("19");

  // The "± X / 30 used" counter ticked along.
  await expect(confirmation.getByTestId("confirmation-clicks-used")).toContainText("4");

  // ---- 6. Confirm posts the user-adjusted MM:SS ------------------
  await confirmation.getByTestId("confirmation-confirm").click();

  // Wait for the success banner to swap in (the parent component
  // transitions to `success` once /confirm returns 201).
  await expect(panel.getByRole("status")).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole("status")).toContainText(/saved/i);

  // The mock captured the POST body — assert the SPA sent the
  // user-adjusted MM:SS, not the predicted one.
  expect(confirmBody).not.toBeNull();
  expect(confirmBody!.reading_token).toBe(FAKE_TOKEN);
  expect(confirmBody!.final_mm_ss).toEqual({ m: 19, s: 38 });
});
