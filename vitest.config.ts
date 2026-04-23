import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

const srcDir = path.resolve(process.cwd(), "./src");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  resolve: {
    alias: { "@": srcDir },
  },
  test: {
    include: ["tests/integration/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**", ".wrangler/**"],
    coverage: {
      // Istanbul (source instrumentation) works with workerd; v8 requires
      // a Node inspector Session that the Workers pool does not expose.
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
});
