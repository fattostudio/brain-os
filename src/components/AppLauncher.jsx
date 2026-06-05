import styles from './AppLauncher.module.css';

/**
 * Launcher for a project's real, separately-deployed app.
 *
 * Props (from the project's filesystem entry `app`):
 *   name     string          — app name
 *   url      string | null   — deployed URL; null/empty => "coming soon"
 *   mode     'tab' | 'iframe'
 *   caption  string          — one-line description under the frame
 *   tint     string          — accent for the frame background
 *
 * - mode 'tab'   → a button that opens `url` in a new browser tab.
 * - mode 'iframe'→ the app embedded live in a phone-shaped frame.
 * - no url       → a disabled "coming soon" state (e.g. Poco before launch).
 */
export default function AppLauncher({ name, url, mode = 'tab', caption, tint }) {
  const comingSoon = !url;

  return (
    <div className={styles.app} style={tint ? { background: tint } : undefined}>
      <div className={styles.phone}>
        <div className={styles.notch} />
        {comingSoon ? (
          <div className={styles.placeholder}>
            <span className={styles.placeholderLabel}>{name}</span>
            <span className={styles.placeholderSub}>coming soon</span>
          </div>
        ) : mode === 'iframe' ? (
          <iframe
            className={styles.frame}
            src={url}
            title={name}
            loading="lazy"
          />
        ) : (
          <div className={styles.placeholder}>
            <span className={styles.placeholderLabel}>{name}</span>
            <span className={styles.placeholderSub}>tap launch to open</span>
          </div>
        )}
      </div>

      {caption && <p className={styles.caption}>{caption}</p>}

      {!comingSoon && mode === 'tab' && (
        <a className={styles.launchBtn} href={url} target="_blank" rel="noreferrer">
          Launch {name} ↗
        </a>
      )}
      {comingSoon && (
        <span className={`${styles.launchBtn} ${styles.disabled}`}>Not yet live</span>
      )}
    </div>
  );
}
