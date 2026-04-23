import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import path from "node:path";

const srcDir = path.resolve(process.cwd(), "./src");
const migrationsDir = path.resolve(process.cwd(), "./migrations");

// vitest-pool-workers spins up a miniflare Worker per test run; we
// pipe the Better Auth SQL migrations in via readD1Migrations() and
// apply them in a setup file (tests/integration/setup/apply-migrations.ts)
// so every test file sees a schema-initialised D1 database. The test
// pool provides per-test-file storage isolation so no explicit reset
// is needed between files.
export default defineConfig(async (_env): Promise<ViteUserConfig> => {
  const migrations = await readD1Migrations(migrationsDir);

  const config: ViteUserConfig = {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Secret used by Better Auth in tests. Matches the shape
            // the Worker expects; production secrets come from
            // `wrangler secret put BETTER_AUTH_SECRET`.
            BETTER_AUTH_SECRET: "test-better-auth-secret-please-change-in-prod-32chars",
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
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    resolve: {
      alias: { "@": srcDir },
    },
    test: {
      include: ["tests/integration/**/*.test.ts", "src/**/*.test.ts"],
      exclude: ["tests/e2e/**", "node_modules/**", "dist/**", ".wrangler/**"],
      setupFiles: ["./tests/integration/setup/apply-migrations.ts"],
      // Better Auth signup uses a slow KDF (scrypt/bcrypt equivalent).
      // Under miniflare + workerd on GitHub runners, each signup adds
      // 1-3s; tests that do signup + sign-in + API call in one test
      // exceed the 5s vitest default. 15s covers the slowest paths
      // with headroom.
      testTimeout: 15_000,
      hookTimeout: 30_000,
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
    },
  };
  return config;
});
