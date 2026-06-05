import { useState } from 'react';
import styles from './Sidebar.module.css';

/**
 * Optional control panel for the ribbon weave — a faithful port of the
 * sidebar from the original standalone index.html. Hidden by default; the
 * toggle button (a little ribbon-knot) shows/hides it. Drives the engine
 * through the methods exposed on the engine instance.
 *
 * Props:
 *   engine  the ribbon engine instance (or null until ready)
 *   stats   { count, attempts, status, error }
 */
export default function Sidebar({ engine, stats }) {
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('fatto');
  const [playing, setPlaying] = useState(true);

  const s = stats || { count: '0', attempts: '0', status: 'ready', error: '' };

  function regenerate() {
    if (!engine) return;
    engine.regenerateAndPlay(word || 'fatto');
    setPlaying(true);
  }
  function togglePlay() {
    engine?.togglePlay();
    setPlaying(engine ? engine.isPlaying() : false);
  }

  return (
    <>
      {/* Toggle button — always visible, pinned to the edge */}
      <button
        className={`${styles.toggle} ${open ? styles.toggleOpen : ''}`}
        title={open ? 'Hide panel' : 'Show panel'}
        aria-label={open ? 'Hide panel' : 'Show panel'}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 36 36" aria-hidden="true">
          <path
            d="M 8 12 C 14 12, 18 8, 22 12 C 26 16, 22 22, 16 22 C 10 22, 8 18, 12 16 C 18 12, 24 18, 28 24"
            fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`}>
        <div className={styles.header}>
          <div className={styles.titleText}>Fatto Studio</div>
        </div>

        <div className={styles.body}>
          <div className={styles.group}>
            <div className={styles.groupLabel}>Typography</div>
            <input
              className={styles.textInput}
              type="text"
              value={word}
              placeholder="Type a word..."
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') regenerate(); }}
            />
            <button className={styles.primary} onClick={regenerate}>◆ regenerate</button>
            <button className={playing ? styles.playing : ''} onClick={togglePlay}>
              {playing ? '■ stop' : '▶ play'}
            </button>
          </div>

          <div className={styles.group}>
            <div className={styles.groupLabel}>Finish</div>
            <button onClick={() => { engine?.step(); setPlaying(false); }}>+ add one</button>
            <button onClick={() => { engine?.addMany(10); setPlaying(false); }}>+ add 10</button>
            <button onClick={() => { engine?.undo(); setPlaying(false); }}>↶ undo</button>
          </div>

          <div className={styles.group}>
            <div className={styles.groupLabel}>Stats</div>
            <div className={styles.stats}>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>Ribbons</span>
                <span className={styles.statBig}>{s.count}</span>
              </div>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>Attempts</span>
                <span className={styles.statBig}>{s.attempts}</span>
              </div>
              <div className={`${styles.statRow} ${styles.statRowStatus}`}>
                <span className={styles.statLabel}>Status</span>
                <span className={styles.statValue}>{s.status}</span>
              </div>
            </div>
          </div>

          <div className={styles.group}>
            <button className={styles.reset} onClick={() => { engine?.reset(); setPlaying(false); }}>
              ↺ reset
            </button>
          </div>

          {s.error ? <div className={styles.error}>{s.error}</div> : null}
        </div>

        <div className={styles.footer}>Ribbon engine v2.0</div>
      </aside>
    </>
  );
}
