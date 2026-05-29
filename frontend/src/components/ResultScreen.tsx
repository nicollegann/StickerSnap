import { useState } from "react";
import { useShare, ShareTarget } from "../hooks/useShare";
import { SceneBackground } from "./SceneBackground";
import { FaFileDownload, FaCopy, FaShare, FaCheck } from "react-icons/fa";

interface ResultScreenProps {
  stickerUrl: string;
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

export function ResultScreen({ stickerUrl, onReset }: ResultScreenProps) {
  const { share } = useShare();
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
      <div className="result-screen">
        {/* Sticker preview */}
        <div className="result-screen__preview-wrap">
          <div className="result-screen__preview-bg" />
          <img
            src={stickerUrl}
            alt="Your sticker"
            className="result-screen__sticker"
            draggable={false}
          />
        </div>

        {/* Title */}
        <div className="result-screen__header">
          <h2 className="result-screen__title">Your sticker is ready!</h2>
          <p className="result-screen__sub">Save it or share it directly</p>
        </div>

        {/* Share grid */}
        <div className="result-screen__actions">
          {SHARE_ACTIONS.map((action) => {
            const state = actionStates[action.id];
            return (
              <button
                key={action.id}
                className={`result-screen__action-btn result-screen__action-btn--${state}`}
                onClick={() => handleShare(action.id)}
                disabled={state === "loading"}
                style={
                  { "--action-color": action.color } as React.CSSProperties
                }
              >
                <span className="result-screen__action-icon">
                  {state === "loading" ? (
                    "…"
                  ) : state === "done" ? (
                    <FaCheck size={18} />
                  ) : (
                    <action.icon size={18} />
                  )}
                </span>
                <span className="result-screen__action-label">
                  {action.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Try another */}
        <button className="result-screen__reset-btn" onClick={onReset}>
          <span>✦</span> Make another sticker
        </button>

        <style>{`
          .result-screen {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 32px 24px 40px;
            gap: 28px;
            max-width: 480px;
            margin: 0 auto;
            width: 100%;
            animation: result-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
            position: relative;
            z-index: 1;
          }

          @keyframes result-in {
            from { opacity: 0; transform: translateY(24px); }
            to { opacity: 1; transform: translateY(0); }
          }

          /* Sticker preview */
          .result-screen__preview-wrap {
            position: relative;
            width: 240px;
            height: 240px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1.5px solid var(--color-border);
            border-radius: var(--radius-xl);
            background: var(--color-bg-card);
            box-shadow: var(--shadow-md);
          }

          .result-screen__preview-bg {
            position: absolute;
            inset: 0;
            border-radius: var(--radius-xl);
            background: repeating-conic-gradient(#E8E4DE 0% 25%, #F0EDE8 0% 50%) 0 0 / 20px 20px;
            opacity: 0.7;
          }

          .result-screen__sticker {
            position: relative;
            max-width: 200px;
            max-height: 200px;
            object-fit: contain;
            filter: drop-shadow(0 8px 24px rgba(26,23,20,0.15));
            animation: sticker-float 3s ease-in-out infinite;
            z-index: 1;
          }

          @keyframes sticker-float {
            0%, 100% { transform: translateY(0) rotate(-1deg); }
            50% { transform: translateY(-8px) rotate(1deg); }
          }

          /* Header */
          .result-screen__header { text-align: center; }

          .result-screen__title {
            font-family: var(--font-display);
            font-size: 22px;
            font-weight: 700;
            color: var(--color-ink);
            letter-spacing: -0.4px;
            margin-bottom: 4px;
          }

          .result-screen__sub {
            font-size: 14px;
            color: var(--color-ink-secondary);
          }

          /* Share actions grid */
          .result-screen__actions {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            width: 70%;
          }

          .result-screen__action-btn {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            padding: 16px 8px;
            background: var(--color-bg-card);
            border-radius: var(--radius-lg);
            border: 1.5px solid var(--color-border);
            transition: all var(--transition-spring);
            box-shadow: var(--shadow-sm);
            position: relative;
            overflow: hidden;
          }

          .result-screen__action-btn::before {
            content: '';
            position: absolute;
            inset: 0;
            background: var(--action-color);
            opacity: 0;
            transition: opacity var(--transition-base);
          }

          .result-screen__action-btn:hover::before { opacity: 0.06; }
          .result-screen__action-btn:active { transform: scale(0.96); }

          .result-screen__action-btn--done {
            border-color: var(--action-color);
            background: color-mix(in srgb, var(--action-color) 8%, white);
          }

          .result-screen__action-btn--loading {
            opacity: 0.6;
          }

          .result-screen__action-icon {
            width: 40px;
            height: 40px;
            border-radius: var(--radius-md);
            background: color-mix(in srgb, var(--action-color) 12%, white);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            color: var(--action-color);
            position: relative;
            z-index: 1;
            transition: transform var(--transition-spring);
          }

          .result-screen__action-icon svg {
            width: 18px;
            height: 18px;
          }

          .result-screen__action-btn:hover .result-screen__action-icon {
            transform: scale(1.1);
          }

          .result-screen__action-label {
            font-size: 11px;
            font-weight: 500;
            color: var(--color-ink-secondary);
            position: relative;
            z-index: 1;
            letter-spacing: 0.01em;
          }

          /* Reset button */
          .result-screen__reset-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 14px 28px;
            background: var(--color-ink);
            color: white;
            border-radius: var(--radius-full);
            font-family: var(--font-display);
            font-size: 15px;
            font-weight: 600;
            letter-spacing: -0.2px;
            transition: all var(--transition-spring);
            box-shadow: var(--shadow-md);
          }

          .result-screen__reset-btn:hover {
            background: var(--color-accent);
            transform: translateY(-2px);
            box-shadow: var(--shadow-accent);
          }

          .result-screen__reset-btn:active {
            transform: translateY(0) scale(0.97);
          }

          .result-screen__reset-btn span {
            color: var(--color-accent);
            transition: color var(--transition-base);
          }

          .result-screen__reset-btn:hover span {
            color: white;
          }
        `}</style>
      </div>
    </>
  );
}
