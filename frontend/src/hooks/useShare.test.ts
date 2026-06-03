/**
 * useShare.test.ts
 * ================
 * Tests for the useShare hook covering:
 *   - saveToGallery: creates and clicks an <a> element, revokes the object URL
 *   - copyToClipboard: writes a PNG blob to the clipboard
 *   - nativeShare (file-capable): calls navigator.share with a File
 *   - nativeShare (URL fallback): calls navigator.share with a URL when canShare(files) is false
 *   - nativeShare (no API): falls back to saveToGallery when navigator.share is absent
 *   - share() dispatches to the correct target
 *   - navigator.vibrate is called after each action
 *
 * Stack: Vitest + @testing-library/react (renderHook) + jsdom
 */

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShare, type ShareTarget } from "../hooks/useShare";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STICKER_URL = "https://cdn.test/sticker.png";
const FAKE_BLOB = new Blob(["png-data"], { type: "image/png" });
const FAKE_OBJECT_URL = "blob:https://cdn.test/fake-object-url";

function stubFetch(blob = FAKE_BLOB) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      blob: vi.fn().mockResolvedValue(blob),
    } as unknown as Response),
  );
}

function stubUrlApi() {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => FAKE_OBJECT_URL),
    revokeObjectURL: vi.fn(),
  });
}

/**
 * Creates a real <a> DOM element (so jsdom's appendChild type-check passes),
 * spies on .click(), and intercepts createElement so only 'a' tags return it.
 * Returns both the spy-enhanced anchor and the createElement spy for cleanup.
 */
function stubAnchor() {
  const anchor = document.createElement("a");
  vi.spyOn(anchor, "click").mockImplementation(() => {});

  const realCreate = document.createElement.bind(document);
  const createElSpy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tag: string, ...args: any[]) =>
      tag === "a" ? anchor : realCreate(tag, ...args),
    );

  return { anchor, createElSpy };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  stubFetch();
  stubUrlApi();

  // jsdom doesn't implement navigator.vibrate — define it before spying.
  if (!("vibrate" in navigator)) {
    Object.defineProperty(navigator, "vibrate", {
      value: () => true,
      writable: true,
      configurable: true,
    });
  }
  vi.spyOn(navigator, "vibrate").mockReturnValue(true);

  // jsdom doesn't implement ClipboardItem — stub it globally.
  if (typeof globalThis.ClipboardItem === "undefined") {
    (globalThis as any).ClipboardItem = class ClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    };
  }
});

// ── saveToGallery ─────────────────────────────────────────────────────────────

describe("saveToGallery", () => {
  it("fetches the sticker URL with cache: no-store", async () => {
    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("save", STICKER_URL));

    expect(fetch).toHaveBeenCalledWith(STICKER_URL, { cache: "no-store" });
  });

  it("creates and clicks a download anchor", async () => {
    const { anchor } = stubAnchor();

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("save", STICKER_URL));

    expect(anchor.href).toBe(FAKE_OBJECT_URL);
    expect(anchor.download).toBe("sticker.png");
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("revokes the object URL after the download", async () => {
    stubAnchor();

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("save", STICKER_URL));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_OBJECT_URL);
  });

  it("triggers a short vibration", async () => {
    stubAnchor();

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("save", STICKER_URL));

    expect(navigator.vibrate).toHaveBeenCalledWith(30);
  });
});

// ── copyToClipboard ───────────────────────────────────────────────────────────

describe("copyToClipboard", () => {
  it("fetches with cors + no-store", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { write: vi.fn().mockResolvedValue(undefined) },
      vibrate: vi.fn(),
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("copy", STICKER_URL));

    expect(fetch).toHaveBeenCalledWith(STICKER_URL, {
      mode: "cors",
      cache: "no-store",
    });
  });

  it("writes a ClipboardItem with image/png to the clipboard", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { write: clipboardWrite },
      vibrate: vi.fn(),
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("copy", STICKER_URL));

    expect(clipboardWrite).toHaveBeenCalledOnce();
    const [items] = clipboardWrite.mock.calls[0] as [ClipboardItem[]];
    expect(items).toHaveLength(1);
  });

  it("triggers vibration after copying", async () => {
    const vibrateSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { write: vi.fn().mockResolvedValue(undefined) },
      vibrate: vibrateSpy,
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("copy", STICKER_URL));

    expect(vibrateSpy).toHaveBeenCalledWith(30);
  });
});

// ── nativeShare ───────────────────────────────────────────────────────────────

describe("nativeShare — full file share", () => {
  it("calls navigator.share with a File when canShare(files) returns true", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      share: shareSpy,
      canShare: vi.fn().mockReturnValue(true),
      vibrate: vi.fn(),
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("share", STICKER_URL));

    expect(shareSpy).toHaveBeenCalledOnce();
    const [shareData] = shareSpy.mock.calls[0] as [ShareData];
    expect(shareData.files).toBeDefined();
    expect(shareData.files![0]).toBeInstanceOf(File);
    expect((shareData.files![0] as File).name).toBe("sticker.png");
  });
});

describe("nativeShare — URL fallback (canShare files = false)", () => {
  it("falls back to sharing by URL when canShare(files) is false", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      share: shareSpy,
      canShare: vi.fn().mockReturnValue(false),
      vibrate: vi.fn(),
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("share", STICKER_URL));

    expect(shareSpy).toHaveBeenCalledWith({
      url: STICKER_URL,
      title: "My Sticker",
    });
  });
});

describe("nativeShare — no Web Share API", () => {
  it("falls back to saveToGallery when navigator.share is undefined", async () => {
    const { anchor } = stubAnchor();

    vi.stubGlobal("navigator", {
      ...navigator,
      share: undefined,
      vibrate: vi.fn(),
    });

    const { result } = renderHook(() => useShare());
    await act(() => result.current.share("share", STICKER_URL));

    expect(anchor.click).toHaveBeenCalledOnce();
  });
});

// ── share() dispatch ──────────────────────────────────────────────────────────

describe("share() target dispatch", () => {
  it.each<ShareTarget>(["save", "copy", "share"])(
    "does not throw for target=%s",
    async (target) => {
      vi.stubGlobal("navigator", {
        ...navigator,
        clipboard: { write: vi.fn().mockResolvedValue(undefined) },
        share: vi.fn().mockResolvedValue(undefined),
        canShare: vi.fn().mockReturnValue(true),
        vibrate: vi.fn(),
      });
      stubAnchor();

      const { result } = renderHook(() => useShare());
      await expect(
        act(() => result.current.share(target, STICKER_URL)),
      ).resolves.toBeUndefined();
    },
  );
});
