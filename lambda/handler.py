"""
StickerSnap — Lambda handler
============================
Pipeline:
  1. Receive POST { "object_key": "uploads/<uuid>.jpg" }
  2. Download the image from S3
  3. Resize to MAX_IMAGE_DIMENSION_PX if needed (speeds up REMBG inference)
  4. Remove background with REMBG → RGBA PNG
  5. Add white dilation border with Pillow → sticker PNG
  6. Upload result to S3 outputs/<uuid>_sticker.png
  7. Return presigned GET URL (valid for PRESIGNED_URL_EXPIRY_SECONDS)

Environment variables (set by CDK):
  BUCKET_NAME                  — S3 bucket for both uploads and outputs
  UPLOADS_PREFIX               — e.g. "uploads/"
  OUTPUTS_PREFIX               — e.g. "outputs/"
  PRESIGNED_URL_EXPIRY_SECONDS — download URL lifetime (default 3600)
  BORDER_SIZE_PX               — white border width in pixels (default 12)
  MAX_IMAGE_DIMENSION_PX       — resize cap before processing (default 1024)
"""
from __future__ import annotations

import os
import shutil
import sys

# ── Numba cache fix (must run before any rembg/pymatting import) ────────────
os.environ.setdefault("NUMBA_CACHE_DIR", "/tmp/numba_cache")
os.makedirs("/tmp/numba_cache", exist_ok=True)

# Redirect model cache to /tmp — /home is read-only in Lambda
os.environ.setdefault("U2NET_HOME", "/tmp/u2net")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp/cache")
os.environ.setdefault("HOME", "/tmp")
os.makedirs("/tmp/u2net", exist_ok=True)
os.makedirs("/tmp/cache", exist_ok=True)

_PYMATTING_SRC = "/var/task/pymatting"
_PYMATTING_DST = "/tmp/pymatting"

if not os.path.exists(_PYMATTING_DST):
    shutil.copytree(_PYMATTING_SRC, _PYMATTING_DST)

if _PYMATTING_DST not in sys.path:
    sys.path.insert(0, _PYMATTING_DST)
    if _PYMATTING_SRC in sys.path:
        sys.path.remove(_PYMATTING_SRC)

# ── Now safe to import rembg ─────────────────────────────────────────────────
import io
import json
import logging
import uuid
from typing import Any

import boto3
from botocore.config import Config
import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── Configuration (from Lambda environment variables) ──────────────────────
BUCKET_NAME = os.environ["BUCKET_NAME"]
UPLOADS_PREFIX = os.environ.get("UPLOADS_PREFIX", "uploads/")
OUTPUTS_PREFIX = os.environ.get("OUTPUTS_PREFIX", "outputs/")
PRESIGNED_URL_EXPIRY = int(os.environ.get("PRESIGNED_URL_EXPIRY_SECONDS", "3600"))
BORDER_SIZE_PX = int(os.environ.get("BORDER_SIZE_PX", "12"))
MAX_DIMENSION = int(os.environ.get("MAX_IMAGE_DIMENSION_PX", "1024"))
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")

# Supported input MIME types → Pillow format strings
SUPPORTED_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "JPEG",
    "image/jpg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
    "image/heic": "HEIF",
}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB

# ── Warm REMBG session (model loaded once per container, not per invocation) ─
# The U²-Net model (~170 MB) is downloaded to /tmp on first cold start if it
# isn't already baked into the image. Our Dockerfile pre-bakes it so this is
# instant on warm and cold starts.
_REMBG_SESSION = new_session("u2net")

# ── AWS clients (also warm across invocations) ──────────────────────────────
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-1")

_S3 = boto3.client(
    "s3",
    region_name=AWS_REGION,
    endpoint_url=f"https://s3.{AWS_REGION}.amazonaws.com",
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"},
    ),
)

# ── Entry point ─────────────────────────────────────────────────────────────

def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point. Accepts both direct invocations and Function URL
    (HTTP API) events so the same handler works for local pytest and live use.
    """
    logger.info("Event: %s", json.dumps(event, default=str))

    if event.get("httpMethod", "") == "OPTIONS":
        # CORS preflight response for Function URL
        return {
            "statusCode": 204,
            "headers": {
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            },
            "body": "",
        }

    try:
        body = _parse_body(event)

        # ── Presign upload URL (called before the main processing request) ──
        action = body.get("action", "")
        if action == "presign_upload":
            object_key = body.get("object_key", "")
            if not object_key:
                return _error(400, "Missing 'object_key' in presign_upload request.")
            if not object_key.startswith(UPLOADS_PREFIX):
                return _error(400, f"'object_key' must start with '{UPLOADS_PREFIX}'.")
            upload_url = _presign_upload_url(object_key)
            return _ok({"upload_url": upload_url, "object_key": object_key})

        # ── Main processing pipeline ─────────────────────────────────────────
        object_key: str = body.get("object_key", "")

        if not object_key:
            return _error(400, "Missing 'object_key' in request body.")

        if not object_key.startswith(UPLOADS_PREFIX):
            return _error(
                400,
                f"'object_key' must start with '{UPLOADS_PREFIX}'. "
                f"Got: {object_key!r}",
            )

        # 1. Download original image from S3
        image_bytes, content_type = _download_from_s3(object_key)
        logger.info(
            "Downloaded %d bytes (content-type: %s) from s3://%s/%s",
            len(image_bytes),
            content_type,
            BUCKET_NAME,
            object_key,
        )

        if len(image_bytes) > MAX_UPLOAD_BYTES:
            return _error(413, f"Image exceeds the {MAX_UPLOAD_BYTES // 1024 // 1024} MB limit.")

        # 2. Open + cap dimensions
        image = _open_and_resize(image_bytes)
        logger.info("Working image size: %s", image.size)

        # 3. Remove background → RGBA
        rgba_image = _remove_background(image)

        # 4. Add white sticker border
        sticker_image = _add_border(rgba_image, border_px=BORDER_SIZE_PX)

        # 5. Encode to PNG bytes
        output_bytes = _encode_png(sticker_image)

        # 6. Upload to S3 outputs/
        original_stem = os.path.splitext(os.path.basename(object_key))[0]
        output_key = f"{OUTPUTS_PREFIX}{original_stem}_sticker.png"
        _upload_to_s3(output_key, output_bytes)
        logger.info("Uploaded sticker to s3://%s/%s", BUCKET_NAME, output_key)

        # 7. Generate presigned GET URL
        presigned_url = _presign_url(output_key)

        return _ok(
            {
                "sticker_url": presigned_url,
                "output_key": output_key,
                "expires_in": PRESIGNED_URL_EXPIRY,
            }
        )

    except ClientError as exc:
        logger.exception("S3 error")
        return _error(502, f"Storage error: {exc.response['Error']['Code']}")
    except ValueError as exc:
        logger.exception("Validation error")
        return _error(400, str(exc))
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error")
        return _error(500, "Internal processing error. Please try again.")


# ── Processing helpers ───────────────────────────────────────────────────────

def _open_and_resize(image_bytes: bytes) -> Image.Image:
    """Open image bytes with Pillow and resize if the longest edge exceeds
    MAX_DIMENSION. Preserves aspect ratio. Converts to RGB for REMBG."""
    image = Image.open(io.BytesIO(image_bytes))

    # EXIF orientation fix (phones shoot in landscape then tag it)
    try:
        from PIL import ImageOps
        image = ImageOps.exif_transpose(image)
    except Exception:  # noqa: BLE001
        pass

    # Convert to RGB; REMBG handles the alpha channel itself
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGB")

    # Resize cap
    w, h = image.size
    max_edge = max(w, h)
    if max_edge > MAX_DIMENSION:
        scale = MAX_DIMENSION / max_edge
        image = image.resize(
            (int(w * scale), int(h * scale)),
            Image.LANCZOS,
        )

    return image


def _remove_background(image: Image.Image) -> Image.Image:
    """Run REMBG background removal. Returns an RGBA PIL image."""
    # Convert PIL → bytes → REMBG → PIL
    buf = io.BytesIO()
    fmt = "PNG" if image.mode == "RGBA" else "JPEG"
    image.save(buf, format=fmt)
    buf.seek(0)

    result_bytes = remove(buf.read(), session=_REMBG_SESSION)
    result = Image.open(io.BytesIO(result_bytes)).convert("RGBA")
    return result


def _add_border(image: Image.Image, border_px: int = 12) -> Image.Image:
    """Add a white dilation border around the subject to produce a
    classic printed-sticker look.

    Algorithm:
      1. Extract the alpha channel.
      2. Dilate it by `border_px` pixels using a max-filter (morphological
         dilation).
      3. Paint white wherever the dilated alpha > 0 but the original alpha
         was 0 — this is the border region.
      4. Composite the original RGBA on top.
    """
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    r, g, b, alpha = image.split()
    alpha_np = np.array(alpha)

    # ── Step 1: threshold alpha ─────────────────────────────────────────────
    binary = np.where(alpha_np > 30, 255, 0).astype(np.uint8)

    # ── Step 2: flood-fill to close interior holes ──────────────────────────
    import scipy.ndimage as ndi

    inverted = (binary == 0).astype(np.uint8)
    labeled, _ = ndi.label(inverted)

    border_labels = set()
    border_labels.update(labeled[0, :].tolist())
    border_labels.update(labeled[-1, :].tolist())
    border_labels.update(labeled[:, 0].tolist())
    border_labels.update(labeled[:, -1].tolist())
    border_labels.discard(0)

    background_mask = np.isin(labeled, list(border_labels))
    filled_alpha = np.where(background_mask, 0, 255).astype(np.uint8)

    alpha_filled = Image.fromarray(filled_alpha)
    image = Image.merge("RGBA", (r, g, b, alpha_filled))

    # ── Step 3: dilate filled alpha for border shape ─────────────────────────
    dilated = alpha_filled.filter(ImageFilter.MaxFilter(size=border_px * 2 + 1))
    dilated_np = np.array(dilated)

    # ── Step 4: smooth the border with Gaussian blur ─────────────────────────
    # Blur the dilated alpha, then threshold to get a soft rounded edge
    blur_radius = border_px * 0.6  # controls how soft/round the edge is
    dilated_blurred = dilated.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    blurred_np = np.array(dilated_blurred)

    # Border region: blurred dilation where subject alpha is 0
    border_mask = (blurred_np > 30) & (filled_alpha == 0)

    # ── Step 5: paint white border with soft edges ───────────────────────────
    white_layer = Image.new("RGBA", image.size, (255, 255, 255, 0))
    white_np = np.array(white_layer)

    # Use blurred alpha to determine border SHAPE (rounded edges)
    # but paint with solid white (alpha=255) for a crisp solid border
    white_np[border_mask, 0] = 255  # R
    white_np[border_mask, 1] = 255  # G
    white_np[border_mask, 2] = 255  # B
    white_np[border_mask, 3] = 255  # solid alpha, not blurred

    white_layer = Image.fromarray(white_np, "RGBA")

    return Image.alpha_composite(white_layer, image)


def _encode_png(image: Image.Image) -> bytes:
    """Encode a PIL image as PNG bytes."""
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf.read()


# ── S3 helpers ───────────────────────────────────────────────────────────────

def _download_from_s3(key: str) -> tuple[bytes, str]:
    """Download an object from S3 and return (bytes, content_type)."""
    response = _S3.get_object(Bucket=BUCKET_NAME, Key=key)
    content_type = response.get("ContentType", "image/jpeg")
    return response["Body"].read(), content_type


def _upload_to_s3(key: str, data: bytes) -> None:
    """Upload PNG bytes to S3."""
    _S3.put_object(
        Bucket=BUCKET_NAME,
        Key=key,
        Body=data,
        ContentType="image/png",
        # Cache-Control: stickers are immutable once generated
        CacheControl="max-age=86400, immutable",
    )


def _presign_url(key: str) -> str:
    """Generate a presigned GET URL for the given S3 key."""
    return _S3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET_NAME, "Key": key},
        ExpiresIn=PRESIGNED_URL_EXPIRY,
    )

def _presign_upload_url(key: str) -> str:
    """Generate a presigned PUT URL for the browser to upload directly to S3."""
    return _S3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": BUCKET_NAME,
            "Key": key,
            "ContentType": "image/jpeg",
        },
        ExpiresIn=300,  # 5 minutes — plenty of time for the upload
    )


# ── Response helpers ─────────────────────────────────────────────────────────

def _parse_body(event: dict[str, Any]) -> dict[str, Any]:
    """Extract the JSON body from either a Function URL event or a raw dict."""
    # Function URL wraps the body as a string
    if "body" in event:
        raw = event["body"] or "{}"
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
    # Direct invocation (pytest / AWS console test)
    return event
    

def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(payload),
    }


def _error(status: int, message: str) -> dict[str, Any]:
    logger.warning("Returning %d: %s", status, message)
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps({"error": message}),
    }


# Re-export for boto3 type hint
from botocore.exceptions import ClientError  # noqa: E402 (must be after imports above)
