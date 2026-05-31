import { SceneBackground } from "./SceneBackground";
import styles from "./ErrorScreen.module.css";
import { FooterCredit } from "./FooterCredit";

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <>
      <SceneBackground />
      <div className={styles.errorScreen}>
        <div className={styles.card}>
          <div className={styles.icon}>
            <span>!</span>
          </div>
          <h2 className={styles.title}>Something went wrong</h2>
          <p className={styles.message}>{message}</p>
          <button className={styles.retryBtn} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
      <FooterCredit />
    </>
  );
}
