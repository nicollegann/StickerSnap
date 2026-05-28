/**
 * Resize an image file so its longest edge does not exceed maxDimension.
 * Returns a Blob (image/jpeg) ready for S3 upload.
 * Preserves aspect ratio; skips resize if image is already small enough.
 */
export async function resizeImage(
  file: File,
  maxDimension = 1024,
  quality = 0.88
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const { naturalWidth: w, naturalHeight: h } = img;
      const maxEdge = Math.max(w, h);

      let targetW = w;
      let targetH = h;

      if (maxEdge > maxDimension) {
        const scale = maxDimension / maxEdge;
        targetW = Math.round(w * scale);
        targetH = Math.round(h * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, targetW, targetH);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob failed'));
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Validate file is an accepted image type and under maxBytes.
 */
export function validateImageFile(
  file: File,
  maxBytes = 5 * 1024 * 1024
): { valid: boolean; error?: string } {
  const accepted = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
  if (!accepted.includes(file.type)) {
    return { valid: false, error: 'Please upload a JPEG, PNG, WebP, or HEIC image.' };
  }
  if (file.size > maxBytes) {
    return { valid: false, error: `Image must be under ${maxBytes / 1024 / 1024} MB.` };
  }
  return { valid: true };
}

/**
 * Generate a UUID v4 for use as upload key.
 */
export function generateUploadId(): string {
  return crypto.randomUUID();
}
