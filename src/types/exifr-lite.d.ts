// exifr ships its top-level types via `index.d.ts` but does not
// declare types for the per-bundle entrypoints (`dist/lite.esm.mjs`,
// `dist/full.esm.mjs`, `dist/mini.esm.mjs`). All three builds expose
// the same `parse(input, options)` surface — they differ only in
// which file formats / segment parsers are bundled. We declare a
// shared narrow shim here so both Worker (`exif.ts`, lite) and SPA
// (`extractCaptureTime.ts`, full) imports typecheck.
//
// Why two builds: lite (~45 KB) is plenty for the Worker since the
// byte-EXIF path is structurally dead in production (the SPA's
// canvas-resize strips EXIF before bytes reach the Worker). Full
// (~75 KB) lives in the SPA because lite's HEIC EXIF extractor has
// gaps for the HEIC variants iPhone Camera produces, and we read
// EXIF client-side from the ORIGINAL file before resize.
//
// If a future exifr version reorganises its bundles, drop this file
// and switch back to `import { parse } from "exifr"` (the package
// root has its own types in index.d.ts) at the cost of a larger
// import.

interface ExifrParseOptions {
  // Tag-filter forms. Both are exposed but `pick` is BROKEN in the
  // current lite build (`undefined is not iterable` at
  // setupGlobalFilters when you call it with `pick` — segments are
  // not all registered in the dictionary lookup). See PR #124's
  // discovery + the `{ exif: true }` workaround used in
  // `src/domain/reading-verifier/exif.ts` and
  // `src/app/watches/extractCaptureTime.ts`.
  pick?: Array<string | number>;
  skip?: Array<string | number>;
  translateKeys?: boolean;
  translateValues?: boolean;
  reviveValues?: boolean;
  // Per-segment toggles. Setting any of these to a boolean disables
  // (or enables) parsing of that segment entirely. The narrow
  // approach we use is `{ ifd0: false, exif: true, gps: false,
  // interop: false, ifd1: false }` — parses just the EXIF segment
  // where DateTimeOriginal / CreateDate live, skipping the rest.
  ifd0?: boolean;
  exif?: boolean;
  gps?: boolean;
  interop?: boolean;
  ifd1?: boolean;
  xmp?: boolean;
  icc?: boolean;
  iptc?: boolean;
  jfif?: boolean;
}

type ExifrParseInput = ArrayBuffer | SharedArrayBuffer | Uint8Array | DataView;

declare module "exifr/dist/lite.esm.mjs" {
  export function parse(
    input: ExifrParseInput,
    options?: ExifrParseOptions | string[] | true,
  ): Promise<Record<string, unknown> | undefined>;
}

declare module "exifr/dist/full.esm.mjs" {
  export function parse(
    input: ExifrParseInput,
    options?: ExifrParseOptions | string[] | true,
  ): Promise<Record<string, unknown> | undefined>;
}
