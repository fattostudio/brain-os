import styles from './DocViewer.module.css';

/**
 * Renders an MDX document. The MDX file default-exports a React component;
 * pass it in as `Doc`. Styling lives here so every doc reads consistently
 * (serif body, monospace eyebrow/section labels) regardless of its content.
 */
export default function DocViewer({ Doc }) {
  return (
    <div className={styles.doc}>
      <Doc />
    </div>
  );
}
