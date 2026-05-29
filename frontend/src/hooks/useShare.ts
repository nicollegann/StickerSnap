import { useCallback } from "react";

export type ShareTarget = "save" | "copy" | "share";

export function useShare() {
  /**
   * Download the sticker to the device gallery.
   */
  const saveToGallery = useCallback(
    async (stickerUrl: string): Promise<void> => {
      const res = await fetch(stickerUrl, { cache: "no-store" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sticker.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      navigator.vibrate?.(30);
    },
    [],
  );

  /**
   * Copy sticker PNG to clipboard.
   */
  const copyToClipboard = useCallback(
    async (stickerUrl: string): Promise<void> => {
      const res = await fetch(stickerUrl, { mode: "cors", cache: "no-store" });
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      navigator.vibrate?.(30);
    },
    [],
  );

  /**
   * Native Web Share API — opens system share sheet on iOS/Android.
   * Falls back to saveToGallery if not supported.
   */
  const nativeShare = useCallback(
    async (stickerUrl: string): Promise<void> => {
      if (!navigator.share) {
        await saveToGallery(stickerUrl);
        return;
      }
      const res = await fetch(stickerUrl, { cache: "no-store" });
      const blob = await res.blob();

      const file = new File([blob], "sticker.png", { type: "image/png" });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        await navigator.share({ url: stickerUrl, title: "My Sticker" });
      }
      navigator.vibrate?.(30);
    },
    [saveToGallery],
  );

  const share = useCallback(
    async (target: ShareTarget, stickerUrl: string): Promise<void> => {
      switch (target) {
        case "save":
          return saveToGallery(stickerUrl);
        case "copy":
          return copyToClipboard(stickerUrl);
        case "share":
          return nativeShare(stickerUrl);
      }
    },
    [saveToGallery, copyToClipboard, nativeShare],
  );

  return { share };
}
