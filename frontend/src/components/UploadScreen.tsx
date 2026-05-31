import { useRef, useState, DragEvent, ChangeEvent } from "react";
import { SceneBackground } from "./SceneBackground";
import styles from "./UploadScreen.module.css";
import { FooterCredit } from "./FooterCredit";

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
      <div className={styles.uploadScreen}>
        <div className={styles.header}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>✦</span>
            <span className={styles.logoText}>StickerSnap</span>
          </div>
          <p className={styles.tagline}>Turn any photo into a sticker</p>
        </div>

        <div
          className={`${styles.dropzone} ${isDragging ? styles.dropzoneDragging : ""}`}
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          role="button"
          tabIndex={0}
          aria-label="Upload a photo"
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        >
          <div className={styles.dropzoneInner}>
            <div className={styles.dropzoneIcon}>
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
            <p className={styles.dropzoneTitle}>
              {isDragging ? "Drop it here" : "Tap to choose a photo"}
            </p>
            <p className={styles.dropzoneHint}>
              JPEG, PNG, WebP or HEIC · Max 5 MB
            </p>
          </div>

          <span className={`${styles.corner} ${styles.cornerTl}`} />
          <span className={`${styles.corner} ${styles.cornerTr}`} />
          <span className={`${styles.corner} ${styles.cornerBl}`} />
          <span className={`${styles.corner} ${styles.cornerBr}`} />

          <div
            className={styles.limitBanner}
            onClick={(e) => e.stopPropagation()}
          >
            <span className={styles.limitBannerText}>
              Limited free usage: 2 stickers per day!
            </span>
          </div>
        </div>

        <div className={styles.examples}>
          <p className={styles.examplesLabel}>Great for</p>
          <div className={styles.examplesPills}>
            {["Pets 🐾", "People 🙂", "Objects 📦", "Food 🍜"].map((item) => (
              <span key={item} className={styles.examplesPill}>
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
      </div>
      <FooterCredit />
    </>
  );
}
