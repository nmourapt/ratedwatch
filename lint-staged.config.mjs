// lint-staged configuration.
//
// Notes:
// - Prettier is applied per-file (idiomatic).
// - `tsc --noEmit` is a project-level check; it cannot run per-file because
//   the type graph spans the whole project, so we return a constant command
//   from the matcher. The root tsconfig covers the Worker + tests; the app
//   tsconfig covers the SPA.
// - `vitest related --run` is handed the list of staged TS/TSX files so
//   vitest only runs the tests whose import graph is affected.
// - When `wrangler.jsonc` is staged, regenerate `worker-configuration.d.ts`
//   so the committed types match the new config in the same commit. Avoids
//   the "I forgot to run types:gen" merge fiddles we had during Wave 8.
//   The regenerated file is staged automatically so it rides the same
//   commit; the subsequent `tsc --noEmit` matcher picks up its changes.

export default {
  "*.{js,jsx,ts,tsx,json,jsonc,md,yml,yaml}": ["prettier --write"],
  "*.{ts,tsx}": [
    () => "tsc --noEmit",
    () => "tsc --noEmit -p tsconfig.app.json",
    () => "tsc --noEmit -p tsconfig.e2e.json",
    (files) =>
      `bash -c 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false vitest related --run ${files.join(" ")}'`,
  ],
  "wrangler.jsonc": () => ["npm run types:gen", "git add worker-configuration.d.ts"],
};
