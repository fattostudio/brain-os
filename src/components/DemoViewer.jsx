import { useEffect, useState, useRef } from 'react';
import styles from './DemoViewer.module.css';

/**
 * Plays a self-hosted product demo video, choosing the MOBILE or WEB recording
 * based on the viewer's device. Mobile clips are framed in a phone-style frame;
 * web clips in a browser-style frame — so the demo reads correctly either way.
 *
 * Props (from the node's `demo` config):
 *   mobileSrc  string|null  — URL of the mobile-version MP4
 *   webSrc     string|null  — URL of the web-version MP4
 *   poster     string|null  — optional still image shown before play
 *   caption    string       — one-line description under the video
 *   tint       string       — accent for the frame background
 *
 * A null src renders a "coming soon" placeholder (same pattern as the launcher),
 * so you can ship the structure now and drop the real files in later.
 */
export default function DemoViewer({ mobileSrc, webSrc, poster, caption, tint }) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 640 : false
  );
  const videoRef = useRef(null);

  useEffect(() => {
    const onR = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);

  const src = isMobile ? mobileSrc : webSrc;
  const comingSoon = !src;

  // Restart playback when the chosen source changes (device flip).
  useEffect(() => {
    if (videoRef.current && src) {
      videoRef.current.load();
    }
  }, [src]);

  const frameClass = isMobile ? styles.phoneFrame : styles.webFrame;

  return (
    <div className={styles.demo} style={tint ? { background: tint } : undefined}>
      <div className={frameClass}>
        {isMobile ? <div className={styles.notch} /> : (
          <div className={styles.browserBar}>
            <span className={styles.dot} /><span className={styles.dot} /><span className={styles.dot} />
          </div>
        )}

        {comingSoon ? (
          <div className={styles.placeholder}>
            <span className={styles.placeholderLabel}>Demo</span>
            <span className={styles.placeholderSub}>coming soon</span>
          </div>
        ) : (
          <video
            ref={videoRef}
            className={styles.video}
            src={src}
            poster={poster || undefined}
            controls
            autoPlay
            muted
            loop
            playsInline
          />
        )}
      </div>

      {caption && <p className={styles.caption}>{caption}</p>}
      <span className={styles.deviceTag}>
        {isMobile ? 'mobile version' : 'web version'}
      </span>
    </div>
  );
}
