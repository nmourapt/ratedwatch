// exifr ships its top-level types via `index.d.ts` but does not
// declare types for the per-bundle entrypoints (`dist/lite.esm.mjs`,
// `dist/full.esm.mjs`, `dist/mini.esm.mjs`). The lite build exposes
// the same `parse(input, options)` shape as the top-level package —
// minus the GPS / thumbnail / orientation helpers we don't use. We
// declare a narrow shim here so the import in `./exif.ts` typechecks
// against the surface we actually call.
//
// If a future exifr version reorganises its bundles, drop this file
// and switch back to the top-level `import { parse } from "exifr"`
// (with the bundle-size cost it incurs).

declare module "exifr/dist/lite.esm.mjs" {
  interface ParseOptions {
    // Tag-filter forms. Both are exposed but `pick` is BROKEN in the
    // current lite build (`undefined is not iterable` at
    // setupGlobalFilters when you call it with `pick` → segments are
    // not all registered in the dictionary lookup). See PR #124's
    // discovery + the `{ exif: true }` workaround used in `./exif.ts`
    // and `src/app/watches/extractCaptureTime.ts`.
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

  type ParseInput = ArrayBuffer | SharedArrayBuffer | Uint8Array | DataView;

  export function parse(
    input: ParseInput,
    options?: ParseOptions | string[] | true,
  ): Promise<Record<string, unknown> | undefined>;
}
