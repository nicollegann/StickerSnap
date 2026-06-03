/**
 * UploadScreen.test.tsx
 * =====================
 * Component tests for UploadScreen covering:
 *   - Renders logo, tagline, and usage hint
 *   - Click on dropzone triggers the hidden file input
 *   - Drag-and-drop delivers the file via onFile
 *   - Non-image files are silently ignored (onFile not called)
 *   - isDragging CSS class toggled on dragover / dragleave
 *   - Keyboard Enter on dropzone triggers file picker
 *   - "Great for" example pills are rendered
 *   - Accepts the correct MIME types on the <input>
 *
 * Stack: Vitest + @testing-library/react + jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { UploadScreen } from "../components/UploadScreen";

// ── Stub child components that have their own render concerns ─────────────────
vi.mock("../components/SceneBackground", () => ({
  SceneBackground: () => <div data-testid="scene-bg" />,
}));
vi.mock("../components/FooterCredit", () => ({
  FooterCredit: () => <footer data-testid="footer-credit" />,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name: string, type: string): File {
  return new File(["data"], name, { type });
}

function setup(onFile = vi.fn()) {
  const utils = render(<UploadScreen onFile={onFile} />);
  const dropzone = screen.getByRole("button", { name: /upload a photo/i });
  return { ...utils, dropzone, onFile };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe("UploadScreen — rendering", () => {
  it("shows the StickerSnap logo", () => {
    setup();
    expect(screen.getByText("StickerSnap")).toBeInTheDocument();
  });

  it("shows the tagline", () => {
    setup();
    expect(screen.getByText(/turn any photo into a sticker/i)).toBeInTheDocument();
  });

  it("shows the default dropzone label", () => {
    setup();
    expect(screen.getByText(/tap to choose a photo/i)).toBeInTheDocument();
  });

  it("shows the file format hint", () => {
    setup();
    expect(screen.getByText(/jpeg.*png.*webp.*heic/i)).toBeInTheDocument();
  });

  it("shows the limited free usage banner", () => {
    setup();
    expect(screen.getByText(/limited free usage/i)).toBeInTheDocument();
  });

  it("renders all four example pills", () => {
    setup();
    expect(screen.getByText(/pets/i)).toBeInTheDocument();
    expect(screen.getByText(/people/i)).toBeInTheDocument();
    expect(screen.getByText(/objects/i)).toBeInTheDocument();
    expect(screen.getByText(/food/i)).toBeInTheDocument();
  });

  it("hides the file input from assistive technology", () => {
    setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input).toHaveAttribute("aria-hidden", "true");
  });

  it("accepts the expected MIME types", () => {
    setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const accept = input.getAttribute("accept") ?? "";
    expect(accept).toContain("image/jpeg");
    expect(accept).toContain("image/png");
    expect(accept).toContain("image/webp");
    expect(accept).toContain("image/heic");
  });
});

// ── File selection via click ──────────────────────────────────────────────────

describe("UploadScreen — file input click", () => {
  it("calls onFile when a valid image is selected via the file input", async () => {
    const user = userEvent.setup();
    const { onFile } = setup();
    const file = makeFile("photo.jpg", "image/jpeg");
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;

    await user.upload(input, file);

    expect(onFile).toHaveBeenCalledOnce();
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("does not call onFile when a non-image is selected", async () => {
    const user = userEvent.setup();
    const { onFile } = setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;

    await user.upload(input, makeFile("doc.pdf", "application/pdf"));
    expect(onFile).not.toHaveBeenCalled();
  });
});

// ── Drag and drop ─────────────────────────────────────────────────────────────

describe("UploadScreen — drag and drop", () => {
  it("calls onFile when an image is dropped", () => {
    const { dropzone, onFile } = setup();
    const file = makeFile("cat.png", "image/png");

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [file] },
    });

    expect(onFile).toHaveBeenCalledOnce();
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("does not call onFile when a non-image is dropped", () => {
    const { dropzone, onFile } = setup();

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [makeFile("spreadsheet.xlsx", "application/vnd.openxmlformats")] },
    });

    expect(onFile).not.toHaveBeenCalled();
  });

  it("shows 'Drop it here' label during drag-over", () => {
    const { dropzone } = setup();

    fireEvent.dragOver(dropzone);

    expect(screen.getByText(/drop it here/i)).toBeInTheDocument();
  });

  it("reverts label to default after drag-leave", () => {
    const { dropzone } = setup();

    fireEvent.dragOver(dropzone);
    fireEvent.dragLeave(dropzone);

    expect(screen.getByText(/tap to choose a photo/i)).toBeInTheDocument();
  });
});

// ── Keyboard accessibility ────────────────────────────────────────────────────

describe("UploadScreen — keyboard", () => {
  it("triggers the file input on Enter key", () => {
    const { dropzone } = setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.keyDown(dropzone, { key: "Enter" });

    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("does not trigger the file input on other keys", () => {
    const { dropzone } = setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.keyDown(dropzone, { key: "Space" });
    fireEvent.keyDown(dropzone, { key: "Escape" });

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ── Limit banner stop-propagation ─────────────────────────────────────────────

describe("UploadScreen — limit banner", () => {
  it("clicking the limit banner does not open the file picker", () => {
    const { onFile } = setup();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const clickSpy = vi.spyOn(input, "click");

    const banner = screen.getByText(/limited free usage/i);
    fireEvent.click(banner);

    // stopPropagation on the banner prevents the dropzone onClick
    expect(clickSpy).not.toHaveBeenCalled();
    expect(onFile).not.toHaveBeenCalled();
  });
});
