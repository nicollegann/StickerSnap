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
  QUOTA_TABLE_NAME             — DynamoDB table for quota counters/reservations
  QUOTA_NAMESPACE              — namespace for shared quota table keys
  DAILY_DEVICE_LIMIT           — generations per device per UTC day (default 2)
  DAILY_IP_LIMIT               — generations per IP per UTC day (default 3)
  HOURLY_IP_LIMIT              — generations per IP per UTC hour (default 2)
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

if os.path.exists(_PYMATTING_SRC) and not os.path.exists(_PYMATTING_DST):
    shutil.copytree(_PYMATTING_SRC, _PYMATTING_DST)

if _PYMATTING_DST not in sys.path:
    sys.path.insert(0, _PYMATTING_DST)
    if _PYMATTING_SRC in sys.path:
        sys.path.remove(_PYMATTING_SRC)

# ── Now safe to import rembg ─────────────────────────────────────────────────
import io
import json
import logging
import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
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
QUOTA_TABLE_NAME = os.environ.get("QUOTA_TABLE_NAME", "")
QUOTA_NAMESPACE = os.environ.get("QUOTA_NAMESPACE", "default")
DAILY_DEVICE_LIMIT = int(os.environ.get("DAILY_DEVICE_LIMIT", "2"))
DAILY_IP_LIMIT = int(os.environ.get("DAILY_IP_LIMIT", "3"))
HOURLY_IP_LIMIT = int(os.environ.get("HOURLY_IP_LIMIT", "2"))

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

_DDB = boto3.client("dynamodb", region_name=AWS_REGION)
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")

# ── Entry point ─────────────────────────────────────────────────────────────

class QuotaExceededError(Exception):
    """Raised when a device or IP has reached its generation quota."""

    def __init__(
        self,
        message: str,
        *,
        reset_at: str | None = None,
        remaining_today: int | None = None,
    ) -> None:
        super().__init__(message)
        self.reset_at = reset_at
        self.remaining_today = remaining_today

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if self.reset_at is not None:
            payload["reset_at"] = self.reset_at
        if self.remaining_today is not None:
            payload["remaining_today"] = self.remaining_today
        return payload


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
            device_id = body.get("device_id", "")
            if not object_key:
                return _error(400, "Missing 'object_key' in presign_upload request.")
            if not object_key.startswith(UPLOADS_PREFIX):
                return _error(400, f"'object_key' must start with '{UPLOADS_PREFIX}'.")
            quota = _reserve_generation_quota(event, object_key, device_id)
            upload_url = _presign_upload_url(object_key)
            return _ok({"upload_url": upload_url, "object_key": object_key, **quota})

        # ── Main processing pipeline ─────────────────────────────────────────
        object_key: str = body.get("object_key", "")
        device_id = body.get("device_id", "")

        if not object_key:
            return _error(400, "Missing 'object_key' in request body.")

        if not object_key.startswith(UPLOADS_PREFIX):
            return _error(
                400,
                f"'object_key' must start with '{UPLOADS_PREFIX}'. "
                f"Got: {object_key!r}",
            )

        quota = _consume_generation_reservation(object_key, device_id)

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
                **quota,
            }
        )

    except QuotaExceededError as exc:
        logger.info("Quota exceeded: %s", exc)
        return _error(429, str(exc), extra=exc.to_payload())
    except ClientError as exc:
        logger.exception("S3 error")
        return _error(502, f"Storage error: {exc.response['Error']['Code']}")
    except ValueError as exc:
        logger.exception("Validation error")
        return _error(400, str(exc))
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error")
        return _error(500, "Internal processing error. Please try again.")


# ── Quota helpers ────────────────────────────────────────────────────────────

def _reserve_generation_quota(
    event: dict[str, Any],
    object_key: str,
    device_id: str,
) -> dict[str, Any]:
    """Reserve one sticker generation before giving the browser an upload URL."""
    if not QUOTA_TABLE_NAME:
        logger.warning("QUOTA_TABLE_NAME is not set; quota enforcement is disabled.")
        return {}

    device_hash = _validate_and_hash_device_id(device_id)
    ip_hash = _hash_value("ip", _extract_source_ip(event))
    now = datetime.now(timezone.utc)
    day_key, hour_key, day_reset_at, day_ttl, hour_reset_at, hour_ttl = (
        _quota_windows(now)
    )

    device_counter_key = _scoped_quota_key(f"device#{device_hash}#day#{day_key}")
    ip_daily_counter_key = _scoped_quota_key(f"ip#{ip_hash}#day#{day_key}")
    ip_hourly_counter_key = _scoped_quota_key(f"ip#{ip_hash}#hour#{hour_key}")
    reservation_key = _reservation_key(object_key)

    transact_items = [
        _quota_counter_update(
            device_counter_key,
            DAILY_DEVICE_LIMIT,
            day_reset_at,
            day_ttl,
        ),
        _quota_counter_update(
            ip_daily_counter_key,
            DAILY_IP_LIMIT,
            day_reset_at,
            day_ttl,
        ),
        _quota_counter_update(
            ip_hourly_counter_key,
            HOURLY_IP_LIMIT,
            hour_reset_at,
            hour_ttl,
        ),
        {
            "Put": {
                "TableName": QUOTA_TABLE_NAME,
                "Item": {
                    "quota_key": {"S": reservation_key},
                    "status": {"S": "reserved"},
                    "object_key": {"S": object_key},
                    "device_hash": {"S": device_hash},
                    "ip_hash": {"S": ip_hash},
                    "created_at": {"S": now.isoformat().replace("+00:00", "Z")},
                    "reset_at": {"S": day_reset_at},
                    "ttl": {"N": str(day_ttl)},
                },
                "ConditionExpression": "attribute_not_exists(quota_key)",
            }
        },
    ]

    try:
        _DDB.transact_write_items(TransactItems=transact_items)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "TransactionCanceledException":
            raise _quota_transaction_error(
                [
                    (device_counter_key, DAILY_DEVICE_LIMIT, day_reset_at),
                    (ip_daily_counter_key, DAILY_IP_LIMIT, day_reset_at),
                    (ip_hourly_counter_key, HOURLY_IP_LIMIT, hour_reset_at),
                ],
                device_counter_key,
                day_reset_at,
            ) from exc
        raise

    return _device_quota_snapshot(device_counter_key, day_reset_at)


def _consume_generation_reservation(object_key: str, device_id: str) -> dict[str, Any]:
    """Require a matching reservation before the expensive processing step."""
    if not QUOTA_TABLE_NAME:
        logger.warning("QUOTA_TABLE_NAME is not set; quota enforcement is disabled.")
        return {}

    device_hash = _validate_and_hash_device_id(device_id)
    now = datetime.now(timezone.utc)

    try:
        response = _DDB.update_item(
            TableName=QUOTA_TABLE_NAME,
            Key={"quota_key": {"S": _reservation_key(object_key)}},
            UpdateExpression="SET #status = :consumed, consumed_at = :now",
            ConditionExpression=(
                "attribute_exists(quota_key) "
                "AND #status = :reserved "
                "AND device_hash = :device_hash"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":consumed": {"S": "consumed"},
                ":reserved": {"S": "reserved"},
                ":device_hash": {"S": device_hash},
                ":now": {"S": now.isoformat().replace("+00:00", "Z")},
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "ConditionalCheckFailedException":
            raise ValueError(
                "This sticker request was not reserved or has already been processed."
            ) from exc
        raise

    attrs = response.get("Attributes", {})
    reset_at = attrs.get("reset_at", {}).get("S")
    day_key = now.strftime("%Y-%m-%d")
    device_counter_key = _scoped_quota_key(f"device#{device_hash}#day#{day_key}")
    return _device_quota_snapshot(device_counter_key, reset_at)


def _quota_counter_update(
    quota_key: str,
    limit: int,
    reset_at: str,
    ttl: int,
) -> dict[str, Any]:
    return {
        "Update": {
            "TableName": QUOTA_TABLE_NAME,
            "Key": {"quota_key": {"S": quota_key}},
            "UpdateExpression": (
                "SET #count = if_not_exists(#count, :zero) + :one, "
                "#ttl = :ttl, reset_at = :reset_at"
            ),
            "ConditionExpression": "attribute_not_exists(#count) OR #count < :limit",
            "ExpressionAttributeNames": {
                "#count": "count",
                "#ttl": "ttl",
            },
            "ExpressionAttributeValues": {
                ":zero": {"N": "0"},
                ":one": {"N": "1"},
                ":limit": {"N": str(limit)},
                ":ttl": {"N": str(ttl)},
                ":reset_at": {"S": reset_at},
            },
        }
    }


def _device_quota_snapshot(
    device_counter_key: str,
    reset_at: str | None,
) -> dict[str, Any]:
    if not QUOTA_TABLE_NAME:
        return {}

    try:
        response = _DDB.get_item(
            TableName=QUOTA_TABLE_NAME,
            Key={"quota_key": {"S": device_counter_key}},
            ConsistentRead=True,
        )
    except ClientError:
        logger.exception("Failed to read quota snapshot")
        return {"reset_at": reset_at} if reset_at else {}

    count = int(response.get("Item", {}).get("count", {}).get("N", "0"))
    return {
        "remaining_today": max(DAILY_DEVICE_LIMIT - count, 0),
        "reset_at": reset_at,
    }


def _quota_transaction_error(
    counters: list[tuple[str, int, str]],
    device_counter_key: str,
    fallback_reset_at: str,
) -> Exception:
    for counter_key, limit, reset_at in counters:
        count = _quota_counter_count(counter_key)
        if count >= limit:
            snapshot = _device_quota_snapshot(device_counter_key, fallback_reset_at)
            return QuotaExceededError(
                "Sticker generation limit reached. Please try again after the reset time.",
                reset_at=reset_at,
                remaining_today=snapshot.get("remaining_today"),
            )

    return ValueError("This sticker request has already been reserved.")


def _quota_counter_count(counter_key: str) -> int:
    response = _DDB.get_item(
        TableName=QUOTA_TABLE_NAME,
        Key={"quota_key": {"S": counter_key}},
        ConsistentRead=True,
    )
    return int(response.get("Item", {}).get("count", {}).get("N", "0"))


def _quota_windows(now: datetime) -> tuple[str, str, str, int, str, int]:
    day_key = now.strftime("%Y-%m-%d")
    hour_key = now.strftime("%Y-%m-%dT%H")
    tomorrow = (now + timedelta(days=1)).date()
    day_reset = datetime(
        tomorrow.year,
        tomorrow.month,
        tomorrow.day,
        tzinfo=timezone.utc,
    )
    hour_reset = (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
    day_reset_at = day_reset.isoformat().replace("+00:00", "Z")
    hour_reset_at = hour_reset.isoformat().replace("+00:00", "Z")
    day_ttl = int((day_reset + timedelta(days=1)).timestamp())
    hour_ttl = int((hour_reset + timedelta(hours=2)).timestamp())
    return day_key, hour_key, day_reset_at, day_ttl, hour_reset_at, hour_ttl


def _validate_and_hash_device_id(device_id: str) -> str:
    if not isinstance(device_id, str) or not _DEVICE_ID_RE.match(device_id):
        raise ValueError("Missing or invalid 'device_id'.")
    return _hash_value("device", device_id)


def _hash_value(kind: str, value: str) -> str:
    return hashlib.sha256(f"{kind}:{value}".encode("utf-8")).hexdigest()


def _reservation_key(object_key: str) -> str:
    return _scoped_quota_key(f"upload#{_hash_value('object_key', object_key)}")


def _scoped_quota_key(key: str) -> str:
    return f"env#{QUOTA_NAMESPACE}#{key}"


def _extract_source_ip(event: dict[str, Any]) -> str:
    request_context = event.get("requestContext", {})
    http_context = request_context.get("http", {})
    source_ip = http_context.get("sourceIp")
    if source_ip:
        return source_ip

    headers = event.get("headers", {}) or {}
    forwarded_for = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()

    return "unknown"


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


def _error(
    status: int,
    message: str,
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    logger.warning("Returning %d: %s", status, message)
    payload = {"error": message}
    if extra:
        payload.update(extra)
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(payload),
    }
