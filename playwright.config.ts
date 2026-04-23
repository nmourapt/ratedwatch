import { defineConfig, devices } from "@playwright/test";

// E2E tests run against a live deploy of the Worker + SPA.
//
// Locally, run `npm run dev` in one terminal (spins up `wrangler dev`
// on :8787 plus Vite) and `npx playwright test` in another. In CI,
// the `preview` job uploads a `wrangler versions upload --preview-alias`
// deploy and exports its URL via `PLAYWRIGHT_BASE_URL`; the `e2e-smoke`
// job then consumes that.
//
// Chromium only. Firefox/WebKit add CI minutes without materially
// changing the risk profile of the flows we care about at this stage.
// Revisit once we have real cross-browser-sensitive code (camera
// capture, EXIF, CSS grid quirks).
export default defineConfig({
  testDir: "./tests/e2e",
  // The smoke tests today are small (one spec, one test) and we
  // want deterministic ordering against a single preview deploy, so
  // keep it serial. Increase later if the suite grows.
  fullyParallel: false,
  workers: 1,
  // Auth flows hit external services (Better Auth cookie signing);
  // one retry in CI absorbs the occasional cold-start flake on a
  // freshly uploaded preview version.
  retries: process.env.CI ? 1 : 0,
  // Don't let a forgotten `.only` slip into CI.
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    // HTML report is uploaded as a CI artefact on failure so we can
    // click through the trace / screenshot. `open: "never"` prevents
    // the browser from auto-launching when running locally.
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8787",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
