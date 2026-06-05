/* pointer.js — tiny helpers to make drag handlers work with BOTH mouse and
 * touch, so the desktop is usable on phones/tablets as well as desktop. */

/** Read clientX/clientY from a mouse OR touch event. */
export function getPoint(e) {
  if (e.touches && e.touches.length) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length) {
    return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

/**
 * Register move/up handlers for both mouse and touch on window, and return a
 * cleanup function. touchmove is registered non-passive so we can preventDefault
 * (stops the page from scrolling while dragging an icon/window).
 */
export function addDragListeners(onMove, onUp) {
  const moveOpts = { passive: false };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchmove', onMove, moveOpts);
  window.addEventListener('touchend', onUp);
  window.addEventListener('touchcancel', onUp);
  return () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove, moveOpts);
    window.removeEventListener('touchend', onUp);
    window.removeEventListener('touchcancel', onUp);
  };
}
