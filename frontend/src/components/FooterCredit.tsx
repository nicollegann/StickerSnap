import styles from "./FooterCredit.module.css";

export function FooterCredit() {
  return (
    <footer className={styles.footer}>
      <span className={styles.text}>Built by Nicolle</span>
      <span className={styles.dot}>·</span>
      <a
        href="https://nicollegan-portfolio-v2.vercel.app/"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
      >
        Portfolio
      </a>
      <span className={styles.dot}>·</span>
      <a
        href="https://github.com/nicollegann/StickerSnap"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
      >
        GitHub
      </a>
    </footer>
  );
}
