import { useEffect, useState } from "react";
import { RiCheckFill, RiLoader4Line, RiCircleLine } from "react-icons/ri";
import { SceneBackground } from "./SceneBackground";

interface ProcessingScreenProps {
  stage: "resizing" | "uploading" | "processing";
  progress?: number;
  /** True once the Lambda result is in hand — triggers completion tick sequence */
  isReady?: boolean;
  /** Called after all processing steps have ticked to done */
  onComplete?: () => void;
}

// Steps — resizing owns step 0, upload owns step 1, processing owns steps 2-4
const STEPS = [
  { label: "Resizing image" },
  { label: "Sending to cloud" },
  { label: "Background removal" },
  { label: "Adding sticker border" },
  { label: "Finalising" },
] as const;

const STAGE_TITLES = {
  resizing: "Resizing image…",
  uploading: "Uploading image…",
  processing: "Making your sticker…",
};

/**
 * Overall 0-100 progress across all three stages:
 *   resizing   →  0 – 10  (CSS-animated indeterminate crawl)
 *   uploading  → 10 – 55  (driven by upload progress prop)
 *   processing → 55 – 100  (CSS-animated)
 */
function getOverallProgress(
  stage: ProcessingScreenProps["stage"],
  uploadProgress: number | undefined,
): number {
  if (stage === "resizing") return 0; // starting position; bar will CSS-animate to ~10
  if (stage === "uploading") {
    return 10 + Math.round((uploadProgress ?? 0) * 0.45);
  }
  return 55; // processing: CSS takes it from here to 100
}

function getCompletedSteps(
  stage: ProcessingScreenProps["stage"],
  uploadProgress: number | undefined,
): Set<number> {
  const done = new Set<number>();
  // step 0 = Resizing image
  if (stage === "uploading" || stage === "processing") done.add(0);
  // step 1 = Sending to cloud
  if (stage === "uploading" && (uploadProgress ?? 0) >= 100) done.add(1);
  if (stage === "processing") done.add(1);
  return done;
}

// Processing sub-steps (indices 2-4). Each ticks after a stagger delay once
// isReady fires. Total sequence: 600 + 1100 + 1700 = 1700ms, then 400ms pause
// before onComplete so the final tick is visible.
const PROCESSING_STEP_DELAYS = [600, 1100, 1700];
const COMPLETE_DELAY = PROCESSING_STEP_DELAYS[2] + 600;

export function ProcessingScreen({
  stage,
  progress,
  isReady,
  onComplete,
}: ProcessingScreenProps) {
  const overallProgress = getOverallProgress(stage, progress);
  const baseCompletedSteps = getCompletedSteps(stage, progress);

  // Track which processing sub-steps (indices 2,3,4) have been ticked by the
  // completion sequence. These are layered on top of baseCompletedSteps.
  const [animatedDoneSteps, setAnimatedDoneSteps] = useState<Set<number>>(
    new Set(),
  );

  useEffect(() => {
    if (!isReady || stage !== "processing") return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Tick each processing step with a stagger
    PROCESSING_STEP_DELAYS.forEach((delay, i) => {
      timers.push(
        setTimeout(() => {
          setAnimatedDoneSteps((prev) => new Set([...prev, i + 2]));
        }, delay),
      );
    });

    // Call onComplete after the last tick has had a moment to render
    timers.push(
      setTimeout(() => {
        onComplete?.();
      }, COMPLETE_DELAY),
    );

    return () => timers.forEach(clearTimeout);
  }, [isReady, stage, onComplete]);

  // Merge base completed steps with animation-driven ones
  const completedSteps = new Set([...baseCompletedSteps, ...animatedDoneSteps]);

  const title = STAGE_TITLES[stage];

  return (
    <>
      <SceneBackground />
      <div className="processing-screen">
        <div className="processing-screen__card">
          {/* Orbit animation */}
          <div className="processing-screen__animation">
            <div className="processing-screen__orbit">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="processing-screen__dot"
                  style={{ "--delay": `${i * 0.2}s` } as React.CSSProperties}
                />
              ))}
            </div>
            <div className="processing-screen__center">
              <span>✦</span>
            </div>
          </div>

          {/* Title + subtitle */}
          <div className="processing-screen__text">
            <h2 className="processing-screen__title">{title}</h2>
          </div>

          {/* Combined progress bar — always shown */}
          <div className="processing-screen__progress">
            <div className="processing-screen__progress-track">
              <div
                className={[
                  "processing-screen__progress-fill",
                  stage === "resizing"
                    ? "processing-screen__progress-fill--resizing"
                    : "",
                  stage === "uploading"
                    ? "processing-screen__progress-fill--uploading"
                    : "",
                  stage === "processing"
                    ? "processing-screen__progress-fill--processing"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  stage !== "resizing" && stage !== "processing"
                    ? { width: `${overallProgress}%` }
                    : undefined
                }
              />
            </div>
          </div>

          {/* Steps — always rendered; visibility/state varies by stage */}
          <div className="processing-screen__steps">
            {STEPS.map((step, i) => {
              const isDone = completedSteps.has(i);

              // Which step is "active" (blinking) right now
              const isActive =
                !isDone &&
                ((stage === "resizing" && i === 0) ||
                  (stage === "uploading" && i === 1) ||
                  (stage === "processing" && i >= 2));

              return (
                <div
                  key={step.label}
                  className={[
                    "processing-screen__step",
                    isDone ? "processing-screen__step--done" : "",
                    isActive ? "processing-screen__step--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span
                    className={[
                      "processing-screen__step-icon",
                      isActive ? "processing-screen__step-icon--spinning" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {isDone ? (
                      <RiCheckFill size={16} />
                    ) : isActive ? (
                      <RiLoader4Line size={16} />
                    ) : (
                      <RiCircleLine size={16} />
                    )}
                  </span>
                  <span className="processing-screen__step-label">
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <style>{`
          .processing-screen {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 32px 24px;
            gap: 12px;
            position: relative;
            z-index: 1;
          }

          /* ── Main card ─────────────────────────────────────────── */
          .processing-screen__card {
            background: var(--color-bg-card);
            border-radius: var(--radius-xl);
            padding: 48px 40px;
            box-shadow: var(--shadow-lg);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 28px;
            width: 100%;
            max-width: 340px;
            animation: card-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
          }

          @keyframes card-in {
            from { opacity: 0; transform: translateY(20px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }

          /* ── Orbit animation ───────────────────────────────────── */
          .processing-screen__animation {
            width: 96px;
            height: 96px;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .processing-screen__orbit {
            position: absolute;
            inset: 0;
            animation: orbit-spin 2s linear infinite;
          }

          @keyframes orbit-spin {
            to { transform: rotate(360deg); }
          }

          .processing-screen__dot {
            position: absolute;
            width: 8px;
            height: 8px;
            background: var(--color-accent);
            border-radius: 50%;
            animation: dot-pulse 1.6s ease-in-out infinite;
            animation-delay: var(--delay);
          }

          .processing-screen__dot:nth-child(1) { top: 0; left: 50%; transform: translateX(-50%); }
          .processing-screen__dot:nth-child(2) { right: 0; top: 50%; transform: translateY(-50%); }
          .processing-screen__dot:nth-child(3) { bottom: 0; left: 50%; transform: translateX(-50%); }
          .processing-screen__dot:nth-child(4) { left: 0; top: 50%; transform: translateY(-50%); }

          @keyframes dot-pulse {
            0%, 100% { opacity: 0.3; transform: scale(0.8) translateX(-50%); }
            50%       { opacity: 1;   transform: scale(1.2) translateX(-50%); }
          }

          .processing-screen__dot:nth-child(2) { animation-name: dot-pulse-side; }
          .processing-screen__dot:nth-child(3) { animation-name: dot-pulse-bottom; }
          .processing-screen__dot:nth-child(4) { animation-name: dot-pulse-side; }

          @keyframes dot-pulse-side {
            0%, 100% { opacity: 0.3; transform: scale(0.8) translateY(-50%); }
            50%       { opacity: 1;   transform: scale(1.2) translateY(-50%); }
          }
          @keyframes dot-pulse-bottom {
            0%, 100% { opacity: 0.3; transform: scale(0.8) translateX(-50%); }
            50%       { opacity: 1;   transform: scale(1.2) translateX(-50%); }
          }

          .processing-screen__center {
            width: 52px;
            height: 52px;
            background: var(--color-accent-light);
            border-radius: var(--radius-md);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 22px;
            color: var(--color-accent);
            animation: center-breathe 2s ease-in-out infinite;
            z-index: 1;
          }

          @keyframes center-breathe {
            0%, 100% { transform: scale(1); }
            50%       { transform: scale(1.06); }
          }

          /* ── Text ──────────────────────────────────────────────── */
          .processing-screen__text { text-align: center; }

          .processing-screen__title {
            font-family: var(--font-display);
            font-size: 20px;
            font-weight: 700;
            color: var(--color-ink);
            margin-bottom: 2px;
            letter-spacing: -0.3px;
          }

          .processing-screen__sub {
            font-size: 13px;
            color: var(--color-ink-secondary);
          }

          /* ── Progress bar ──────────────────────────────────────── */
          .processing-screen__progress {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 10px;
          }

          .processing-screen__progress-track {
            flex: 1;
            height: 6px;
            background: var(--color-bg-subtle);
            border-radius: var(--radius-full);
            overflow: hidden;
          }

          .processing-screen__progress-fill {
            height: 100%;
            background: var(--color-accent);
            border-radius: var(--radius-full);
            transition: width 0.4s ease;
          }

          /* Resizing: CSS-animated crawl from 5% → 10% */
          .processing-screen__progress-fill--resizing {
            animation: resizing-fill 1.5s ease-out forwards;
          }
          @keyframes resizing-fill {
            from { width: 0%; }
            to   { width: 10%; }
          }

          /* Uploading: CSS-animated crawl from 10% → 55% */
          .processing-screen__progress-fill--uploading {
            animation: uploading-fill 8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          }
          @keyframes uploading-fill {
            from { width: 10%; }
            to   { width: 55%; }
          }

          /* Processing: CSS-animated crawl from 55% → 100% */
          .processing-screen__progress-fill--processing {
            animation: processing-fill 8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          }
          @keyframes processing-fill {
            from { width: 55%; }
            to   { width: 100%; }
          }

          /* ── Steps ─────────────────────────────────────────────── */
          .processing-screen__steps {
            width: 100%;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .processing-screen__step {
            display: flex;
            align-items: center;
            gap: 10px;
            opacity: 0.35;
            transition: opacity 0.4s ease;
          }

          .processing-screen__step--active {
            opacity: 1;
          }

          .processing-screen__step--done {
            opacity: 1;
          }

          .processing-screen__step-icon {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            color: var(--color-ink-secondary);
            transition: color 0.3s ease;
          }

          .processing-screen__step--done .processing-screen__step-icon {
            color: var(--color-accent);
          }

          .processing-screen__step--active .processing-screen__step-icon {
            color: var(--color-accent);
          }

          .processing-screen__step-icon--spinning {
            animation: icon-spin 1s linear infinite;
          }

          @keyframes icon-spin {
            to { transform: rotate(360deg); }
          }

          .processing-screen__step-label {
            font-size: 13px;
            color: var(--color-ink-secondary);
            transition: color 0.4s ease;
          }

          .processing-screen__step--done .processing-screen__step-label {
            color: var(--color-ink);
            font-weight: 500;
          }

          .processing-screen__step--active .processing-screen__step-label {
            color: var(--color-ink);
          }
        `}</style>
      </div>
    </>
  );
}
