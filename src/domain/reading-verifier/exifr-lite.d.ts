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
    pick?: Array<string | number>;
    skip?: Array<string | number>;
    translateKeys?: boolean;
    translateValues?: boolean;
    reviveValues?: boolean;
  }

  type ParseInput = ArrayBuffer | SharedArrayBuffer | Uint8Array | DataView;

  export function parse(
    input: ParseInput,
    options?: ParseOptions | string[] | true,
  ): Promise<Record<string, unknown> | undefined>;
}
