import DesktopIcon from './DesktopIcon.jsx';
import styles from './FolderWindow.module.css';

/**
 * The interior of a folder window: its child items laid out as draggable
 * icons. Each child is `{ id, kind, label }` from the filesystem config.
 * Opening a child bubbles up to the Desktop via `onOpenChild(childId)`.
 */
export default function FolderWindow({ items, onOpenChild }) {
  return (
    <div className={styles.folder}>
      {items.map((item, i) => (
        <DesktopIcon
          key={item.id}
          kind={item.kind === 'app' ? 'doc' : item.kind} /* app icon reuses doc-ish glyph */
          label={item.label}
          color="var(--paper)"
          initial={{ x: 18 + (i % 3) * 96, y: 18 + Math.floor(i / 3) * 104 }}
          onOpen={() => onOpenChild(item.id)}
        />
      ))}
    </div>
  );
}
