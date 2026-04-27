"""Image decode + format validation for the dial-reader container.

This module is the gate between raw HTTP request bytes and the
numpy ndarrays the (still-to-be-built) CV pipeline consumes.

Responsibilities, in order:

  1. Sniff the format from a small prefix of magic bytes. We
     deliberately ignore any client-supplied `Content-Type` —
     clients lie, get exploited, or carry buggy proxies that mangle
     headers. The bytes are the source of truth.

  2. Dispatch to the appropriate decoder. JPEG / PNG / WebP go
     through Pillow; HEIC / HEIF go through pillow-heif. Both
     paths converge on an RGB ndarray of dtype uint8.

  3. Translate decoder failures into the two typed errors below
     so the HTTP layer can map them to distinct response shapes
     (rejection-as-200 vs error-as-400).

Why two error types and not one:

  - `UnsupportedFormatError` means the byte content is recognised
    (it's clearly a GIF, BMP, AVIF…) but rated.watch's policy is
    to reject it. The Worker surfaces this as a structured
    rejection so the SPA can show "this format isn't supported
    yet — please use JPEG, PNG, WebP, or HEIC".

  - `MalformedImageError` means the byte content is corrupt,
    truncated, or otherwise unreadable. The Worker surfaces this
    as a 400 because the request itself is the problem; retrying
    with the same bytes will keep failing.

Subsequent slices use the returned ndarray as input to dial
detection and hand-angle parsing. The shape returned here
(HxWx3 uint8 RGB) is the contract the rest of the pipeline relies
on; changing it later requires updating callers.
"""

from __future__ import annotations

import io

import numpy as np
import pillow_heif
from numpy.typing import NDArray
from PIL import Image, UnidentifiedImageError

# ----------------------------------------------------------------
# pillow-heif registration. `register_heif_opener` is idempotent
# and side-effect-only; calling it at import time means HEIF
# decoding is available the moment this module is loaded, without
# every caller having to remember.
# ----------------------------------------------------------------
pillow_heif.register_heif_opener()


# ----------------------------------------------------------------
# Typed errors. Catch sites live in `http_app.py` and the TS
# adapter contract; both expect these specific names.
# ----------------------------------------------------------------


class UnsupportedFormatError(Exception):
    """Raised when the byte content is recognised but not on the
    rated.watch supported list (JPEG/PNG/WebP/HEIC)."""


class MalformedImageError(Exception):
    """Raised when the byte content cannot be decoded — empty,
    truncated, or rejected by the underlying image library."""


# ----------------------------------------------------------------
# Magic-byte sniffing. The minimum prefix length we need to look
# at is 12 bytes — that's enough for every signature below.
# ----------------------------------------------------------------

# JPEG: SOI marker `FF D8 FF`. The next byte is a marker subtype
# (E0 for JFIF, E1 for EXIF, etc.) — we don't care which, the
# Pillow JPEG decoder handles the variants.
_JPEG_MAGIC = b"\xff\xd8\xff"

# PNG: 8-byte signature, fixed.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# WebP: RIFF container with `WEBP` brand at offset 8.
# Bytes 4..7 are the chunk size; we ignore them for sniffing.
_RIFF_PREFIX = b"RIFF"
_WEBP_BRAND = b"WEBP"

# ISO BMFF (HEIC, HEIF, AVIF, MP4, etc.) all share `ftyp` at
# offset 4. The 4-byte brand at offset 8 disambiguates.
_FTYP_AT_OFFSET_4 = b"ftyp"

# Brands the decoder accepts. Reference:
#   https://nokiatech.github.io/heif/technical.html
# `mif1` and `msf1` are the generic image / image-sequence brands
# used by some HEIF encoders that don't claim `heic` directly.
_HEIF_BRANDS = frozenset({b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"})

# Brands we explicitly recognise but reject. Listed for the
# specific rejection message rather than falling into the
# generic "unsupported" branch.
_AVIF_BRANDS = frozenset({b"avif", b"avis"})

# Other recognised-but-rejected formats.
_GIF_MAGIC_PREFIX = b"GIF8"  # GIF87a or GIF89a
_BMP_MAGIC = b"BM"
# TIFF has two byte-order variants:
#   `II*\0` — little-endian
#   `MM\0*` — big-endian
_TIFF_LE_MAGIC = b"II*\x00"
_TIFF_BE_MAGIC = b"MM\x00*"


# Internal format-tag constants. Lowercase strings keep mypy happy
# without pulling in a full Enum just for a 6-way switch.
_FMT_JPEG = "jpeg"
_FMT_PNG = "png"
_FMT_WEBP = "webp"
_FMT_HEIF = "heif"


def _sniff_format(image_bytes: bytes) -> str:
    """Return the internal tag for a supported format, or raise.

    Exactly one of three things happens:
      - bytes match a supported magic → return the tag
      - bytes match a recognised-but-unsupported magic → raise
        UnsupportedFormatError with a descriptive message
      - bytes match nothing we know → raise UnsupportedFormatError
        with a generic message

    Empty input is treated as malformed rather than unsupported,
    because "no bytes at all" is a request-shape problem, not a
    format-policy problem.
    """
    if not image_bytes:
        raise MalformedImageError("empty image body")

    # Fast happy paths first.
    if image_bytes.startswith(_JPEG_MAGIC):
        return _FMT_JPEG
    if image_bytes.startswith(_PNG_MAGIC):
        return _FMT_PNG
    if (
        len(image_bytes) >= 12
        and image_bytes.startswith(_RIFF_PREFIX)
        and image_bytes[8:12] == _WEBP_BRAND
    ):
        return _FMT_WEBP

    # ISO BMFF family. Both HEIC and AVIF live here; the brand at
    # offset 8 tells them apart.
    if len(image_bytes) >= 12 and image_bytes[4:8] == _FTYP_AT_OFFSET_4:
        brand = image_bytes[8:12]
        if brand in _HEIF_BRANDS:
            return _FMT_HEIF
        if brand in _AVIF_BRANDS:
            raise UnsupportedFormatError("AVIF is not supported. Use JPEG, PNG, WebP, or HEIC.")
        # Unknown ISO BMFF brand. Could be MP4, 3GP, etc. — none
        # of which are images we can read.
        raise UnsupportedFormatError(
            f"Unsupported ISO BMFF brand {brand!r}. Use JPEG, PNG, WebP, or HEIC."
        )

    # Recognised-but-rejected raster formats.
    if image_bytes.startswith(_GIF_MAGIC_PREFIX):
        raise UnsupportedFormatError("GIF is not supported. Use JPEG, PNG, WebP, or HEIC.")
    if image_bytes.startswith(_BMP_MAGIC):
        raise UnsupportedFormatError("BMP is not supported. Use JPEG, PNG, WebP, or HEIC.")
    if image_bytes.startswith(_TIFF_LE_MAGIC) or image_bytes.startswith(_TIFF_BE_MAGIC):
        raise UnsupportedFormatError("TIFF is not supported. Use JPEG, PNG, WebP, or HEIC.")

    # Anything else.
    raise UnsupportedFormatError("Unrecognised image format. Use JPEG, PNG, WebP, or HEIC.")


def _decode_via_pillow(image_bytes: bytes) -> NDArray[np.uint8]:
    """Decode JPEG / PNG / WebP via Pillow → RGB ndarray.

    `Image.open` is lazy — it parses the header and returns a
    placeholder. We force a real decode by calling `convert("RGB")`,
    which in turn loads the pixel data. Any decoder failure
    (truncated, corrupt) surfaces during that call.
    """
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            rgb = img.convert("RGB")
            return np.asarray(rgb, dtype=np.uint8)
    except UnidentifiedImageError as e:
        raise MalformedImageError(f"image bytes could not be identified: {e}") from e
    except (OSError, ValueError) as e:
        # Pillow raises OSError for truncated streams and ValueError
        # for various malformations; both mean "decoder rejected
        # the bytes".
        raise MalformedImageError(f"image decoding failed: {e}") from e


def _decode_via_pillow_heif(image_bytes: bytes) -> NDArray[np.uint8]:
    """Decode HEIC / HEIF via pillow-heif → RGB ndarray.

    `pillow_heif.open_heif` returns a HEIF-native image object;
    `.to_pillow()` lifts it into a regular PIL Image which we then
    convert to RGB ndarray exactly like the Pillow path.
    """
    try:
        heif = pillow_heif.open_heif(io.BytesIO(image_bytes))
        pil = heif.to_pillow().convert("RGB")
        return np.asarray(pil, dtype=np.uint8)
    except (OSError, ValueError, RuntimeError) as e:
        # libheif raises a mix of these depending on the failure
        # mode (truncated, unsupported encoding, etc.). All map to
        # the same client-facing semantics: bytes are no good.
        raise MalformedImageError(f"HEIC/HEIF decoding failed: {e}") from e


def decode(image_bytes: bytes) -> NDArray[np.uint8]:
    """Decode raw image bytes into an RGB ndarray.

    Returns an array of shape (H, W, 3) and dtype uint8.

    Raises:
        UnsupportedFormatError: if the bytes are recognised as a
            non-rated.watch-supported format (GIF, BMP, TIFF,
            AVIF, etc.) or as something the decoder doesn't know
            at all.
        MalformedImageError: if the bytes are empty, truncated,
            or rejected by the underlying decoder library.
    """
    fmt = _sniff_format(image_bytes)
    if fmt == _FMT_HEIF:
        return _decode_via_pillow_heif(image_bytes)
    # JPEG / PNG / WebP all go through Pillow. The format tag is
    # carried for future logging / metrics; the decoder itself
    # handles all three transparently via Image.open.
    return _decode_via_pillow(image_bytes)
