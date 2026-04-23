import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The SPA lives at /src/app. The Worker owns `/`, `/api/*`, and future
// public HTML routes via run_worker_first; everything else falls through
// to the Workers Assets binding which serves the build output below.
export default defineConfig({
  root: path.resolve(process.cwd(), "src/app"),
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "./src") },
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist"),
    emptyOutDir: true,
  },
});
