"""
Unit tests for handler.py
=========================
Run locally with:   pytest lambda/tests/ -v
Run in CI:          pytest lambda/tests/ -v --tb=short

These tests mock S3 (moto) so no real AWS credentials are needed.
The REMBG call is patched so tests run fast without a GPU or model download.
"""

from __future__ import annotations

import io
import json
import os
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import numpy as np
import pytest
from moto import mock_aws
from PIL import Image


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set required environment variables before importing the handler."""
    monkeypatch.setenv("BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("UPLOADS_PREFIX", "uploads/")
    monkeypatch.setenv("OUTPUTS_PREFIX", "outputs/")
    monkeypatch.setenv("PRESIGNED_URL_EXPIRY_SECONDS", "3600")
    monkeypatch.setenv("BORDER_SIZE_PX", "8")
    monkeypatch.setenv("MAX_IMAGE_DIMENSION_PX", "512")


def _make_rgb_image(width: int = 100, height: int = 100) -> bytes:
    """Return JPEG bytes of a solid red image."""
    img = Image.new("RGB", (width, height), color=(220, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_rgba_png(width: int = 100, height: int = 100) -> bytes:
    """Return PNG bytes of a partly transparent image (simulates REMBG output)."""
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    # Red circle in the centre, rest transparent
    cy, cx = height // 2, width // 2
    for y in range(height):
        for x in range(width):
            if (x - cx) ** 2 + (y - cy) ** 2 < (min(cx, cy) // 2) ** 2:
                arr[y, x] = [220, 50, 50, 255]
    img = Image.fromarray(arr, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _create_quota_table(ddb: Any, table_name: str = "quota-table") -> None:
    ddb.create_table(
        TableName=table_name,
        KeySchema=[{"AttributeName": "quota_key", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "quota_key", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _configure_quota(
    monkeypatch: pytest.MonkeyPatch,
    h: Any,
    table_name: str = "quota-table",
    *,
    daily_device_limit: int = 5,
) -> None:
    ddb = boto3.client("dynamodb", region_name="ap-southeast-1")
    _create_quota_table(ddb, table_name)
    monkeypatch.setattr(h, "_DDB", ddb)
    monkeypatch.setattr(h, "QUOTA_TABLE_NAME", table_name)
    monkeypatch.setattr(h, "DAILY_DEVICE_LIMIT", daily_device_limit)


def _function_url_event(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "body": json.dumps(body),
        "requestContext": {
            "http": {
                "sourceIp": "203.0.113.10",
            }
        },
    }


# ── _add_border ───────────────────────────────────────────────────────────────

def test_add_border_increases_opaque_pixel_count() -> None:
    """After adding a border the number of fully-opaque pixels should increase
    (border pixels are painted white and fully opaque)."""
    # Local import after env vars are set
    from handler import _add_border  # noqa: PLC0415

    rgba_bytes = _make_rgba_png(80, 80)
    input_img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")

    before_opaque = np.sum(np.array(input_img)[:, :, 3] == 255)
    result = _add_border(input_img, border_px=4)
    after_opaque = np.sum(np.array(result)[:, :, 3] == 255)

    assert after_opaque > before_opaque, (
        f"Expected more opaque pixels after border. "
        f"Before: {before_opaque}, after: {after_opaque}"
    )


def test_add_border_border_pixels_are_white() -> None:
    """Pixels that were transparent before and opaque after must be white."""
    from handler import _add_border  # noqa: PLC0415

    rgba_bytes = _make_rgba_png(80, 80)
    input_img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")
    input_arr = np.array(input_img)

    result = _add_border(input_img, border_px=4)
    result_arr = np.array(result)

    # Mask: was transparent, now opaque
    was_transparent = input_arr[:, :, 3] == 0
    now_opaque = result_arr[:, :, 3] == 255
    border_mask = was_transparent & now_opaque

    if border_mask.any():
        border_pixels = result_arr[border_mask]
        # All border pixels should be white (255, 255, 255)
        assert np.all(border_pixels[:, 0] == 255), "Border R != 255"
        assert np.all(border_pixels[:, 1] == 255), "Border G != 255"
        assert np.all(border_pixels[:, 2] == 255), "Border B != 255"


def test_add_border_preserves_original_pixels() -> None:
    """Pixels that were opaque before must retain their original colour."""
    from handler import _add_border  # noqa: PLC0415

    rgba_bytes = _make_rgba_png(80, 80)
    input_img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")
    input_arr = np.array(input_img)

    result = _add_border(input_img, border_px=4)
    result_arr = np.array(result)

    was_opaque = input_arr[:, :, 3] == 255
    if was_opaque.any():
        np.testing.assert_array_equal(
            input_arr[was_opaque],
            result_arr[was_opaque],
            err_msg="Original opaque pixels were modified by _add_border",
        )


# ── _open_and_resize ──────────────────────────────────────────────────────────

def test_resize_large_image() -> None:
    """Images wider/taller than MAX_DIMENSION should be downscaled."""
    from handler import _open_and_resize  # noqa: PLC0415

    large_image_bytes = _make_rgb_image(width=2000, height=1500)
    result = _open_and_resize(large_image_bytes)
    assert max(result.size) <= 512


def test_small_image_not_upscaled() -> None:
    """Images smaller than MAX_DIMENSION must not be enlarged."""
    from handler import _open_and_resize  # noqa: PLC0415

    small_image_bytes = _make_rgb_image(width=200, height=150)
    result = _open_and_resize(small_image_bytes)
    assert result.size == (200, 150)


def test_resize_preserves_aspect_ratio() -> None:
    """Downscaled images must preserve the original aspect ratio (±1 px)."""
    from handler import _open_and_resize  # noqa: PLC0415

    image_bytes = _make_rgb_image(width=1600, height=800)
    result = _open_and_resize(image_bytes)
    w, h = result.size
    assert abs(w / h - 2.0) < 0.02, f"Aspect ratio changed: {w}×{h}"


# ── Lambda handler (end-to-end with mocked S3 + REMBG) ───────────────────────

@mock_aws
def test_handler_happy_path() -> None:
    """Full happy path: upload in S3 → handler returns presigned URL."""
    import importlib
    import handler as h  # noqa: PLC0415

    # Set up fake S3 bucket
    s3 = boto3.client("s3", region_name="ap-southeast-1")
    s3.create_bucket(
        Bucket="test-bucket",
        CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
    )

    # Put a test image in uploads/
    image_bytes = _make_rgb_image()
    s3.put_object(
        Bucket="test-bucket",
        Key="uploads/test-image.jpg",
        Body=image_bytes,
        ContentType="image/jpeg",
    )

    # Patch rembg.remove to return a predictable RGBA PNG (no model needed)
    fake_rgba_bytes = _make_rgba_png()
    with patch("handler.remove", return_value=fake_rgba_bytes):
        event = {
            "body": json.dumps({"object_key": "uploads/test-image.jpg"})
        }
        response = h.handler(event, {})

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert "sticker_url" in body
    assert "output_key" in body
    assert body["output_key"].startswith("outputs/")
    assert body["output_key"].endswith("_sticker.png")

    # Verify the sticker was actually written to S3
    s3.head_object(Bucket="test-bucket", Key=body["output_key"])


@mock_aws
def test_presign_upload_reserves_generation_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Presigning an upload reserves one generation and reports remaining quota."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h)

    event = _function_url_event(
        {
            "action": "presign_upload",
            "object_key": "uploads/quota-test.jpg",
            "device_id": "device-12345",
        }
    )
    response = h.handler(event, {})

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert "upload_url" in body
    assert body["remaining_today"] == 4
    assert "reset_at" in body


@mock_aws
def test_presign_upload_returns_429_after_daily_device_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A device cannot reserve more generations than its daily limit."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h, daily_device_limit=1)

    first = h.handler(
        _function_url_event(
            {
                "action": "presign_upload",
                "object_key": "uploads/first.jpg",
                "device_id": "device-12345",
            }
        ),
        {},
    )
    second = h.handler(
        _function_url_event(
            {
                "action": "presign_upload",
                "object_key": "uploads/second.jpg",
                "device_id": "device-12345",
            }
        ),
        {},
    )

    assert first["statusCode"] == 200
    assert second["statusCode"] == 429
    body = json.loads(second["body"])
    assert body["remaining_today"] == 0
    assert "reset_at" in body


@mock_aws
def test_processing_requires_reserved_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Direct processing calls are blocked before S3 download or REMBG work."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h)

    response = h.handler(
        _function_url_event(
            {
                "object_key": "uploads/not-reserved.jpg",
                "device_id": "device-12345",
            }
        ),
        {},
    )

    assert response["statusCode"] == 400
    assert "not reserved" in json.loads(response["body"])["error"]


@mock_aws
def test_handler_happy_path_with_reserved_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A request reserved during presign can be consumed by processing."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h)
    s3 = boto3.client("s3", region_name="ap-southeast-1")
    monkeypatch.setattr(h, "_S3", s3)
    s3.create_bucket(
        Bucket="test-bucket",
        CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
    )

    object_key = "uploads/reserved-image.jpg"
    presign = h.handler(
        _function_url_event(
            {
                "action": "presign_upload",
                "object_key": object_key,
                "device_id": "device-12345",
            }
        ),
        {},
    )
    assert presign["statusCode"] == 200

    s3.put_object(
        Bucket="test-bucket",
        Key=object_key,
        Body=_make_rgb_image(),
        ContentType="image/jpeg",
    )

    with patch("handler.remove", return_value=_make_rgba_png()):
        response = h.handler(
            _function_url_event(
                {
                    "object_key": object_key,
                    "device_id": "device-12345",
                }
            ),
            {},
        )

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body["remaining_today"] == 4
    assert body["output_key"] == "outputs/reserved-image_sticker.png"


@mock_aws
def test_handler_missing_object_key() -> None:
    """Missing object_key in body → 400 error."""
    import handler as h  # noqa: PLC0415

    event = {"body": json.dumps({})}
    response = h.handler(event, {})
    assert response["statusCode"] == 400
    assert "object_key" in json.loads(response["body"])["error"]


@mock_aws
def test_handler_wrong_prefix() -> None:
    """object_key not under uploads/ → 400 error."""
    import handler as h  # noqa: PLC0415

    event = {"body": json.dumps({"object_key": "outputs/sneaky.jpg"})}
    response = h.handler(event, {})
    assert response["statusCode"] == 400


@mock_aws
def test_handler_file_not_in_s3() -> None:
    """S3 key doesn't exist → 502 error."""
    import handler as h  # noqa: PLC0415

    s3 = boto3.client("s3", region_name="ap-southeast-1")
    s3.create_bucket(
        Bucket="test-bucket",
        CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
    )

    event = {"body": json.dumps({"object_key": "uploads/does-not-exist.jpg"})}
    response = h.handler(event, {})
    assert response["statusCode"] == 502
