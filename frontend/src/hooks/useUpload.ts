import { useState, useCallback } from "react";
import {
  resizeImage,
  validateImageFile,
  generateUploadId,
} from "../utils/imageUtils";

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL as string;
const DEVICE_ID_STORAGE_KEY = "stickersnap_device_id";
const BACKEND_ENABLED = import.meta.env.VITE_BACKEND_ENABLED === "true";

type QuotaMetadata = {
  remainingToday?: number;
  resetAt?: string;
};

export type UploadState =
  | { status: "idle" }
  | { status: "resizing" }
  | { status: "uploading"; progress: number }
  | { status: "processing" }
  | ({ status: "ready"; stickerUrl: string; outputKey: string } & QuotaMetadata)
  | ({ status: "done"; stickerUrl: string; outputKey: string } & QuotaMetadata)
  | { status: "error"; message: string };

export function useUpload() {
  const [state, setState] = useState<UploadState>({ status: "idle" });

  const upload = useCallback(async (file: File) => {
    // 1. Validate
    const validation = validateImageFile(file);
    if (!validation.valid) {
      setState({ status: "error", message: validation.error! });
      return;
    }

    // 1.1 Kill switch to disable uploads if backend is down or under heavy load
    if (!BACKEND_ENABLED) {
      setState({
        status: "error",
        message:
          "Sticker generation is temporarily unavailable. Please check back soon.",
      });
      return;
    }

    try {
      // 2. Resize on canvas before upload
      setState({ status: "resizing" });
      const resized = await resizeImage(file, 1024);

      // 3. Upload to S3 via presigned PUT URL
      setState({ status: "uploading", progress: 0 });
      const deviceId = getDeviceId();
      const uploadId = generateUploadId();
      const objectKey = `uploads/${uploadId}.jpg`;

      // Get presigned PUT URL from Lambda
      const presignRes = await fetch(LAMBDA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "presign_upload",
          object_key: objectKey,
          device_id: deviceId,
        }),
      });

      if (!presignRes.ok) {
        const err = await readLambdaPayload(presignRes);
        throw new Error(
          formatUploadError(err, "Failed to get upload URL. Please try again."),
        );
      }

      const presignBody = await readLambdaPayload(presignRes);

      const { upload_url } = presignBody;
      if (!upload_url) {
        throw new Error(`No upload URL. Got: ${JSON.stringify(presignBody)}`);
      }

      // Upload directly to S3
      await uploadWithProgress(upload_url, resized, (progress) => {
        setState({ status: "uploading", progress });
      });

      // 4. Trigger Lambda processing
      setState({ status: "processing" });
      const processRes = await fetch(LAMBDA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_key: objectKey, device_id: deviceId }),
      });

      if (!processRes.ok) {
        const err = await readLambdaPayload(processRes);
        throw new Error(
          formatUploadError(err, "Processing failed. Please try again."),
        );
      }

      const body = await readLambdaPayload(processRes);

      if (!body.sticker_url) {
        throw new Error("No sticker URL returned. Please try again.");
      }

      // Move to "ready" — ProcessingScreen will tick through its completion
      // animation then call onComplete() which advances to "done".
      setState({
        status: "ready",
        stickerUrl: body.sticker_url,
        outputKey: body.output_key,
        remainingToday: body.remaining_today,
        resetAt: body.reset_at,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";
      setState({ status: "error", message });
    }
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  // Called by ProcessingScreen once the completion animation finishes.
  // Moves from "ready" → "done" so App renders the ResultScreen.
  const complete = useCallback(() => {
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      return { ...prev, status: "done" };
    });
  }, []);

  return { state, upload, reset, complete };
}

function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;

  const deviceId =
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
}

async function readLambdaPayload(
  response: Response,
): Promise<Record<string, any>> {
  const result = await response.json().catch(() => ({}));
  if (typeof result.body === "string") return JSON.parse(result.body);
  return result.body ?? result;
}

function formatUploadError(
  payload: Record<string, any>,
  fallback: string,
): string {
  if (payload.reset_at) {
    return `Sticker generation limit reached. You can make more after ${formatResetTime(payload.reset_at)}.`;
  }
  return payload.error || fallback;
}

function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "the next reset";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function uploadWithProgress(
  url: string,
  blob: Blob,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "image/jpeg");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(blob);
  });
}
