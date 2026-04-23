# app

Even Hub WebView for the G2 note.com reader.

## Prerequisites

- Node.js ≥ 20.
- The CORS proxy from `../gateway/` deployed (or any equivalent that fronts
  `https://note.com/api/*` and rewrites cookies the same way).
- Even Realities iPhone app, for sideload testing.

## Configure

```sh
cp .env.example .env.local
# Edit VITE_NOTE_PROXY_BASE to your proxy origin, e.g.
#   VITE_NOTE_PROXY_BASE=https://note-proxy.example.com/api
```

`app.json` ships with `package_id = com.example.note-com-reader`. Change
it to something you own before uploading to the Even Hub store — the field
is the unique identifier for the installed package.

## Dev mode (iPhone sideload via QR)

`npm run dev` uses Vite's own dev proxy (`/api/note` → `https://note.com/api`)
which handles CORS and cookie rewriting locally; the `VITE_NOTE_PROXY_BASE`
setting is only consulted for production builds.

```sh
npm install
npm run dev
# In another terminal, generate a QR against your Mac's LAN IP:
npx evenhub qr --url http://<Mac-LAN-IP>:5173
```

On the iPhone:
*Even Hub tab → マイプラグイン → (icon) → プロトタイプモード → QR スキャナ*

(Disable iCloud Private Relay on the iPhone before scanning, otherwise the
phone can't reach the Mac's LAN IP.)

## Desktop simulator

```sh
npm run dev              # keep running
npm run simulate         # opens a Tauri window pointing at localhost:5173
```

Handy for iterating on the G2 glasses layout without a live headset.

## Package for upload / sideload as `.ehpk`

```sh
VITE_NOTE_PROXY_BASE=https://note-proxy.example.com/api npm run build
npx evenhub pack app.json dist -o note-com-reader.ehpk
```

Bump `version` in both `app.json` and `package.json` for each build the
Even Hub store should treat as an update.

## Architecture notes

- `src/api.ts` — typed client for note.com. Talks through
  `VITE_NOTE_PROXY_BASE` in prod, Vite's `/api/note` in dev. Handles
  auth (`Authorization: Bearer`), UI state persistence via
  `bridge.setLocalStorage`, and opt-in credential storage for
  auto-login (iOS WKWebView drops recent bridge writes on force-kill, so
  tokens alone aren't durable).
- `src/main.ts` — Even Hub WebView entry point. Awaits the bridge, sets
  up two text containers on the G2 (body + pager), wires up the iPhone
  companion DOM, and handles touch/scroll events from the glasses.
- `src/wrap.ts` — CJK-aware line wrapping using pretext's `getTextWidth`
  so justification on the G2 pager matches pixel widths of the LVGL font.

## Behaviour to be aware of

- The G2 has room for **9 lines × 27 px** in the body container; do not
  set `containerTotalNum` > 2 on `createStartUpPageContainer` — three
  containers blanks the display on some firmware.
- The LVGL text container draws a blinking cursor at the end of its
  content. The pager label has a trailing space so the cursor doesn't sit
  on top of a digit.
- Only ASCII `# . ,` and the CJK font ship on the device; block chars
  like `█` / `─` render as whitespace.
