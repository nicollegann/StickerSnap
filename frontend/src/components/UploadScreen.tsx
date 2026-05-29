import { useRef, useState, DragEvent, ChangeEvent } from "react";
import { SceneBackground } from "./SceneBackground";

interface UploadScreenProps {
  onFile: (file: File) => void;
}

export function UploadScreen({ onFile }: UploadScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    onFile(file);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  return (
    <>
      <SceneBackground />
      <div className="upload-screen">
        <div className="upload-screen__header">
          <div className="upload-screen__logo">
            <span className="upload-screen__logo-icon">✦</span>
            <span className="upload-screen__logo-text">StickerSnap</span>
          </div>
          <p className="upload-screen__tagline">
            Turn any photo into a sticker
          </p>
        </div>

        <div
          className={`upload-screen__dropzone ${isDragging ? "upload-screen__dropzone--dragging" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          role="button"
          tabIndex={0}
          aria-label="Upload a photo"
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        >
          <div className="upload-screen__dropzone-inner">
            <div className="upload-screen__dropzone-icon">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <path
                  d="M20 8v16M13 15l7-7 7 7"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 28h24"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
                <path
                  d="M8 33h24"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  opacity="0.3"
                />
              </svg>
            </div>
            <p className="upload-screen__dropzone-title">
              {isDragging ? "Drop it here" : "Tap to choose a photo"}
            </p>
            <p className="upload-screen__dropzone-hint">
              JPEG, PNG, WebP or HEIC · Max 5 MB
            </p>
          </div>

          {/* Decorative corner marks */}
          <span className="upload-screen__corner upload-screen__corner--tl" />
          <span className="upload-screen__corner upload-screen__corner--tr" />
          <span className="upload-screen__corner upload-screen__corner--bl" />
          <span className="upload-screen__corner upload-screen__corner--br" />
        </div>

        <div className="upload-screen__examples">
          <p className="upload-screen__examples-label">Great for</p>
          <div className="upload-screen__examples-pills">
            {["Pets 🐾", "People 🙂", "Objects 📦", "Food 🍜"].map((item) => (
              <span key={item} className="upload-screen__examples-pill">
                {item}
              </span>
            ))}
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,image/heic"
          onChange={handleChange}
          style={{ display: "none" }}
          aria-hidden="true"
        />

        <style>{`
          .upload-screen {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 32px 24px;
            gap: 32px;
            max-width: 480px;
            margin: 0 auto;
            width: 100%;
            position: relative;
            z-index: 1;
          }

          .upload-screen__header {
            text-align: center;
          }

          .upload-screen__logo {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-bottom: 8px;
          }

          .upload-screen__logo-icon {
            font-size: 20px;
            color: var(--color-accent);
            animation: spin-slow 8s linear infinite;
          }

          @keyframes spin-slow {
            to { transform: rotate(360deg); }
          }

          .upload-screen__logo-text {
            font-family: var(--font-display);
            font-size: 22px;
            font-weight: 700;
            color: var(--color-ink);
            letter-spacing: -0.5px;
          }

          .upload-screen__tagline {
            font-size: 15px;
            color: var(--color-ink-secondary);
            font-weight: 300;
          }

          .upload-screen__dropzone {
            width: 100%;
            aspect-ratio: 1;
            max-width: 340px;
            background: var(--color-bg-card);
            border-radius: var(--radius-xl);
            border: 2px dashed var(--color-border-strong);
            cursor: pointer;
            position: relative;
            transition: border-color var(--transition-base), background var(--transition-base), transform var(--transition-spring);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: var(--shadow-md);
            outline: none;
          }

          .upload-screen__dropzone:hover,
          .upload-screen__dropzone:focus {
            border-color: var(--color-accent);
            background: var(--color-accent-light);
            transform: scale(1.01);
          }

          .upload-screen__dropzone--dragging {
            border-color: var(--color-accent);
            background: var(--color-accent-light);
            transform: scale(1.03);
            box-shadow: var(--shadow-accent);
          }

          .upload-screen__dropzone-inner {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
            padding: 32px;
            pointer-events: none;
          }

          .upload-screen__dropzone-icon {
            width: 72px;
            height: 72px;
            background: var(--color-bg-subtle);
            border-radius: var(--radius-lg);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--color-accent);
            transition: background var(--transition-base);
          }

          .upload-screen__dropzone:hover .upload-screen__dropzone-icon,
          .upload-screen__dropzone--dragging .upload-screen__dropzone-icon {
            background: rgba(255,92,58,0.12);
          }

          .upload-screen__dropzone-title {
            font-family: var(--font-display);
            font-size: 17px;
            font-weight: 600;
            color: var(--color-ink);
            text-align: center;
          }

          .upload-screen__dropzone-hint {
            font-size: 12px;
            color: var(--color-ink-tertiary);
            text-align: center;
            letter-spacing: 0.02em;
          }

          /* Corner decorations */
          .upload-screen__corner {
            position: absolute;
            width: 16px;
            height: 16px;
            border-color: var(--color-accent);
            border-style: solid;
            opacity: 0;
            transition: opacity var(--transition-base);
          }
          .upload-screen__dropzone:hover .upload-screen__corner,
          .upload-screen__dropzone--dragging .upload-screen__corner { opacity: 1; }
          .upload-screen__corner--tl { top: 12px; left: 12px; border-width: 2px 0 0 2px; border-radius: 4px 0 0 0; }
          .upload-screen__corner--tr { top: 12px; right: 12px; border-width: 2px 2px 0 0; border-radius: 0 4px 0 0; }
          .upload-screen__corner--bl { bottom: 12px; left: 12px; border-width: 0 0 2px 2px; border-radius: 0 0 0 4px; }
          .upload-screen__corner--br { bottom: 12px; right: 12px; border-width: 0 2px 2px 0; border-radius: 0 0 4px 0; }

          .upload-screen__examples { text-align: center; }

          .upload-screen__examples-label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--color-ink-tertiary);
            margin-bottom: 10px;
            font-weight: 500;
          }

          .upload-screen__examples-pills {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: center;
          }

          .upload-screen__examples-pill {
            font-size: 13px;
            padding: 6px 14px;
            background: var(--color-bg-card);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-full);
            color: var(--color-ink-secondary);
            box-shadow: var(--shadow-sm);
          }
        `}</style>
      </div>
    </>
  );
}
