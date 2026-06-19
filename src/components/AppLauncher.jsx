import styles from './AppLauncher.module.css';

/**
 * "Coming soon" placeholder for a project app that isn't live yet.
 *
 * NOTE: when an app HAS a url, it never reaches this component — Desktop
 * intercepts the launch and either opens a new tab (mode 'tab') or a centered
 * phone overlay (mode 'phone', desktop only). So this renders only the
 * not-yet-live state: a clean card, no device mockup.
 *
 * Props (from the project's filesystem `app` entry):
 *   name     string
 *   caption  string
 *   tint     string
 */
export default function AppLauncher({ name, caption, tint }) {
  return (
    <div className={styles.app} style={tint ? { background: tint } : undefined}>
      <div className={styles.card}>
        <span className={styles.cardLabel}>{name}</span>
        <span className={styles.cardSub}>coming soon</span>
      </div>
      {caption && <p className={styles.caption}>{caption}</p>}
      <span className={`${styles.launchBtn} ${styles.disabled}`}>Not yet live</span>
    </div>
  );
}
