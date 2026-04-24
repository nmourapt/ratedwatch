// Slice #10 (issue #11). One photo per watch, uploaded to R2 via the
// authed API and served back through /images/watches/:id. Renders:
//
//   * The current photo (if any) from /images/watches/:id — that URL
//     is stable per watch so the img tag can live in markup without a
//     re-render dance. We bust the browser cache on upload/delete via
//     a version query param.
//   * A drag-and-drop region + "choose file" button when no file is
//     pending. The moment a File is selected, we show an object-URL
//     preview and two buttons: Upload / Cancel.
//   * A "remove photo" button that hits DELETE when a stored image
//     exists.
//
// The component intentionally keeps no state across re-mounts: the
// parent page refetches the watch after upload/delete so the new
// image_r2_key flows back through props.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteWatchImage, uploadWatchImage, type ImageUploadError } from "./api";

// Must match the server's ALLOWED_IMAGE_TYPES (src/server/routes/images.ts).
const ACCEPT = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const ACCEPT_ATTR = ACCEPT.join(",");
const MAX_BYTES = 5 * 1024 * 1024;

interface Props {
  watchId: string;
  /** Current image key from the server (null when no photo is set). */
  imageKey: string | null;
  /** Parent refetches the watch after a successful mutation. */
  onChanged: () => void;
}

export function WatchPhotoPanel({ watchId, imageKey, onChanged }: Props) {
  const [pending, setPending] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "delete">(null);
  const [dragActive, setDragActive] = useState(false);
  // Bumped after upload/delete so the browser drops its cached image.
  const [version, setVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Tear down object URLs when they change or the component unmounts.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // If the parent swaps to a different watch while a pending file is
  // queued, drop the pending state so the new watch's uploader is clean.
  useEffect(() => {
    setPending(null);
    setPreviewUrl(null);
    setError(null);
    // We deliberately don't reset `version` — the browser happily
    // reuses the cached /images/watches/:id response for another
    // watch id; it's the id that varies, not the version.
  }, [watchId]);

  const imageSrc = useMemo(() => {
    if (!imageKey) return null;
    // Append version so a freshly-uploaded / -deleted image isn't
    // served from the browser HTTP cache under the old cache-control.
    const qs = version === 0 ? "" : `?v=${version}`;
    return `/images/watches/${encodeURIComponent(watchId)}${qs}`;
  }, [imageKey, watchId, version]);

  function handleFileChosen(file: File) {
    setError(null);
    if (!ACCEPT.includes(file.type)) {
      setError("Unsupported image type — use JPEG, PNG, WebP, or HEIC");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Image is too large — the maximum is 5 MB");
      return;
    }
    // Replace any previous preview URL before assigning a new one so
    // the effect above can revoke it cleanly.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPending(file);
  }

  async function handleUpload() {
    if (!pending) return;
    setBusy("upload");
    setError(null);
    const result = await uploadWatchImage(watchId, pending);
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // Clean local state, bump cache-buster, tell parent to refetch.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPending(null);
    setPreviewUrl(null);
    setVersion((v) => v + 1);
    onChanged();
  }

  function handleCancel() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPending(null);
    setPreviewUrl(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleDelete() {
    if (!imageKey) return;
    if (!window.confirm("Remove this photo?")) return;
    setBusy("delete");
    setError(null);
    const result = await deleteWatchImage(watchId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setVersion((v) => v + 1);
    onChanged();
  }

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileChosen(file);
    // Allow re-selecting the same file after cancel.
    e.target.value = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileChosen(file);
  }

  return (
    <section
      aria-label="Watch photo"
      className="mb-8 rounded-lg border border-cf-border bg-cf-surface p-4"
    >
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cf-text-muted">
        Photo
      </h2>

      {/* Display area: current image, pending preview, or placeholder. */}
      <div className="mb-4 flex justify-center">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="New photo preview"
            className="max-h-80 rounded-md border border-cf-border object-contain"
          />
        ) : imageSrc ? (
          <img
            src={imageSrc}
            alt="Watch photo"
            className="max-h-80 rounded-md border border-cf-border object-contain"
          />
        ) : (
          <WatchSilhouette />
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-cf-accent/40 bg-cf-accent/10 px-3 py-2 text-sm text-cf-text"
        >
          {error}
        </p>
      ) : null}

      {/* Controls. Split by state: pending file, existing image, or empty. */}
      {pending ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleUpload}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-full bg-cf-accent px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-cf-accent/90 disabled:opacity-60"
          >
            {busy === "upload" ? "Uploading…" : "Upload photo"}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-5 py-2.5 text-sm font-medium text-cf-text transition-colors hover:border-cf-text-muted disabled:opacity-60"
          >
            Cancel
          </button>
          <span className="font-mono text-xs text-cf-text-subtle">
            {pending.name} · {(pending.size / 1024).toFixed(0)} KB
          </span>
        </div>
      ) : (
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragActive) setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`flex flex-wrap items-center gap-3 rounded-md border-2 border-dashed p-4 transition-colors ${
            dragActive ? "border-cf-accent bg-cf-accent/10" : "border-cf-border bg-cf-bg"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="sr-only"
            onChange={onInputChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-5 py-2.5 text-sm font-medium text-cf-text transition-colors hover:border-cf-accent hover:text-cf-accent disabled:opacity-60"
          >
            {imageKey ? "Replace photo" : "Choose photo"}
          </button>
          <span className="text-sm text-cf-text-muted">
            or drag &amp; drop · JPEG, PNG, WebP, HEIC · up to 5 MB
          </span>
          {imageKey ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy !== null}
              className="ml-auto inline-flex items-center justify-center rounded-full border border-cf-accent/40 bg-cf-accent/10 px-4 py-2 text-sm font-medium text-cf-accent transition-colors hover:border-cf-accent hover:bg-cf-accent/20 disabled:opacity-60"
            >
              {busy === "delete" ? "Removing…" : "Remove photo"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

// Minimal "no image yet" placeholder. Kept inline because it's a
// ~30-line SVG and the watch page is the only consumer.
function WatchSilhouette() {
  return (
    <div
      aria-hidden="true"
      className="flex h-40 w-full max-w-xs items-center justify-center rounded-md border border-dashed border-cf-border bg-cf-bg text-cf-text-subtle"
    >
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="opacity-70"
      >
        <rect
          x="14"
          y="16"
          width="20"
          height="16"
          rx="4"
          stroke="currentColor"
          strokeWidth="2"
        />
        <rect
          x="20"
          y="10"
          width="8"
          height="6"
          rx="1"
          stroke="currentColor"
          strokeWidth="2"
        />
        <rect
          x="20"
          y="32"
          width="8"
          height="6"
          rx="1"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="24" cy="24" r="4" stroke="currentColor" strokeWidth="1.5" />
        <line
          x1="24"
          y1="22"
          x2="24"
          y2="24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="24"
          y1="24"
          x2="26"
          y2="24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
