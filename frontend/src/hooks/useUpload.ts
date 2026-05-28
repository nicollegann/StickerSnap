import { useState, useCallback } from "react";
import {
  resizeImage,
  validateImageFile,
  generateUploadId,
} from "../utils/imageUtils";

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL as string;

export type UploadState =
  | { status: "idle" }
  | { status: "resizing" }
  | { status: "uploading"; progress: number }
  | { status: "processing" }
  | { status: "done"; stickerUrl: string; outputKey: string }
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

    try {
      // 2. Resize on canvas before upload
      setState({ status: "resizing" });
      const resized = await resizeImage(file, 1024);

      // 3. Upload to S3 via presigned PUT URL
      setState({ status: "uploading", progress: 0 });
      const uploadId = generateUploadId();
      const objectKey = `uploads/${uploadId}.jpg`;

      // Get presigned PUT URL from Lambda
      const presignRes = await fetch(LAMBDA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "presign_upload",
          object_key: objectKey,
        }),
      });

      if (!presignRes.ok) {
        throw new Error("Failed to get upload URL. Please try again.");
      }

      const presignData = await presignRes.json();
      console.log("presignData raw:", presignData); // remove after debugging

      const presignBody = presignData.upload_url
        ? presignData // already unwrapped
        : typeof presignData.body === "string"
          ? JSON.parse(presignData.body) // double-wrapped
          : (presignData.body ?? presignData); // object body or fallback

      const { upload_url } = presignBody;
      if (!upload_url) {
        throw new Error(`No upload URL. Got: ${JSON.stringify(presignData)}`); // better error message
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
        body: JSON.stringify({ object_key: objectKey }),
      });

      if (!processRes.ok) {
        const err = await processRes.json().catch(() => ({}));
        throw new Error(err.error || "Processing failed. Please try again.");
      }

      const result = await processRes.json();
      const body =
        typeof result.body === "string" ? JSON.parse(result.body) : result;

      if (!body.sticker_url) {
        throw new Error("No sticker URL returned. Please try again.");
      }

      setState({
        status: "done",
        stickerUrl: body.sticker_url,
        outputKey: body.output_key,
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

  return { state, upload, reset };
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
