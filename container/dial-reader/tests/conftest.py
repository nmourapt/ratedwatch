"""Shared pytest fixtures for the dial-reader test suite.

Image fixtures are generated programmatically rather than committed
as binary blobs so that:
  - the diff stays text-only and reviewable;
  - the fixtures match real file-format reality (Pillow's encoder
    produces actual JPEG/PNG/WebP bytes — not hand-crafted hex
    that drifts from the spec);
  - the suite trivially survives library upgrades.

Each fixture is module-scoped because the bytes are immutable and
the tests only read them.
"""

from __future__ import annotations

import io

import pillow_heif
import pytest
from PIL import Image

# Activate HEIF support in Pillow once. `register_heif_opener` is
# idempotent, so calling it from a fixture file is safe.
pillow_heif.register_heif_opener()


def _solid_rgb_image(size: int = 4) -> Image.Image:
    """A tiny solid-red RGB image. Smallest viable input that round-trips."""
    return Image.new("RGB", (size, size), (255, 0, 0))


@pytest.fixture(scope="session")
def jpeg_bytes() -> bytes:
    """Tiny 4×4 JPEG. Magic: `FF D8 FF`."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture(scope="session")
def png_bytes() -> bytes:
    """Tiny 4×4 PNG. Magic: `89 50 4E 47 0D 0A 1A 0A`."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="session")
def webp_bytes() -> bytes:
    """Tiny 4×4 WebP. Magic: `RIFF` at 0..3, `WEBP` at 8..11."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="WEBP")
    return buf.getvalue()


@pytest.fixture(scope="session")
def heic_bytes() -> bytes:
    """Tiny 4×4 HEIC. Magic: `ftypheic`/`ftypmif1` etc. at offset 4.

    pillow-heif's encoder is bundled in the wheel for amd64+arm64
    Linux/macOS, which matches both CI and the production container,
    so we generate this on the fly instead of committing a binary.
    """
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="HEIF")
    return buf.getvalue()


@pytest.fixture(scope="session")
def gif_bytes() -> bytes:
    """Tiny 4×4 GIF. Magic: `47 49 46 38` (`GIF8`). Rejected by decoder."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="GIF")
    return buf.getvalue()


@pytest.fixture(scope="session")
def bmp_bytes() -> bytes:
    """Tiny 4×4 BMP. Magic: `42 4D` (`BM`). Rejected by decoder."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="BMP")
    return buf.getvalue()


@pytest.fixture(scope="session")
def tiff_bytes() -> bytes:
    """Tiny 4×4 TIFF. Magic: `49 49 2A 00` (little-endian II*). Rejected."""
    buf = io.BytesIO()
    _solid_rgb_image().save(buf, format="TIFF")
    return buf.getvalue()


@pytest.fixture(scope="session")
def avif_bytes() -> bytes:
    """Synthetic AVIF byte signature.

    pillow-heif on its own does not encode AVIF, and adding a real
    AVIF encoder is out of scope for a slice that's about format
    rejection. We hand-craft the minimal byte sequence the decoder
    must recognise: the ISO BMFF box header `....ftypavif....`.
    The decoder only sniffs the first ~12 bytes for AVIF detection,
    so this is sufficient to drive the rejection branch.
    """
    # 4-byte big-endian box size, then `ftyp`, then `avif`, then a
    # minor-version + compatible-brands stub. The decoder only reads
    # bytes 4..11, so anything past that is filler.
    return b"\x00\x00\x00\x20ftypavif\x00\x00\x00\x00mif1avif"


@pytest.fixture(scope="session")
def truncated_jpeg_bytes(jpeg_bytes: bytes) -> bytes:
    """First 100 bytes only of a real JPEG.

    The magic bytes still mark this as JPEG (decoder dispatches into
    Pillow), but the payload is incomplete so Pillow raises during
    image-data parsing — surfaces as `MalformedImageError`.
    """
    return jpeg_bytes[:100]


@pytest.fixture(scope="session")
def random_bytes() -> bytes:
    """Bytes that don't match any supported magic. Rejected as unsupported."""
    return b"this is definitely not an image, just plain text bytes here"
