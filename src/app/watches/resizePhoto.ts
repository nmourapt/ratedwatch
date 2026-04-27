// Client-side photo resize for the verified-reading upload flow
// (slice #80 of PRD #73, User Story #4).
//
// Goal: reduce mobile-cellular upload time and data burn by resizing
// every captured photo so its longer edge is at most MAX_LONG_EDGE
// pixels, encoded as JPEG quality 0.85, BEFORE we send it to the
// Worker. iPhone HEIC inputs decode through the browser's native
// `<img>` path (Safari/WebKit understand HEIC; Chrome/Firefox don't,
// but iOS PWAs are Safari) — so when the browser can't decode the
// file we fall back to uploading the original bytes with a soft
// warning rather than throwing.
//
// The pipeline is:
//
//   1. URL.createObjectURL(file) → <img>.src → load
//   2. Compute target dimensions (longer edge = MAX_LONG_EDGE,
//      preserve aspect ratio, never upscale)
//   3. <canvas>.getContext("2d").drawImage(img, 0, 0, w, h)
//   4. canvas.toBlob("image/jpeg", QUALITY) → File
//
// A failure at ANY step (image decode, canvas, toBlob returning
// null) collapses to "fall back to original" rather than rejecting
// the upload. The verifier on the server side handles whatever
// bytes arrive; oversized photos are slow but not broken.

export const MAX_LONG_EDGE = 1500;
export const JPEG_QUALITY = 0.85;

export interface ResizeResult {
  /** The file we should upload — either the resized version or the original. */
  file: File;
  /** Whether the resize actually ran. False = original bytes. */
  resized: boolean;
  /** Reason resize was skipped, if any. Useful for debugging. */
  reason?:
    | "decode_failed"
    | "no_canvas_support"
    | "encode_failed"
    | "smaller_than_target";
}

/**
 * Resize a captured photo to MAX_LONG_EDGE on its longer edge,
 * encoded as JPEG. Falls back to returning the original file when
 * the browser can't decode it — that path keeps the verified-reading
 * flow working on browsers that don't grok HEIC (or any other
 * format the user picks from gallery).
 *
 * Pure async function so it's unit-testable with mock canvas /
 * Image / URL implementations.
 */
export async function resizeForUpload(file: File): Promise<ResizeResult> {
  // Quick path: if we have no canvas / Image / URL.createObjectURL,
  // we can't resize. Browser support for these is universal in
  // production — this branch exists to make the function tolerant
  // of unusual test/runtime environments rather than to handle
  // ancient browsers.
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return { file, resized: false, reason: "no_canvas_support" };
  }

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    // Browser can't decode this file (very old browser, exotic
    // format). Upload as-is.
    return { file, resized: false, reason: "decode_failed" };
  }

  const { width: srcW, height: srcH } = img;
  if (srcW === 0 || srcH === 0) {
    return { file, resized: false, reason: "decode_failed" };
  }

  const longEdge = Math.max(srcW, srcH);
  if (longEdge <= MAX_LONG_EDGE) {
    // Already small enough — don't bother re-encoding (would lose
    // a touch of quality for no upload-size win).
    return { file, resized: false, reason: "smaller_than_target" };
  }

  const scale = MAX_LONG_EDGE / longEdge;
  const targetW = Math.round(srcW * scale);
  const targetH = Math.round(srcH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { file, resized: false, reason: "no_canvas_support" };
  }
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
  if (!blob) {
    return { file, resized: false, reason: "encode_failed" };
  }

  // Preserve a sensible filename. Some browsers (mobile Safari)
  // synthesize "image.jpg"; pick that or rename the original
  // extension to .jpg since the bytes are now JPEG.
  const baseName = file.name.replace(/\.[^.]+$/, "") || "photo";
  const resized = new File([blob], `${baseName}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });

  return { file: resized, resized: true };
}

// --- Internal helpers ---------------------------------------------

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err instanceof Event ? new Error("image decode failed") : err);
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

// --- Test override hook -------------------------------------------
//
// Mirrors the `__setTestExifReader` / `__setTestDialReader` pattern.
// Lets RTL component tests (when we add them — slice #80 leaves an
// integration-only assertion as a placeholder while RTL infra is
// added separately) swap the resize for a deterministic stub that
// doesn't depend on a real <canvas>.

let testResizer: ((file: File) => Promise<ResizeResult>) | null = null;

/**
 * TEST-ONLY. Install a fake resizer. Pass null to clear.
 */
export function __setTestResizer(
  fn: ((file: File) => Promise<ResizeResult>) | null,
): void {
  testResizer = fn;
}

/**
 * Public entrypoint used by the React component. Tests can
 * intercept via __setTestResizer above. Production routes through
 * the real `resizeForUpload`.
 */
export async function maybeResize(file: File): Promise<ResizeResult> {
  if (testResizer) {
    return testResizer(file);
  }
  return resizeForUpload(file);
}
