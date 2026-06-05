# Brain OS

An explorable desktop portfolio. A live-animating generative ribbon weave is
the wallpaper; projects live as draggable folders and documents on top of it.
Not a corridor you're walked through — a room you rummage around in.

## Run it

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # production build → dist/
npm run preview  # serve the production build locally
```

Open the local URL Vite prints (usually http://localhost:5173).

## Stack

- **Vite + React** — lightweight SPA; the desktop is one continuous canvas.
- **MDX** — every written document is an `.mdx` file (the "CMS"). Content
  lives in the repo, in reach of Claude Code; no external CMS.
- **Plain CSS Modules** — per-component styling, design tokens in
  `src/styles/global.css`.

## How it's organized

```
src/
  engine/
    ribbonEngine.js        # the ribbon-weave engine (ported, animation intact)
  components/
    Desktop.jsx            # orchestrator: wallpaper + icons + window stack + focus
    RibbonWallpaper.jsx    # mounts the engine as the live wallpaper
    Window.jsx             # universal window chrome (built once, shared)
    DesktopIcon.jsx        # draggable folder / doc icons
    FolderWindow.jsx       # a folder's contents as draggable icons
    DocViewer.jsx          # renders an MDX doc in an editorial serif body
    AppLauncher.jsx        # opens a project's real app (new tab or iframe)
  content/
    filesystem.js          # THE CONTENT LAYER — declares every desktop object
    Manifesto.mdx
    PocoAbout.mdx
    CartaAbout.mdx
  styles/
    global.css             # design tokens + reset
```

Two layers, on purpose:
- **Shell** (window chrome, drag, focus/z-index) — built once, reused everywhere.
- **Interiors** (doc / folder / app) — the bespoke content per type.

## Add a project (no component changes needed)

1. Write `src/content/MyProject.mdx`.
2. Add a node in `src/content/filesystem.js`:
   ```js
   'myproject-about': { kind: 'doc', label: 'About_MyProject', doc: MyProjectAbout },
   ```
   (import the MDX at the top of the file).
3. If it should sit on the root desktop, add it to the `desktop` array with a
   starting `{ x, y }`. If it belongs inside a folder, add its id to that
   folder node's `children`.

## App launchers

Each `kind: 'app'` node has an `app` config:

```js
app: {
  name: 'Carta',
  url: 'https://carta.example.com',  // null → renders "coming soon"
  mode: 'tab',                       // 'tab' = new browser tab, 'iframe' = embed
  caption: '...',
  tint: '...',
}
```

- **Carta** is set to `mode: 'tab'`. Replace the placeholder URL with the real one.
- **Poco** is set to `mode: 'iframe'` with `url: null` (coming soon). When Poco
  ships, set its `url` and it embeds live in a desktop window.

## TODO before launch

- [ ] Replace the Carta URL placeholder in `filesystem.js`.
- [ ] Fill in the real copy in `PocoAbout.mdx` and `CartaAbout.mdx`.
- [ ] Set Poco's `url` once the app is live.
