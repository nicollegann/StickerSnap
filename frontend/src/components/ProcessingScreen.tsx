import { useEffect, useState } from "react";
import { RiCheckFill, RiLoader4Line, RiCircleLine } from "react-icons/ri";
import { SceneBackground } from "./SceneBackground";
import styles from "./ProcessingScreen.module.css";
import { FooterCredit } from "./FooterCredit";

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
  if (stage === "resizing") return 0;
  if (stage === "uploading") {
    return 10 + Math.round((uploadProgress ?? 0) * 0.45);
  }
  return 55;
}

function getCompletedSteps(
  stage: ProcessingScreenProps["stage"],
  uploadProgress: number | undefined,
): Set<number> {
  const done = new Set<number>();
  if (stage === "uploading" || stage === "processing") done.add(0);
  if (stage === "uploading" && (uploadProgress ?? 0) >= 100) done.add(1);
  if (stage === "processing") done.add(1);
  return done;
}

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

  const [animatedDoneSteps, setAnimatedDoneSteps] = useState<Set<number>>(
    new Set(),
  );

  useEffect(() => {
    if (!isReady || stage !== "processing") return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    PROCESSING_STEP_DELAYS.forEach((delay, i) => {
      timers.push(
        setTimeout(() => {
          setAnimatedDoneSteps((prev) => new Set([...prev, i + 2]));
        }, delay),
      );
    });

    timers.push(
      setTimeout(() => {
        onComplete?.();
      }, COMPLETE_DELAY),
    );

    return () => timers.forEach(clearTimeout);
  }, [isReady, stage, onComplete]);

  const completedSteps = new Set([...baseCompletedSteps, ...animatedDoneSteps]);
  const title = STAGE_TITLES[stage];

  return (
    <>
      <SceneBackground />
      <div className={styles.processingScreen}>
        <div className={styles.card}>
          {/* Orbit animation */}
          <div className={styles.animation}>
            <div className={styles.orbit}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={styles.dot}
                  style={{ "--delay": `${i * 0.2}s` } as React.CSSProperties}
                />
              ))}
            </div>
            <div className={styles.center}>
              <span>✦</span>
            </div>
          </div>

          {/* Title */}
          <div className={styles.text}>
            <h2 className={styles.title}>{title}</h2>
          </div>

          {/* Progress bar */}
          <div className={styles.progress}>
            <div className={styles.progressTrack}>
              <div
                className={[
                  styles.progressFill,
                  stage === "resizing" ? styles.progressFillResizing : "",
                  stage === "uploading" ? styles.progressFillUploading : "",
                  stage === "processing" ? styles.progressFillProcessing : "",
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

          {/* Steps */}
          <div className={styles.steps}>
            {STEPS.map((step, i) => {
              const isDone = completedSteps.has(i);
              const isActive =
                !isDone &&
                ((stage === "resizing" && i === 0) ||
                  (stage === "uploading" && i === 1) ||
                  (stage === "processing" && i >= 2));

              return (
                <div
                  key={step.label}
                  className={[
                    styles.step,
                    isDone ? styles.stepDone : "",
                    isActive ? styles.stepActive : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span
                    className={[
                      styles.stepIcon,
                      isDone ? styles.stepIconDone : "",
                      isActive ? styles.stepIconActive : "",
                      isActive ? styles.stepIconSpinning : "",
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
                  <span
                    className={[
                      styles.stepLabel,
                      isDone ? styles.stepLabelDone : "",
                      isActive ? styles.stepLabelActive : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <FooterCredit />
    </>
  );
}
