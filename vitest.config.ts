import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";

const srcDir = path.resolve(process.cwd(), "./src");
const migrationsDir = path.resolve(process.cwd(), "./migrations");
const fixturesDir = path.resolve(
  process.cwd(),
  "./src/domain/dial-cropper/__tests__/fixtures",
);

// Read each smoke fixture once at config-load time, encode as base64
// so it survives miniflare's JSON-serialised binding bridge, and
// expose under `TEST_FIXTURES`. The dial-cropper integration test
// inside the workers pool decodes these to ArrayBuffers and feeds
// them into `cropToDial(env)`. See src/domain/dial-cropper/cropper.test.ts.
const fixtureNames = [
  "bambino_10_19_34.jpeg",
  "greenseiko_07_56_06.jpeg",
  "sinn_10_38_29.jpeg",
  "snk803_01_07_20.jpeg",
  "snk803_10_15_40.jpeg",
  "waterbury_02_38_16.jpeg",
] as const;
const fixtureBytesB64: Record<string, string> = {};
for (const name of fixtureNames) {
  fixtureBytesB64[name] = readFileSync(path.join(fixturesDir, name)).toString("base64");
}

// Vitest is configured with two projects:
//
// 1. "workers"  — runs the cloudflare-pool tests (integration tests
//                 and the bulk of unit tests that touch any Worker
//                 binding). Spins up miniflare, applies D1
//                 migrations via TEST_MIGRATIONS, etc.
//
// 2. "node"     — runs pure-Node unit tests for modules that need
//                 filesystem access (the dial-cropper Hough fixture
//                 tests decode JPEGs from disk via jpeg-js + node:fs).
//                 These tests use the default node-pool, no
//                 workerd, no bindings.
//
// Test files opt into the node project via the `.node.test.ts`
// suffix; everything else routes to the workers project.
//
// vitest-pool-workers spins up a miniflare Worker per test run; we
// pipe the Better Auth SQL migrations in via readD1Migrations() and
// apply them in a setup file (tests/integration/setup/apply-migrations.ts)
// so every test file sees a schema-initialised D1 database. The test
// pool provides per-test-file storage isolation so no explicit reset
// is needed between files.
export default defineConfig(async (_env): Promise<ViteUserConfig> => {
  const migrations = await readD1Migrations(migrationsDir);

  const config: ViteUserConfig = {
    resolve: {
      alias: { "@": srcDir },
    },
    test: {
      coverage: {
        // Istanbul (source instrumentation) works with workerd; v8
        // requires a Node inspector Session that the Workers pool
        // does not expose.
        provider: "istanbul",
        reporter: ["text", "html", "json-summary"],
        reportsDirectory: "./coverage",
        exclude: [
          "node_modules/**",
          "dist/**",
          ".wrangler/**",
          "coverage/**",
          "tests/e2e/**",
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.config.{ts,mjs,js}",
          "worker-configuration.d.ts",
        ],
      },
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              // `remoteBindings: false` stops the pool from starting a remote-proxy
              // session for our AI binding (slice #16). AI bindings always resolve
              // remotely in production, but in tests we drive the pipeline with a
              // module-level fake (see src/domain/ai-dial-reader/runner.ts). Without
              // this flag, vitest boot hangs on a Cloudflare account-id prompt.
              remoteBindings: false,
              miniflare: {
                bindings: {
                  // Secret used by Better Auth in tests. Matches the shape
                  // the Worker expects; production secrets come from
                  // `wrangler secret put BETTER_AUTH_SECRET`.
                  BETTER_AUTH_SECRET:
                    "test-better-auth-secret-please-change-in-prod-32chars",
                  // Google OAuth — real provisioning happens via
                  // `wrangler secret put` per wrangler.jsonc comments. These
                  // test values are deliberately fake but match the shape of
                  // real creds so Better Auth's Google provider wires up at
                  // all, which is what the OAuth integration tests need.
                  GOOGLE_CLIENT_ID: "test-google-client-id",
                  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
                  // Miniflare-only. Skips the JWKS round-trip inside
                  // verifyIdToken so tests can use locally-minted unsigned
                  // JWTs. The Worker treats this as opt-in — see the env
                  // plumbing in src/server/auth.ts.
                  OAUTH_TEST_SKIP_VERIFY: "1",
                  // Slice #6 of PRD #99: HMAC secret used to sign the
                  // reading-token envelope exchanged between
                  // /readings/verified/draft and
                  // /readings/verified/confirm. Production sets this
                  // via `wrangler secret put READING_TOKEN_SECRET`;
                  // the test value is deterministic so token
                  // round-trip tests are reproducible.
                  READING_TOKEN_SECRET:
                    "test-reading-token-secret-please-change-in-prod-32+chars",
                  TEST_MIGRATIONS: migrations,
                  // Smoke fixtures for the dial-cropper integration test,
                  // base64-encoded so they survive miniflare's
                  // JSON-serialising binding bridge. Decode in the test
                  // via Uint8Array.from(atob(...), c => c.charCodeAt(0)).
                  TEST_FIXTURES: fixtureBytesB64,
                },
              },
            }),
          ],
          resolve: {
            alias: { "@": srcDir },
          },
          test: {
            name: "workers",
            include: ["tests/integration/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
            exclude: [
              "tests/e2e/**",
              "node_modules/**",
              "dist/**",
              ".wrangler/**",
              // Pure-Node tests opt into the `node` project via the
              // `.node.test.ts` suffix.
              "**/*.node.test.{ts,tsx}",
            ],
            setupFiles: ["./tests/integration/setup/apply-migrations.ts"],
            // Better Auth signup uses a slow KDF (scrypt/bcrypt equivalent).
            // Under miniflare + workerd on GitHub runners, each signup adds
            // 1-3s; tests that do signup + sign-in + API call in one test
            // exceed the 5s vitest default. 15s covers the slowest paths
            // with headroom.
            testTimeout: 15_000,
            hookTimeout: 30_000,
          },
        },
        {
          resolve: {
            alias: { "@": srcDir },
          },
          test: {
            name: "node",
            // Node-pool project: pure unit tests that need filesystem
            // (e.g. dial-cropper Hough fixture tests decoding JPEGs via
            // jpeg-js + node:fs). No workerd, no bindings.
            include: ["src/**/*.node.test.{ts,tsx}"],
            exclude: ["node_modules/**", "dist/**", ".wrangler/**"],
            // Hough on a 1024px-long-edge image is the slowest test
            // in the project (a few seconds per fixture on a fast
            // laptop, slower on a GitHub runner). 120s per test
            // covers the worst fixture (waterbury — full-res
            // 1067×980, the only one not downsampled below 1024)
            // with comfortable headroom on the smallest CI runners.
            testTimeout: 120_000,
          },
        },
      ],
    },
  };
  return config;
});
