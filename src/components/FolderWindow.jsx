import { useEffect, useState } from 'react';
import DesktopIcon from './DesktopIcon.jsx';
import styles from './FolderWindow.module.css';

/**
 * The interior of a folder window: its child items laid out as draggable
 * icons. Each child is `{ id, kind, label }` from the filesystem config.
 * Opening a child bubbles up to the Desktop via `onOpenChild(childId)`.
 *
 * The grid adapts to screen size: 2 columns on phones (so the content fits a
 * narrow window without horizontal scroll), 3 on larger screens.
 */
export default function FolderWindow({ items, onOpenChild }) {
  const [cols, setCols] = useState(
    typeof window !== 'undefined' && window.innerWidth < 640 ? 2 : 3
  );
  useEffect(() => {
    const onR = () => setCols(window.innerWidth < 640 ? 2 : 3);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);

  const colStep = 92;   // horizontal spacing between icon columns
  const rowStep = 104;  // vertical spacing between icon rows
  const pad = 14;

  return (
    <div className={styles.folder}>
      {items.map((item, i) => (
        <DesktopIcon
          key={item.id}
          kind={item.kind}
          label={item.label}
          color="var(--paper)"
          initial={{ x: pad + (i % cols) * colStep, y: pad + Math.floor(i / cols) * rowStep }}
          onOpen={() => onOpenChild(item.id)}
        />
      ))}
    </div>
  );
}
