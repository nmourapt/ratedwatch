import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The SPA lives at /src/app. The Worker owns `/`, `/api/*`, and future
// public HTML routes via run_worker_first; everything else falls through
// to the Workers Assets binding which serves the build output below.
//
// Tailwind v4 is wired via @tailwindcss/vite so its CSS engine runs at
// Vite build time. Public SSR pages keep their tokens as inlined CSS
// custom properties (see src/public/components/layout.tsx); the SPA
// consumes the same palette through the @theme block in src/app/styles.css
// so both surfaces stay visually identical without the Worker needing
// a runtime Tailwind pass.
//
// The SPA and the Worker share a worktree and the root tsconfig.json
// sets `jsxImportSource: "hono/jsx"` for the Worker's SSR. Vite's
// pre-transform scan picks up the root tsconfig before the SPA-scoped
// one (tsconfig.app.json) because Vite resolves tsconfig from the file
// upwards through the filesystem, not via project references. Passing
// `jsxImportSource: "react"` to @vitejs/plugin-react explicitly pins
// the SPA's transform to the React runtime. Without this the built
// bundle swaps React.createElement for hono/jsx's HtmlEscapedString
// factory and React throws Error #31 at render time.
export default defineConfig({
  root: path.resolve(process.cwd(), "src/app"),
  plugins: [react({ jsxImportSource: "react" }), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "./src") },
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist"),
    emptyOutDir: true,
  },
});
