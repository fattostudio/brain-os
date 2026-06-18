import { useRef, useState, useEffect, useCallback } from 'react';
import { getPoint, addDragListeners } from './pointer.js';
import styles from './Window.module.css';

/**
 * Universal window chrome: dark monospace title bar, expand/restore + close
 * controls, and drag-to-move. The interior is whatever `children` you pass.
 * Built once, shared by every window type.
 *
 * Two display states:
 *   - floating (default): a small draggable window on the desktop. Multiple
 *     can coexist, scattered around — the desktop-OS look, works on mobile too.
 *   - expanded: grows to near-fullscreen so the content is comfortable to read
 *     / use. Dragging is disabled while expanded. Tap restore to return to the
 *     floating position. Works identically on desktop and mobile.
 *
 * Props:
 *   title      string   — shown in the title bar
 *   initial    {x,y}    — initial top-left position (floating state)
 *   width      number   — floating pixel width (height grows with content)
 *   focused    boolean  — raises shadow + z-index
 *   onFocus    fn       — called on pointer-down anywhere in the window
 *   onClose    fn       — close button
 *   tint       string   — optional CSS color for the body background
 *   bodyClass  string   — optional extra class for the body element
 */
export default function Window({
  title, initial = { x: 120, y: 90 }, width = 460,
  focused, onFocus, onClose, tint, bodyClass = '', children,
}) {
  const [pos, setPos] = useState(initial);
  const [expanded, setExpanded] = useState(false);
  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const dragState = useRef(null);

  // Track viewport width so floating windows can be smaller on phones (lets
  // 2-3 coexist, scattered, instead of each filling the screen).
  useEffect(() => {
    const onR = () => setVw(window.innerWidth);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  const isMobile = vw < 640;
  // On mobile, cap floating width to ~78% of the screen; on desktop use the
  // configured width as-is.
  const floatWidth = isMobile ? Math.min(width, Math.round(vw * 0.78)) : width;

  const onTitleDown = useCallback((e) => {
    if (expanded) return;                        // no dragging while expanded
    if (e.target.closest('[data-ctrl]')) return; // ignore the control buttons
    onFocus?.();
    const p = getPoint(e);
    dragState.current = {
      startX: p.x, startY: p.y,
      originX: pos.x, originY: pos.y,
    };
    if (e.cancelable) e.preventDefault();
  }, [pos, onFocus, expanded]);

  useEffect(() => {
    function onMove(e) {
      if (!dragState.current) return;
      const p = getPoint(e);
      const dx = p.x - dragState.current.startX;
      const dy = p.y - dragState.current.startY;
      if (e.cancelable) e.preventDefault();      // don't scroll page while dragging
      // Clamp so the window can never be dragged fully off-screen: keep at
      // least a chunk of the title bar reachable on every edge.
      const vwNow = window.innerWidth, vh = window.innerHeight;
      const margin = 48;
      const nx = Math.min(Math.max(dragState.current.originX + dx, -floatWidth + margin), vwNow - margin);
      const ny = Math.min(Math.max(dragState.current.originY + dy, 0), vh - margin);
      setPos({ x: nx, y: ny });
    }
    function onUp() { dragState.current = null; }
    return addDragListeners(onMove, onUp);
  }, [floatWidth]);

  const toggleExpand = useCallback((e) => {
    e.stopPropagation();
    onFocus?.();
    setExpanded((v) => !v);
  }, [onFocus]);

  // In expanded state, position/size come from CSS (.expanded), so we don't
  // apply the floating left/top/width inline styles.
  const frameStyle = expanded ? undefined : { left: pos.x, top: pos.y, width: floatWidth };

  return (
    <div
      className={`${styles.win} ${focused ? styles.focused : ''} ${expanded ? styles.expanded : ''}`}
      style={frameStyle}
      onMouseDown={() => onFocus?.()}
      onTouchStart={() => onFocus?.()}
    >
      <div
        className={styles.titlebar}
        onMouseDown={onTitleDown}
        onTouchStart={onTitleDown}
        onDoubleClick={toggleExpand}
      >
        <span className={styles.title}>{title}</span>
        <div className={styles.controls}>
          <button
            className={styles.ctrl}
            data-ctrl
            onClick={toggleExpand}
            aria-label={expanded ? 'Restore' : 'Expand'}
            title={expanded ? 'Restore' : 'Expand'}
          >
            {expanded ? (
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <rect x="3.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect x="1.5" y="3.5" width="8" height="8" fill="var(--ink)" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <rect x="2" y="2" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            )}
          </button>
          <button className={styles.ctrl} data-ctrl onClick={onClose} aria-label="Close" title="Close">×</button>
        </div>
      </div>
      <div
        className={`${styles.body} ${bodyClass}`}
        style={tint ? { background: tint } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
