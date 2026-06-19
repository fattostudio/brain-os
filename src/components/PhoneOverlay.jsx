import styles from './PhoneOverlay.module.css';

/**
 * Fullscreen overlay that runs a MOBILE-ONLY app inside a centered phone frame,
 * used on desktop where a mobile app needs a phone-shaped container to make
 * sense. (On mobile we don't use this — the device itself is the frame and the
 * app opens full-page in a new tab instead.)
 *
 * Props:
 *   name   string  — app name (title + a11y)
 *   url    string  — the app URL, loaded in an iframe inside the phone
 *   onClose fn     — dismiss the overlay
 */
export default function PhoneOverlay({ name, url, onClose }) {
  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      {/* stopPropagation so clicking the phone doesn't close the overlay */}
      <div className={styles.stage} onMouseDown={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">× close</button>
        <div className={styles.phone}>
          <div className={styles.notch} />
          <iframe className={styles.frame} src={url} title={name} loading="lazy" />
        </div>
        <div className={styles.label}>{name}</div>
      </div>
    </div>
  );
}
