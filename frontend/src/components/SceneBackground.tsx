import styles from "./SceneBackground.module.css";

export function SceneBackground() {
  return (
    <div className={styles.sceneBg} aria-hidden="true">
      <div className={styles.grid} />
      <div className={styles.shapes} />
    </div>
  );
}
