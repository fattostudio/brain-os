import { useState, useCallback, useRef } from 'react';
import RibbonWallpaper from './RibbonWallpaper.jsx';
import DesktopIcon from './DesktopIcon.jsx';
import Window from './Window.jsx';
import DocViewer from './DocViewer.jsx';
import FolderWindow from './FolderWindow.jsx';
import AppLauncher from './AppLauncher.jsx';
import Sidebar from './Sidebar.jsx';
import { nodes, desktop } from '../content/filesystem.js';
import styles from './Desktop.module.css';

let _seq = 1; // monotonic id for each opened window instance

export default function Desktop() {
  // open windows: [{ key, nodeId, z }]
  const [windows, setWindows] = useState([]);
  const [topZ, setTopZ] = useState(10);
  const offset = useRef(0);

  // ribbon engine instance + live stats, for the optional control sidebar
  const [engine, setEngine] = useState(null);
  const [stats, setStats] = useState({ count: '0', attempts: '0', status: 'ready', error: '' });

  const focusWindow = useCallback((key) => {
    setTopZ((z) => {
      const next = z + 1;
      setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, z: next } : w)));
      return next;
    });
  }, []);

  const openNode = useCallback((nodeId) => {
    setWindows((ws) => {
      // if already open, just focus it
      const existing = ws.find((w) => w.nodeId === nodeId);
      if (existing) {
        setTopZ((z) => {
          const next = z + 1;
          setWindows((cur) => cur.map((w) => (w.key === existing.key ? { ...w, z: next } : w)));
          return next;
        });
        return ws;
      }
      const next = topZ + 1;
      setTopZ(next);
      offset.current = (offset.current + 1) % 6;
      const o = offset.current * 26;
      // Clamp the spawn so windows open on-screen even on narrow phones.
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const baseX = vw < 640 ? 12 : 160;
      const baseY = vw < 640 ? 64 : 90;
      return [...ws, { key: _seq++, nodeId, z: next, spawn: { x: baseX + o, y: baseY + o } }];
    });
  }, [topZ]);

  const closeWindow = useCallback((key) => {
    setWindows((ws) => ws.filter((w) => w.key !== key));
  }, []);

  return (
    <div className={styles.desktop}>
      <RibbonWallpaper word="fatto" onReady={setEngine} onStats={setStats} />

      {/* Optional control panel for the weave (hidden by default) */}
      <Sidebar engine={engine} stats={stats} />

      {/* Root desktop icons */}
      <div className={styles.iconLayer}>
        {desktop.map(({ id, x, y }) => {
          const node = nodes[id];
          // On narrow screens, pull icons inward so none sit off the edge.
          const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
          const ix = vw < 640 ? Math.min(x, vw - 110) : x;
          return (
            <DesktopIcon
              key={id}
              kind={node.kind === 'folder' ? 'folder' : 'doc'}
              label={node.label}
              color={node.color || 'var(--paper)'}
              initial={{ x: ix, y }}
              onOpen={() => openNode(id)}
            />
          );
        })}
      </div>

      {/* Open windows */}
      {windows.map((w) => {
        const node = nodes[w.nodeId];
        const topMost = windows.reduce((a, b) => (b.z > a.z ? b : a), windows[0]);
        const focused = topMost && topMost.key === w.key;
        const winCfg = node.window || {};
        return (
          <div key={w.key} style={{ zIndex: w.z, position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <div style={{ pointerEvents: 'auto' }}>
              <Window
                title={node.label}
                initial={w.spawn}
                width={winCfg.width || 460}
                tint={winCfg.tint}
                focused={focused}
                onFocus={() => focusWindow(w.key)}
                onClose={() => closeWindow(w.key)}
              >
                {node.kind === 'doc' && <DocViewer Doc={node.doc} />}
                {node.kind === 'app' && <AppLauncher {...node.app} />}
                {node.kind === 'folder' && (
                  <FolderWindow
                    items={node.children.map((cid) => ({
                      id: cid, kind: nodes[cid].kind, label: nodes[cid].label,
                    }))}
                    onOpenChild={openNode}
                  />
                )}
              </Window>
            </div>
          </div>
        );
      })}
    </div>
  );
}
