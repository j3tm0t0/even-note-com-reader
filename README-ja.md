# even-note-com-reader

Even Realities G2 スマートグラスで note.com を読むためのアプリです。Even Hub
SDK の上に組んでいて、iPhone の Even Realities アプリが WebView としてこの
アプリをロードし、Even Hub bridge 経由で G2 へ描画します。

## 構成

- [`app/`](app/) — Even Hub WebView アプリ (Vite + TypeScript)。iPhone 側の
  コンパニオン UI と、G2 に記事ページを送るリーダーロジック。
- [`gateway/`](gateway/) — `note.com` への CORS プロキシを立てる
  CloudFormation テンプレート。ブラウザは WebView から `note.com` に対して
  cross-site で cookie を共有しないため（iOS WKWebView は `SameSite=None`
  の third-party cookie も落とす）、本番ビルドでは必須です。

## 全体像

```
              ┌──────────────────────────┐
   iPhone ─── │ Even Hub WebView (app/)  │ ─── BLE ───▶ Even G2 glasses
              │   - iPhone コンパニオン  │
              │   - G2 ページレンダラ    │
              └──────────────┬───────────┘
                             │ HTTPS + Authorization: Bearer <token>
                             ▼
              ┌──────────────────────────┐
              │  CloudFront プロキシ      │ ── gateway/template.yaml
              │  (note-proxy.yourdomain) │
              │   - CORS ヘッダ          │
              │   - Cookie 書き換え      │
              │   - Bearer → Cookie      │
              └──────────────┬───────────┘
                             │
                             ▼
                        note.com API
```

## プロキシが必要な理由

note.com の非公開 JSON API を WebView から直に叩こうとすると次の壁があります。

1. **CORS** — note.com は CORS ヘッダを返さない。プロキシが `Origin` を
   echo して `Access-Control-Allow-Credentials: true` を付与します。
2. **Cross-site cookie** — note.com が発行する session cookie は
   `SameSite=None; Secure` ですが、iOS WKWebView は `.ehpk` webview の
   カスタムスキーム下でその cookie を保持できません。対策として、
   プロキシが login 応答の session id を `X-Session-Token` という独自
   ヘッダにも露出します。アプリはこの値を bridge ストレージに保存し、
   以降のリクエストで `Authorization: Bearer <token>` として送ります。
   プロキシの viewer-request 関数が origin 側に forward する直前に、
   この Bearer を note.com 向けの `Cookie` に戻します。
3. **Cookie 属性** — note.com の `Domain=note.com` / `HttpOnly` などの
   属性はプロキシドメイン配下では無効扱いされるため、viewer-response
   関数が剥がします。`SameSite=None; Secure` は付け直し。

## 使い方

1. プロキシを立てる → [`gateway/README.md`](gateway/README.md)（英語）
2. アプリをビルドして iPhone に流す → [`app/README.md`](app/README.md)（英語）

## ライセンス

MIT License。詳細は [LICENSE](LICENSE) を参照してください。

## English

See [README.md](README.md).
