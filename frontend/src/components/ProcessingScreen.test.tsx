/**
 * ProcessingScreen.test.tsx
 * =========================
 * Component tests for ProcessingScreen covering:
 *   - Correct title per stage (resizing / uploading / processing)
 *   - Step icon states (pending, active spinner, completed checkmark)
 *   - Progress bar width driven by upload progress prop
 *   - isReady=true triggers animated step completion sequence
 *   - onComplete() is called after all animation delays
 *   - Steps 0-1 are marked done in processing stage (baseCompletedSteps)
 *   - Step 0 is marked done when stage transitions from resizing → uploading
 *   - Animated steps only fire when stage === 'processing'
 *
 * Stack: Vitest + @testing-library/react + jsdom
 * Note: vi.useFakeTimers() is used to control setTimeout delays.
 */

import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProcessingScreen } from "../components/ProcessingScreen";

// ── Stub child components ─────────────────────────────────────────────────────
vi.mock("../components/SceneBackground", () => ({
  SceneBackground: () => <div data-testid="scene-bg" />,
}));
vi.mock("../components/FooterCredit", () => ({
  FooterCredit: () => <footer data-testid="footer-credit" />,
}));

// react-icons stubs
vi.mock("react-icons/ri", () => ({
  RiCheckFill: () => <span data-testid="icon-check" />,
  RiLoader4Line: () => <span data-testid="icon-spinner" />,
  RiCircleLine: () => <span data-testid="icon-circle" />,
}));

// ── Timer helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Stage titles ──────────────────────────────────────────────────────────────

describe("ProcessingScreen — stage titles", () => {
  it.each([
    ["resizing", /resizing image/i],
    ["uploading", /uploading image/i],
    ["processing", /making your sticker/i],
  ] as const)("shows correct title for stage=%s", (stage, pattern) => {
    render(<ProcessingScreen stage={stage} />);
    expect(screen.getByRole("heading")).toHaveTextContent(pattern);
  });
});

// ── Step labels ───────────────────────────────────────────────────────────────

describe("ProcessingScreen — step labels", () => {
  it("renders all five step labels", () => {
    render(<ProcessingScreen stage="processing" />);

    expect(screen.getByText(/resizing image/i)).toBeInTheDocument();
    expect(screen.getByText(/sending to cloud/i)).toBeInTheDocument();
    expect(screen.getByText(/background removal/i)).toBeInTheDocument();
    expect(screen.getByText(/adding sticker border/i)).toBeInTheDocument();
    expect(screen.getByText(/finalising/i)).toBeInTheDocument();
  });
});

// ── Step icons per stage ──────────────────────────────────────────────────────

describe("ProcessingScreen — step icons: resizing stage", () => {
  it("step 0 (Resizing image) has the active spinner", () => {
    render(<ProcessingScreen stage="resizing" />);
    const spinners = screen.getAllByTestId("icon-spinner");
    // Only step 0 should be spinning
    expect(spinners).toHaveLength(1);
  });

  it("steps 1-4 show the pending circle icon", () => {
    render(<ProcessingScreen stage="resizing" />);
    const circles = screen.getAllByTestId("icon-circle");
    expect(circles).toHaveLength(4);
  });

  it("no steps show the checkmark yet", () => {
    render(<ProcessingScreen stage="resizing" />);
    expect(screen.queryAllByTestId("icon-check")).toHaveLength(0);
  });
});

describe("ProcessingScreen — step icons: uploading stage", () => {
  it("step 0 has a checkmark (resizing completed)", () => {
    render(<ProcessingScreen stage="uploading" progress={0} />);
    expect(screen.getAllByTestId("icon-check")).toHaveLength(1);
  });

  it("step 1 is active (spinner) while upload is in progress", () => {
    render(<ProcessingScreen stage="uploading" progress={50} />);
    const spinners = screen.getAllByTestId("icon-spinner");
    expect(spinners).toHaveLength(1);
  });

  it("step 1 gets a checkmark when progress reaches 100", () => {
    render(<ProcessingScreen stage="uploading" progress={100} />);
    expect(screen.getAllByTestId("icon-check")).toHaveLength(2);
  });
});

describe("ProcessingScreen — step icons: processing stage (no isReady)", () => {
  it("steps 0 and 1 have checkmarks", () => {
    render(<ProcessingScreen stage="processing" />);
    expect(screen.getAllByTestId("icon-check")).toHaveLength(2);
  });

  it("steps 2-4 are active spinners", () => {
    render(<ProcessingScreen stage="processing" />);
    expect(screen.getAllByTestId("icon-spinner")).toHaveLength(3);
  });
});

// ── Progress bar ──────────────────────────────────────────────────────────────

describe("ProcessingScreen — progress bar", () => {
  it("has no inline width style in resizing stage (CSS animation)", () => {
    const { container } = render(<ProcessingScreen stage="resizing" />);
    // The fill div must NOT have an inline width when CSS handles it
    const fills = container.querySelectorAll("[class*='progressFill']");
    fills.forEach((fill) => {
      expect((fill as HTMLElement).style.width).toBe("");
    });
  });

  it("sets inline width to 10% + upload% × 0.45 during upload", () => {
    const { container } = render(<ProcessingScreen stage="uploading" progress={100} />);
    const fill = container.querySelector("[class*='progressFillUploading']") as HTMLElement;
    expect(fill?.style.width).toBe("55%");
  });

  it("at progress=0 the upload fill is 10%", () => {
    const { container } = render(<ProcessingScreen stage="uploading" progress={0} />);
    const fill = container.querySelector("[class*='progressFillUploading']") as HTMLElement;
    expect(fill?.style.width).toBe("10%");
  });

  it("has no inline width in processing stage (CSS animation)", () => {
    const { container } = render(<ProcessingScreen stage="processing" />);
    const fill = container.querySelector("[class*='progressFillProcessing']") as HTMLElement;
    expect(fill?.style.width).toBe("");
  });
});

// ── isReady animation sequence ────────────────────────────────────────────────

describe("ProcessingScreen — isReady completion animation", () => {
  it("adds checkmarks for steps 2, 3, 4 progressively", () => {
    render(<ProcessingScreen stage="processing" isReady />);

    // Before any timers fire: steps 2-4 are still spinners
    expect(screen.getAllByTestId("icon-spinner")).toHaveLength(3);

    // After first delay (600ms): step 2 ticks
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getAllByTestId("icon-check")).toHaveLength(3); // 0, 1, 2

    // After second delay (1100ms): step 3 ticks
    act(() => { vi.advanceTimersByTime(500); }); // 600+500 = 1100ms total
    expect(screen.getAllByTestId("icon-check")).toHaveLength(4);

    // After third delay (1700ms): step 4 ticks
    act(() => { vi.advanceTimersByTime(600); }); // 1100+600 = 1700ms total
    expect(screen.getAllByTestId("icon-check")).toHaveLength(5);
  });

  it("calls onComplete after COMPLETE_DELAY (2300ms)", () => {
    const onComplete = vi.fn();
    render(<ProcessingScreen stage="processing" isReady onComplete={onComplete} />);

    act(() => { vi.advanceTimersByTime(2299); });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("does not call onComplete if stage is not processing", () => {
    const onComplete = vi.fn();
    render(<ProcessingScreen stage="uploading" isReady onComplete={onComplete} />);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── isReady=false should not start animation ──────────────────────────────────

describe("ProcessingScreen — isReady=false", () => {
  it("does not call onComplete if isReady is never set", () => {
    const onComplete = vi.fn();
    render(<ProcessingScreen stage="processing" isReady={false} onComplete={onComplete} />);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── Animation cleanup ─────────────────────────────────────────────────────────

describe("ProcessingScreen — timer cleanup", () => {
  it("does not call onComplete after unmount", () => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <ProcessingScreen stage="processing" isReady onComplete={onComplete} />,
    );

    unmount();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
