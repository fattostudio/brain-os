/* ============================================================
   filesystem.js — THE CONTENT LAYER ("the CMS")
   ------------------------------------------------------------
   Everything on the desktop is declared here. To add a project:
     1. drop a new .mdx file in src/content/
     2. add a `node` entry below
     3. add its id to `desktop` (if it lives on the root desktop)
   No component code needs to change.

   Node shapes:
     { kind: 'doc',    label, doc: <MDXComponent> }
     { kind: 'folder', label, color, children: [ids...] }
     { kind: 'app',    label, app: { name, url, mode, caption, tint } }
     { kind: 'demo',   label, demo: { mobileSrc, webSrc, poster, caption, tint } }

   `mode` (app) is per-app: 'tab' opens in a new browser tab, 'iframe' embeds.
   `demo` shows a self-hosted video, picking mobileSrc vs webSrc by device.
   A null url/src renders a "coming soon" placeholder.

   --- VIDEO HOSTING NOTE ---
   Do NOT commit large video files into this repo (bloats it; Vercel has size
   limits). Host the MP4s elsewhere — e.g. Cloudflare R2 / a CDN — and put the
   public URLs in mobileSrc / webSrc below. (Tiny clips could live in /public,
   but for real demos prefer external hosting.)
   ============================================================ */

import Manifesto from '../content/Manifesto.mdx';
import PocoAbout from '../content/PocoAbout.mdx';
import CartaAbout from '../content/CartaAbout.mdx';

export const nodes = {
  /* ---- Top-level desktop items ---- */
  manifesto: {
    kind: 'doc',
    label: 'Manifesto',
    doc: Manifesto,
    window: { width: 560 },
  },

  poco: {
    kind: 'folder',
    label: 'Poco',
    color: 'var(--lavender)',
    children: ['poco-about', 'poco-demo', 'poco-app'],
    window: { tint: 'rgba(201,174,222,0.28)', width: 420 },
  },

  carta: {
    kind: 'folder',
    label: 'Carta',
    color: 'var(--sage)',
    children: ['carta-about', 'carta-demo', 'carta-app'],
    window: { tint: 'rgba(185,217,154,0.30)', width: 420 },
  },

  /* ---- Poco folder contents ---- */
  'poco-about': {
    kind: 'doc',
    label: 'About_Poco',
    doc: PocoAbout,
    window: { width: 560 },
  },
  'poco-demo': {
    kind: 'demo',
    label: 'Demo_Poco',
    demo: {
      mobileSrc: null,   // TODO: URL of Poco mobile demo MP4 (e.g. https://cdn.../poco-mobile.mp4)
      webSrc: null,      // TODO: URL of Poco web demo MP4
      poster: null,      // optional still image URL
      caption: 'A quick look at Poco in action.',
      tint: 'rgba(201,174,222,0.28)',
    },
    window: { width: 340 },
  },
  'poco-app': {
    kind: 'app',
    label: 'Poco.app',
    app: {
      name: 'Poco',
      url: null,                 // not built yet → "coming soon" window
      mode: 'phone',             // mobile-only app: desktop shows a centered
                                 // phone frame; mobile opens it full-page.
      caption: 'The Poco app — launching soon.',
      tint: 'rgba(201,174,222,0.28)',
    },
    window: { width: 300 },
  },

  /* ---- Carta folder contents ---- */
  'carta-about': {
    kind: 'doc',
    label: 'About_Carta',
    doc: CartaAbout,
    window: { width: 560 },
  },
  'carta-demo': {
    kind: 'demo',
    label: 'Demo_Carta',
    demo: {
      mobileSrc: null,   // TODO: URL of Carta mobile demo MP4
      webSrc: null,      // TODO: URL of Carta web demo MP4
      poster: null,
      caption: 'A quick look at Carta in action.',
      tint: 'rgba(185,217,154,0.30)',
    },
    window: { width: 340 },
  },
  'carta-app': {
    kind: 'app',
    label: 'Carta webapp',
    app: {
      name: 'Carta',
      url: 'https://https://carta.fatto.studio/',  
      mode: 'tab',                         // Carta opens in a new tab
      caption: 'Carta is live — opens in a new tab.',
      tint: 'rgba(185,217,154,0.30)',
    },
    window: { width: 300 },
  },
};

/* Which nodes sit on the root desktop, and where. Positions are starting
   points — visitors can drag everything around. */
export const desktop = [
  { id: 'manifesto', x: 80,  y: 110 },
  { id: 'poco',      x: 230, y: 300 },
  { id: 'carta',     x: 410, y: 160 },
];
