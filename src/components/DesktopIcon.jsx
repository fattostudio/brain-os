import { useRef, useState, useEffect } from 'react';
import { getPoint, addDragListeners } from './pointer.js';
import styles from './DesktopIcon.module.css';

/** A classic tabbed-folder glyph, tinted by `color`. */
function FolderGlyph({ color }) {
  return (
    <svg viewBox="0 0 64 54" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 10 h20 l6 6 h32 a2 2 0 0 1 2 2 v32 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 V12 a2 2 0 0 1 2 -2 z"
            fill={color} stroke="#141210" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** A document glyph (page with a folded corner + text lines). */
function DocGlyph() {
  return (
    <svg viewBox="0 0 64 54" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 4 h26 l12 12 v34 a2 2 0 0 1 -2 2 H14 a2 2 0 0 1 -2 -2 V6 a2 2 0 0 1 2 -2 z"
            fill="#ffffff" stroke="#141210" strokeWidth="2" strokeLinejoin="round" />
      <path d="M40 4 v12 h12" fill="none" stroke="#141210" strokeWidth="2" strokeLinejoin="round" />
      <g stroke="#141210" strokeWidth="2" strokeLinecap="round">
        <line x1="19" y1="26" x2="45" y2="26" />
        <line x1="19" y1="33" x2="45" y2="33" />
        <line x1="19" y1="40" x2="37" y2="40" />
      </g>
    </svg>
  );
}

/** A video-file glyph: a frame with a play triangle. */
function VideoGlyph() {
  return (
    <svg viewBox="0 0 64 54" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="10" width="48" height="34" rx="3"
            fill="#ffffff" stroke="#141210" strokeWidth="2" />
      {/* sprocket strip down the left, like a film reel */}
      <g stroke="#141210" strokeWidth="2">
        <line x1="16" y1="10" x2="16" y2="44" />
      </g>
      <g fill="#141210">
        <rect x="10.5" y="14" width="3" height="3" />
        <rect x="10.5" y="22" width="3" height="3" />
        <rect x="10.5" y="30" width="3" height="3" />
        <rect x="10.5" y="38" width="3" height="3" />
      </g>
      {/* play triangle */}
      <path d="M30 19 L44 27 L30 35 Z"
            fill="#141210" stroke="#141210" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** A generic app-launcher glyph: a rounded app tile with a launch mark. */
function AppGlyph({ color }) {
  return (
    <svg viewBox="0 0 64 54" xmlns="http://www.w3.org/2000/svg">
      <rect x="14" y="6" width="36" height="42" rx="8"
            fill={color || '#ffffff'} stroke="#141210" strokeWidth="2" />
      {/* outward launch arrow ↗ */}
      <g stroke="#141210" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M27 33 L37 23" />
        <path d="M30 22 L38 22 L38 30" />
      </g>
    </svg>
  );
}
export default function DesktopIcon({ kind, label, color, initial, onOpen }) {
  const [pos, setPos] = useState(initial);
  const [selected, setSelected] = useState(false);
  const drag = useRef(null);

  function onDown(e) {
    const p = getPoint(e);
    drag.current = {
      startX: p.x, startY: p.y,
      originX: pos.x, originY: pos.y, moved: false,
    };
    setSelected(true);
    e.stopPropagation();
  }

  useEffect(() => {
    function onMove(e) {
      if (!drag.current) return;
      const p = getPoint(e);
      const dx = p.x - drag.current.startX;
      const dy = p.y - drag.current.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        drag.current.moved = true;
        // once we're actually dragging, stop the page from scrolling on touch
        if (e.cancelable) e.preventDefault();
      }
      setPos({ x: drag.current.originX + dx, y: drag.current.originY + dy });
    }
    function onUp() {
      if (drag.current && !drag.current.moved) onOpen?.();
      drag.current = null;
    }
    return addDragListeners(onMove, onUp);
  }, [onOpen]);

  return (
    <div
      className={`${styles.icon} ${selected ? styles.selected : ''}`}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={onDown}
      onTouchStart={onDown}
    >
      <div className={styles.glyph}>
        {kind === 'folder' ? <FolderGlyph color={color} />
          : kind === 'video' || kind === 'demo' ? <VideoGlyph />
          : kind === 'app' ? <AppGlyph color={color} />
          : <DocGlyph />}
      </div>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
