import { useRef, useState, useEffect, useCallback } from 'react';
import { getPoint, addDragListeners } from './pointer.js';
import styles from './Window.module.css';

/**
 * Universal window chrome: dark monospace title bar, close button, and
 * drag-to-move. The interior is whatever `children` you pass — a doc viewer,
 * a folder, an app launcher. Built once, shared by every window type.
 *
 * Props:
 *   title      string   — shown in the title bar
 *   initial    {x,y}    — initial top-left position
 *   width      number   — pixel width (height grows with content)
 *   focused    boolean  — raises shadow + z-index
 *   onFocus    fn       — called on mousedown anywhere in the window
 *   onClose    fn       — close button
 *   tint       string   — optional CSS color for the body background
 *   bodyClass  string   — optional extra class for the body element
 */
export default function Window({
  title, initial = { x: 120, y: 90 }, width = 460,
  focused, onFocus, onClose, tint, bodyClass = '', children,
}) {
  const [pos, setPos] = useState(initial);
  const dragState = useRef(null);

  const onTitleDown = useCallback((e) => {
    // ignore clicks on the close button
    if (e.target.closest('[data-close]')) return;
    onFocus?.();
    const p = getPoint(e);
    dragState.current = {
      startX: p.x, startY: p.y,
      originX: pos.x, originY: pos.y,
    };
    if (e.cancelable) e.preventDefault();
  }, [pos, onFocus]);

  useEffect(() => {
    function onMove(e) {
      if (!dragState.current) return;
      const p = getPoint(e);
      const dx = p.x - dragState.current.startX;
      const dy = p.y - dragState.current.startY;
      if (e.cancelable) e.preventDefault();  // don't scroll the page while dragging
      setPos({
        x: dragState.current.originX + dx,
        y: dragState.current.originY + dy,
      });
    }
    function onUp() { dragState.current = null; }
    return addDragListeners(onMove, onUp);
  }, []);

  return (
    <div
      className={`${styles.win} ${focused ? styles.focused : ''}`}
      style={{ left: pos.x, top: pos.y, width }}
      onMouseDown={() => onFocus?.()}
      onTouchStart={() => onFocus?.()}
    >
      <div className={styles.titlebar} onMouseDown={onTitleDown} onTouchStart={onTitleDown}>
        <span className={styles.title}>{title}</span>
        <button className={styles.close} data-close onClick={onClose} aria-label="Close">×</button>
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
