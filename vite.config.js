import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mdx from '@mdx-js/rollup';

// MDX must run BEFORE the React plugin so .mdx compiles to JSX first,
// then React's Fast Refresh / JSX transform picks it up.
export default defineConfig({
  // Carta runs on 5173, so Brain OS uses 5174.
  // `strictPort: false` means if 5174 is also busy, Vite bumps to the next
  // free port and prints the real URL — read the URL it actually shows.
  server: { port: 5174, strictPort: false },
  plugins: [
    { enforce: 'pre', ...mdx({ /* remark/rehype plugins can go here later */ }) },
    react({ include: /\.(jsx|js|mdx|md|tsx|ts)$/ }),
  ],
});
