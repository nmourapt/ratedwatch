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
