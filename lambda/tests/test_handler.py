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

# @mock_aws
# def test_handler_happy_path() -> None:
#     """Full happy path: upload in S3 → handler returns presigned URL."""
#     import importlib
#     import handler as h  # noqa: PLC0415

#     # Set up fake S3 bucket
#     s3 = boto3.client("s3", region_name="ap-southeast-1")
#     s3.create_bucket(
#         Bucket="test-bucket",
#         CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
#     )

#     # Put a test image in uploads/
#     image_bytes = _make_rgb_image()
#     s3.put_object(
#         Bucket="test-bucket",
#         Key="uploads/test-image.jpg",
#         Body=image_bytes,
#         ContentType="image/jpeg",
#     )

#     # Patch rembg.remove to return a predictable RGBA PNG (no model needed)
#     fake_rgba_bytes = _make_rgba_png()
#     with patch("handler.remove", return_value=fake_rgba_bytes):
#         event = {
#             "body": json.dumps({"object_key": "uploads/test-image.jpg"})
#         }
#         response = h.handler(event, {})

#     assert response["statusCode"] == 200
#     body = json.loads(response["body"])
#     assert "sticker_url" in body
#     assert "output_key" in body
#     assert body["output_key"].startswith("outputs/")
#     assert body["output_key"].endswith("_sticker.png")

#     # Verify the sticker was actually written to S3
#     s3.head_object(Bucket="test-bucket", Key=body["output_key"])


# @mock_aws
# def test_presign_upload_reserves_generation_quota(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """Presigning an upload reserves one generation and reports remaining quota."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h)

#     event = _function_url_event(
#         {
#             "action": "presign_upload",
#             "object_key": "uploads/quota-test.jpg",
#             "device_id": "device-12345",
#         }
#     )
#     response = h.handler(event, {})

#     assert response["statusCode"] == 200
#     body = json.loads(response["body"])
#     assert "upload_url" in body
#     assert body["remaining_today"] == 4
#     assert "reset_at" in body


# @mock_aws
# def test_presign_upload_returns_429_after_daily_device_limit(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """A device cannot reserve more generations than its daily limit."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h, daily_device_limit=1)

#     first = h.handler(
#         _function_url_event(
#             {
#                 "action": "presign_upload",
#                 "object_key": "uploads/first.jpg",
#                 "device_id": "device-12345",
#             }
#         ),
#         {},
#     )
#     second = h.handler(
#         _function_url_event(
#             {
#                 "action": "presign_upload",
#                 "object_key": "uploads/second.jpg",
#                 "device_id": "device-12345",
#             }
#         ),
#         {},
#     )

#     assert first["statusCode"] == 200
#     assert second["statusCode"] == 429
#     body = json.loads(second["body"])
#     assert body["remaining_today"] == 0
#     assert "reset_at" in body


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


# @mock_aws
# def test_handler_file_not_in_s3() -> None:
#     """S3 key doesn't exist → 502 error."""
#     import handler as h  # noqa: PLC0415

#     s3 = boto3.client("s3", region_name="ap-southeast-1")
#     s3.create_bucket(
#         Bucket="test-bucket",
#         CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
#     )

#     event = {"body": json.dumps({"object_key": "uploads/does-not-exist.jpg"})}
#     response = h.handler(event, {})
#     assert response["statusCode"] == 502

# ── new helpers test_handler ─────────────────────────────────────────

def _create_bucket(s3: Any) -> None:
    s3.create_bucket(
        Bucket="test-bucket",
        CreateBucketConfiguration={"LocationConstraint": "ap-southeast-1"},
    )


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
    daily_ip_limit: int = 10,
    hourly_ip_limit: int = 5,
) -> None:
    ddb = boto3.client("dynamodb", region_name="ap-southeast-1")
    _create_quota_table(ddb, table_name)
    monkeypatch.setattr(h, "_DDB", ddb)
    monkeypatch.setattr(h, "QUOTA_TABLE_NAME", table_name)
    monkeypatch.setattr(h, "DAILY_DEVICE_LIMIT", daily_device_limit)
    monkeypatch.setattr(h, "DAILY_IP_LIMIT", daily_ip_limit)
    monkeypatch.setattr(h, "HOURLY_IP_LIMIT", hourly_ip_limit)

def _function_url_event(body: dict[str, Any], source_ip: str = "203.0.113.10") -> dict[str, Any]:
    return {
        "body": json.dumps(body),
        "requestContext": {"http": {"sourceIp": source_ip}},
    }
 

def _presign(h: Any, object_key: str, device_id: str, source_ip: str = "203.0.113.10") -> dict[str, Any]:
    return h.handler(
        _function_url_event(
            {"action": "presign_upload", "object_key": object_key, "device_id": device_id},
            source_ip=source_ip,
        ),
        {},
    )


# ── CORS preflight ────────────────────────────────────────────────────────────


def test_cors_preflight_returns_204() -> None:
    """OPTIONS requests should receive a 204 CORS preflight response."""
    import handler as h  # noqa: PLC0415

    event = {"httpMethod": "OPTIONS"}
    response = h.handler(event, {})

    assert response["statusCode"] == 204
    headers = response["headers"]
    assert "Access-Control-Allow-Origin" in headers
    assert "POST" in headers["Access-Control-Allow-Methods"]


# ── _quota_windows ────────────────────────────────────────────────────────────


def test_quota_windows_day_key_format() -> None:
    """day_key must be formatted as YYYY-MM-DD."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from handler import _quota_windows  # noqa: PLC0415

    now = datetime(2025, 6, 15, 14, 30, 0, tzinfo=timezone.utc)
    day_key, hour_key, day_reset_at, day_ttl, hour_reset_at, hour_ttl = _quota_windows(now)

    assert day_key == "2025-06-15"
    assert hour_key == "2025-06-15T14"


def test_quota_windows_day_reset_is_next_midnight() -> None:
    """day_reset_at should be midnight of the following UTC day."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from handler import _quota_windows  # noqa: PLC0415

    now = datetime(2025, 6, 15, 23, 59, 59, tzinfo=timezone.utc)
    _, _, day_reset_at, _, _, _ = _quota_windows(now)

    assert day_reset_at == "2025-06-16T00:00:00Z"


def test_quota_windows_hour_reset_is_next_hour() -> None:
    """hour_reset_at should be the start of the next UTC hour."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from handler import _quota_windows  # noqa: PLC0415

    now = datetime(2025, 6, 15, 8, 45, 0, tzinfo=timezone.utc)
    _, _, _, _, hour_reset_at, _ = _quota_windows(now)

    assert hour_reset_at == "2025-06-15T09:00:00Z"


def test_quota_windows_ttl_is_in_future() -> None:
    """Both TTL values should be in the future relative to now."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from handler import _quota_windows  # noqa: PLC0415

    now = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    _, _, _, day_ttl, _, hour_ttl = _quota_windows(now)

    assert day_ttl > int(now.timestamp())
    assert hour_ttl > int(now.timestamp())


# ── _validate_and_hash_device_id ──────────────────────────────────────────────


def test_valid_device_id_returns_hex_hash() -> None:
    """A well-formed device_id should produce a 64-char hex SHA-256 hash."""
    from handler import _validate_and_hash_device_id  # noqa: PLC0415

    result = _validate_and_hash_device_id("device-abcdef123456")
    assert len(result) == 64
    assert all(c in "0123456789abcdef" for c in result)


def test_same_device_id_produces_same_hash() -> None:
    """Hashing is deterministic — same input always yields the same digest."""
    from handler import _validate_and_hash_device_id  # noqa: PLC0415

    a = _validate_and_hash_device_id("device-stable-id")
    b = _validate_and_hash_device_id("device-stable-id")
    assert a == b


def test_different_device_ids_produce_different_hashes() -> None:
    from handler import _validate_and_hash_device_id  # noqa: PLC0415

    a = _validate_and_hash_device_id("device-abc00000001")
    b = _validate_and_hash_device_id("device-abc00000002")
    assert a != b


@pytest.mark.parametrize(
    "bad_id",
    [
        "",           # empty
        "short",      # under 8 chars
        "has spaces here",
        "has/slash",
        "a" * 129,    # over 128 chars
    ],
)
def test_invalid_device_id_raises_value_error(bad_id: str) -> None:
    from handler import _validate_and_hash_device_id  # noqa: PLC0415

    with pytest.raises(ValueError, match="device_id"):
        _validate_and_hash_device_id(bad_id)


# ── _encode_png ───────────────────────────────────────────────────────────────


def test_encode_png_produces_valid_png_bytes() -> None:
    """_encode_png output should round-trip cleanly through Pillow."""
    from handler import _encode_png  # noqa: PLC0415

    img = Image.new("RGBA", (50, 50), color=(255, 0, 128, 200))
    png_bytes = _encode_png(img)

    # Must start with PNG magic bytes
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

    # Must round-trip correctly
    recovered = Image.open(io.BytesIO(png_bytes))
    assert recovered.mode == "RGBA"
    assert recovered.size == (50, 50)


def test_encode_png_is_lossless() -> None:
    """PNG encoding must preserve pixel values exactly."""
    import numpy as np  # noqa: PLC0415

    from handler import _encode_png  # noqa: PLC0415

    img = Image.new("RGBA", (10, 10), color=(10, 20, 30, 128))
    png_bytes = _encode_png(img)
    recovered = Image.open(io.BytesIO(png_bytes)).convert("RGBA")

    np.testing.assert_array_equal(np.array(img), np.array(recovered))


# ── IP quota limits ───────────────────────────────────────────────────────────


# @mock_aws
# def test_daily_ip_limit_blocks_second_device_same_ip(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """Two different devices from the same IP should be blocked once the
#     daily IP limit is reached."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h, daily_ip_limit=1, hourly_ip_limit=10)

#     first = _presign(h, "uploads/ip-test-1.jpg", "device-aaaaaaa0001", source_ip="10.0.0.1")
#     second = _presign(h, "uploads/ip-test-2.jpg", "device-bbbbbbb0001", source_ip="10.0.0.1")

#     assert first["statusCode"] == 200
#     assert second["statusCode"] == 429


# @mock_aws
# def test_hourly_ip_limit_blocks_excess_requests(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """Requests exceeding the hourly IP cap should be rejected with 429."""
#     import handler as h  # noqa: PLC0415

#     # hourly_ip_limit=1 means the second request within the same hour is blocked
#     _configure_quota(
#         monkeypatch, h,
#         daily_device_limit=10,
#         daily_ip_limit=10,
#         hourly_ip_limit=1,
#     )

#     first = _presign(h, "uploads/hourly-1.jpg", "device-aaaaaaa0002", source_ip="10.0.0.2")
#     second = _presign(h, "uploads/hourly-2.jpg", "device-bbbbbbb0002", source_ip="10.0.0.2")

#     assert first["statusCode"] == 200
#     assert second["statusCode"] == 429
#     body = json.loads(second["body"])
#     assert "reset_at" in body


# @mock_aws
# def test_different_ips_share_no_quota(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """Different IPs must not interfere with each other's quota counters."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h, daily_ip_limit=1, hourly_ip_limit=1)

#     r1 = _presign(h, "uploads/ip-a-1.jpg", "device-aaaaaaa0003", source_ip="192.168.1.1")
#     r2 = _presign(h, "uploads/ip-b-1.jpg", "device-bbbbbbb0003", source_ip="192.168.1.2")

#     assert r1["statusCode"] == 200
#     assert r2["statusCode"] == 200


# ── Duplicate reservation ─────────────────────────────────────────────────────


# @mock_aws
# def test_duplicate_presign_for_same_key_is_rejected(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """Presigning the same object_key twice must be rejected (prevents quota bypass)."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h)

#     first = _presign(h, "uploads/dup-test.jpg", "device-aaaaaaa0004")
#     second = _presign(h, "uploads/dup-test.jpg", "device-aaaaaaa0004")

#     assert first["statusCode"] == 200
#     assert second["statusCode"] == 400
#     body = json.loads(second["body"])
#     assert "already been reserved" in body["error"]


# ── Processing — invalid device_id ───────────────────────────────────────────


@mock_aws
def test_processing_with_invalid_device_id_returns_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A malformed device_id on the processing call should return 400."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h)

    response = h.handler(
        _function_url_event(
            {
                "object_key": "uploads/some-image.jpg",
                "device_id": "bad id!",
            }
        ),
        {},
    )

    assert response["statusCode"] == 400
    assert "device_id" in json.loads(response["body"])["error"]


# ── Oversized image rejection ─────────────────────────────────────────────────


@mock_aws
def test_handler_rejects_image_over_5mb(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Images larger than 5 MB stored in S3 must be rejected with 413."""
    import handler as h  # noqa: PLC0415

    _configure_quota(monkeypatch, h)

    s3 = boto3.client("s3", region_name="ap-southeast-1")
    monkeypatch.setattr(h, "_S3", s3)
    _create_bucket(s3)

    object_key = "uploads/oversized.jpg"

    # Reserve quota first
    presign_resp = _presign(h, object_key, "device-aaaaaaa0005")
    assert presign_resp["statusCode"] == 200

    # Put a >5 MB object in S3
    oversized = b"x" * (5 * 1024 * 1024 + 1)
    s3.put_object(Bucket="test-bucket", Key=object_key, Body=oversized)

    response = h.handler(
        _function_url_event({"object_key": object_key, "device_id": "device-aaaaaaa0005"}),
        {},
    )

    assert response["statusCode"] == 413
    assert "MB" in json.loads(response["body"])["error"]


# ── Quota remaining_today counts down correctly ───────────────────────────────


# @mock_aws
# def test_remaining_today_decrements_with_each_presign(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """remaining_today in presign responses should decrease by 1 each call."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h, daily_device_limit=3)

#     device = "device-countdown001"
#     r1 = h.handler(_function_url_event({"action": "presign_upload", "object_key": "uploads/c1.jpg", "device_id": device}), {})
#     r2 = h.handler(_function_url_event({"action": "presign_upload", "object_key": "uploads/c2.jpg", "device_id": device}), {})
#     r3 = h.handler(_function_url_event({"action": "presign_upload", "object_key": "uploads/c3.jpg", "device_id": device}), {})

#     assert json.loads(r1["body"])["remaining_today"] == 2
#     assert json.loads(r2["body"])["remaining_today"] == 1
#     assert json.loads(r3["body"])["remaining_today"] == 0


# ── x-forwarded-for header fallback ──────────────────────────────────────────


# @mock_aws
# def test_ip_extracted_from_x_forwarded_for_header(
#     monkeypatch: pytest.MonkeyPatch,
# ) -> None:
#     """When requestContext is absent, the IP must be read from x-forwarded-for."""
#     import handler as h  # noqa: PLC0415

#     _configure_quota(monkeypatch, h, daily_ip_limit=1, hourly_ip_limit=10)

#     # Event with no requestContext — IP comes from header
#     event_1 = {
#         "body": json.dumps({"action": "presign_upload", "object_key": "uploads/fwd1.jpg", "device_id": "device-fwd0000001"}),
#         "headers": {"x-forwarded-for": "172.16.0.1, 10.0.0.1"},
#     }
#     event_2 = {
#         "body": json.dumps({"action": "presign_upload", "object_key": "uploads/fwd2.jpg", "device_id": "device-fwd0000002"}),
#         "headers": {"x-forwarded-for": "172.16.0.1, 10.0.0.1"},
#     }

#     r1 = h.handler(event_1, {})
#     r2 = h.handler(event_2, {})

#     assert r1["statusCode"] == 200
#     # Same IP from header — second request blocked by daily_ip_limit=1
#     assert r2["statusCode"] == 429