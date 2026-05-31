import { useState } from "react";
import { useShare, ShareTarget } from "../hooks/useShare";
import { SceneBackground } from "./SceneBackground";
import { FaFileDownload, FaCopy, FaShare, FaCheck } from "react-icons/fa";
import styles from "./ResultScreen.module.css";
import { FooterCredit } from "./FooterCredit";

interface ResultScreenProps {
  stickerUrl: string;
  remainingToday?: number;
  onReset: () => void;
}

type ActionState = "idle" | "loading" | "done" | "error";

interface ShareAction {
  id: ShareTarget;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  color: string;
}

const SHARE_ACTIONS: ShareAction[] = [
  { id: "save", label: "Save", icon: FaFileDownload, color: "#2D9E6B" },
  { id: "copy", label: "Copy", icon: FaCopy, color: "#5B7FFF" },
  { id: "share", label: "Share", icon: FaShare, color: "#2AABEE" },
];

export function ResultScreen({
  stickerUrl,
  remainingToday,
  onReset,
}: ResultScreenProps) {
  const { share } = useShare();
  const limitReached = remainingToday === 0;
  const [actionStates, setActionStates] = useState<
    Record<ShareTarget, ActionState>
  >({
    save: "idle",
    copy: "idle",
    share: "idle",
  });

  const handleShare = async (target: ShareTarget) => {
    setActionStates((s) => ({ ...s, [target]: "loading" }));
    try {
      await share(target, stickerUrl);
      setActionStates((s) => ({ ...s, [target]: "done" }));
      setTimeout(() => {
        setActionStates((s) => ({ ...s, [target]: "idle" }));
      }, 2000);
    } catch {
      setActionStates((s) => ({ ...s, [target]: "error" }));
      setTimeout(() => {
        setActionStates((s) => ({ ...s, [target]: "idle" }));
      }, 2000);
    }
  };

  return (
    <>
      <SceneBackground />
      <div className={styles.resultScreen}>
        {/* Sticker preview */}
        <div className={styles.previewWrap}>
          <div className={styles.previewBg} />
          <img
            src={stickerUrl}
            alt="Your sticker"
            className={styles.sticker}
            draggable={false}
          />
        </div>

        {/* Title */}
        <div className={styles.header}>
          <h2 className={styles.title}>Your sticker is ready!</h2>
          <p className={styles.sub}>Save it or share it directly</p>
        </div>

        {/* Share grid */}
        <div className={styles.actions}>
          {SHARE_ACTIONS.map((action) => {
            const state = actionStates[action.id];
            return (
              <button
                key={action.id}
                className={[
                  styles.actionBtn,
                  state === "done" ? styles.actionBtnDone : "",
                  state === "loading" ? styles.actionBtnLoading : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleShare(action.id)}
                disabled={state === "loading"}
                style={
                  { "--action-color": action.color } as React.CSSProperties
                }
              >
                <span className={styles.actionIcon}>
                  {state === "loading" ? (
                    "…"
                  ) : state === "done" ? (
                    <FaCheck size={18} />
                  ) : (
                    <action.icon size={18} />
                  )}
                </span>
                <span className={styles.actionLabel}>{action.label}</span>
              </button>
            );
          })}
        </div>

        {/* Try another */}
        <button
          className={styles.resetBtn}
          onClick={onReset}
          disabled={limitReached}
        >
          <span>✦</span>{" "}
          {limitReached ? "Daily limit reached" : "Make another sticker"}
        </button>
      </div>
      <FooterCredit />
    </>
  );
}
