import { useEffect, useRef } from 'react';
import { createRibbonEngine } from '../engine/ribbonEngine.js';
import styles from './RibbonWallpaper.module.css';

/**
 * Live-animating generative ribbon weave that spells `word`, used as the
 * desktop wallpaper. The heavy lifting lives in the ported vanilla engine
 * (src/engine/ribbonEngine.js) — this component just mounts it into an <svg>,
 * starts it, keeps it sized to the viewport, and tears it down on unmount.
 */
export default function RibbonWallpaper({ word = 'fatto', onReady, onStats }) {
  const svgRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current) return;
    const engine = createRibbonEngine(svgRef.current, { word, onStats });
    engineRef.current = engine;
    engine.start();
    onReady?.(engine);

    const onResize = () => engine.handleResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      engine.destroy();
    };
    // word is intentionally not in deps — changing the word at runtime goes
    // through engineRef.current.setWord (see effect below) to avoid a full
    // engine teardown/rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to word changes without rebuilding the engine. Skipped on the
  // initial mount — engine.start() already generates the first word, and
  // running setWord here too would regenerate the weave twice on load.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (engineRef.current) engineRef.current.setWord(word);
  }, [word]);

  return (
    <div className={styles.wallpaper} aria-hidden="true">
      <svg ref={svgRef} className={styles.canvas} viewBox="0 0 1000 1000"
           preserveAspectRatio="xMidYMid slice"
           xmlns="http://www.w3.org/2000/svg" />
    </div>
  );
}
