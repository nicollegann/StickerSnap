import { useCallback } from 'react';

export type ShareTarget = 'save' | 'copy' | 'telegram' | 'whatsapp' | 'share';

export function useShare() {
  /**
   * Download the sticker to the device gallery.
   */
  const saveToGallery = useCallback(async (stickerUrl: string): Promise<void> => {
    const res = await fetch(stickerUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sticker.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    navigator.vibrate?.(30);
  }, []);

  /**
   * Copy sticker PNG to clipboard.
   */
  const copyToClipboard = useCallback(async (stickerUrl: string): Promise<void> => {
    const res = await fetch(stickerUrl);
    const blob = await res.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    navigator.vibrate?.(30);
  }, []);

  /**
   * Native Web Share API — opens system share sheet on iOS/Android.
   * Falls back to saveToGallery if not supported.
   */
  const nativeShare = useCallback(async (stickerUrl: string): Promise<void> => {
    if (!navigator.share) {
      await saveToGallery(stickerUrl);
      return;
    }
    const res = await fetch(stickerUrl);
    const blob = await res.blob();
    const file = new File([blob], 'sticker.png', { type: 'image/png' });

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'My Sticker' });
    } else {
      await navigator.share({ url: stickerUrl, title: 'My Sticker' });
    }
    navigator.vibrate?.(30);
  }, [saveToGallery]);

  /**
   * Share to Telegram — opens native app share sheet with the file.
   * Deep links can't attach files directly, so we use Web Share API
   * which on mobile will offer Telegram as a target.
   */
  const shareToTelegram = useCallback(async (stickerUrl: string): Promise<void> => {
    if (navigator.share) {
      await nativeShare(stickerUrl);
    } else {
      // Desktop fallback — open Telegram Web with a share URL
      window.open(`https://t.me/share/url?url=${encodeURIComponent(stickerUrl)}`, '_blank');
    }
  }, [nativeShare]);

  /**
   * Share to WhatsApp — opens native share sheet.
   * On desktop, opens WhatsApp Web.
   */
  const shareToWhatsApp = useCallback(async (stickerUrl: string): Promise<void> => {
    if (navigator.share) {
      await nativeShare(stickerUrl);
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(stickerUrl)}`, '_blank');
    }
  }, [nativeShare]);

  const share = useCallback(async (target: ShareTarget, stickerUrl: string): Promise<void> => {
    switch (target) {
      case 'save': return saveToGallery(stickerUrl);
      case 'copy': return copyToClipboard(stickerUrl);
      case 'telegram': return shareToTelegram(stickerUrl);
      case 'whatsapp': return shareToWhatsApp(stickerUrl);
      case 'share': return nativeShare(stickerUrl);
    }
  }, [saveToGallery, copyToClipboard, shareToTelegram, shareToWhatsApp, nativeShare]);

  return { share };
}
