# even-note-com-reader

[日本語版 README はこちら](README-ja.md)

note.com reader for Even Realities G2 smart glasses, built on the Even Hub
SDK. The iPhone Even Realities app loads this WebView which drives the G2
display over the Even Hub bridge.

## Layout

- [`app/`](app/) — Even Hub WebView app (Vite + TypeScript). The iPhone
  companion UI, and the G2 reader logic that pushes pages to the glasses.
- [`gateway/`](gateway/) — CloudFormation template for a CloudFront
  distribution that acts as a CORS proxy to `note.com`. Required for
  production builds because browsers won't share cookies cross-site to
  `note.com` from a WebView, and WKWebView additionally drops even
  `SameSite=None` third-party cookies.

## Pieces at a glance

```
              ┌──────────────────────────┐
   iPhone ─── │ Even Hub WebView (app/)  │ ─── BLE ───▶ Even G2 glasses
              │   - iPhone companion UI  │
              │   - G2 page renderer     │
              └──────────────┬───────────┘
                             │ HTTPS + Authorization: Bearer <token>
                             ▼
              ┌──────────────────────────┐
              │  CloudFront proxy        │ ── gateway/template.yaml
              │  (note-proxy.yourdomain) │
              │   - CORS headers         │
              │   - Cookie rewrite       │
              │   - Bearer → Cookie      │
              └──────────────┬───────────┘
                             │
                             ▼
                        note.com API
```

## Why the proxy exists

The app hits note.com's private JSON API. A few things make talking to it
straight from a WebView messy:

1. **CORS** — note.com doesn't return CORS headers, so the proxy echoes
   `Origin` back and sets `Access-Control-Allow-Credentials: true`.
2. **Cross-site cookies** — the session cookie note.com sets is
   `SameSite=None; Secure`, but iOS WKWebView still drops it under the
   `.ehpk` WebView's custom scheme. The proxy therefore also exposes the
   session id as an `X-Session-Token` response header; the app reads that,
   stores it, and sends it as `Authorization: Bearer <token>`. The viewer-
   request function translates that back to a `Cookie` before forwarding
   to note.com's origin.
3. **Cookie attributes** — note.com's `Domain=note.com` / `HttpOnly`
   attributes would be rejected by the browser under the proxy's origin;
   the viewer-response function strips them.

## Getting started

1. Stand up the proxy → [`gateway/README.md`](gateway/README.md).
2. Build and install the app → [`app/README.md`](app/README.md).

## License

MIT. See [LICENSE](LICENSE).
