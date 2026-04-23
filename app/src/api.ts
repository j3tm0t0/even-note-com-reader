// note.com client.
// - dev: Vite proxy (/api/note → https://note.com/api) strips Domain/Secure/HttpOnly
//   so session cookies stick under localhost.
// - prod: CORS proxy (see ../gateway). iOS WKWebView refuses to persist
//   cross-site SameSite=None cookies for that origin, so we bypass the
//   cookie jar entirely: the proxy exposes the session token via an
//   `X-Session-Token` response header on login, we persist it locally, and
//   every request sends `Authorization: Bearer <token>` which the proxy
//   rewrites back to a Cookie before forwarding to note.com.
//
// Set the prod proxy origin via `VITE_NOTE_PROXY_BASE` at build time, e.g.
// `VITE_NOTE_PROXY_BASE=https://note-proxy.example.com/api npm run build`.

const PROD_BASE = import.meta.env.VITE_NOTE_PROXY_BASE as string | undefined
const BASE = import.meta.env.PROD
  ? (PROD_BASE ?? 'https://REPLACE-ME.example.com/api')
  : '/api/note'

// Per-field keys persisted via Even Hub's bridge.setLocalStorage. UI state
// (search / magazine / lastList / article) survives app force-kill
// reliably. The session token does NOT — bridge.setLocalStorage eventually
// syncs to disk (iOS NSUserDefaults-like) but force-kill within ~seconds of
// the write drops it. To keep the user logged in across restarts anyway, we
// also store credentials (opt-in) and auto-login on boot.
const TOKEN_STORAGE_KEY = 'eveng2.note.token'
const ME_STORAGE_KEY = 'eveng2.note.me'
const SEARCH_STORAGE_KEY = 'eveng2.note.search'
const MAGAZINE_STORAGE_KEY = 'eveng2.note.magazine'
const MODE_STORAGE_KEY = 'eveng2.note.mode'
const CUR_MAGAZINE_STORAGE_KEY = 'eveng2.note.curMagazine'
const ARTICLE_STORAGE_KEY = 'eveng2.note.article'
const CREDS_STORAGE_KEY = 'eveng2.note.creds'

// Bridge-backed storage outlives a WebView relaunch; browser localStorage in
// Even Hub's WebView does not. Keep both: bridge for persistence, localStorage
// as a sync fast-path so module-load reads don't need to await the bridge.
interface PersistBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}
let persistBridge: PersistBridge | null = null

export type ViewMode = 'my' | 'note' | 'mag' | 'url'

function isViewMode(s: string | null): s is ViewMode {
  return s === 'my' || s === 'note' || s === 'mag' || s === 'url'
}

interface StoredSession {
  token?: string
  me?: MeUser
  search?: string
  magazine?: string
  mode?: ViewMode
  currentMagazine?: { key: string; name: string }
  article?: { key: string; title: string }
}

interface StoredCredentials {
  email: string
  password: string
}

function parseJSON<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function readLocalSession(): StoredSession {
  const get = (k: string) =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null
  const tok = get(TOKEN_STORAGE_KEY)
  const search = get(SEARCH_STORAGE_KEY)
  const magazine = get(MAGAZINE_STORAGE_KEY)
  const mode = get(MODE_STORAGE_KEY)
  const me = parseJSON<MeUser>(get(ME_STORAGE_KEY))
  const article = parseJSON<{ key: string; title: string }>(get(ARTICLE_STORAGE_KEY))
  const currentMagazine = parseJSON<{ key: string; name: string }>(get(CUR_MAGAZINE_STORAGE_KEY))
  return {
    token: tok || undefined,
    me,
    search: search || undefined,
    magazine: magazine || undefined,
    mode: isViewMode(mode) ? mode : undefined,
    currentMagazine,
    article,
  }
}

const bootLocal = readLocalSession()
let sessionToken: string | null = bootLocal.token ?? null
let cachedMe: MeUser | null = bootLocal.me ?? null
let uiState: {
  search?: string
  magazine?: string
  mode?: ViewMode
  currentMagazine?: { key: string; name: string }
  article?: { key: string; title: string }
} = {
  search: bootLocal.search,
  magazine: bootLocal.magazine,
  mode: bootLocal.mode,
  currentMagazine: bootLocal.currentMagazine,
  article: bootLocal.article,
}

let storedCreds: StoredCredentials | null = null

export function hasStoredCredentials(): boolean {
  return storedCreds !== null
}

export function getCachedUIState(): typeof uiState {
  return { ...uiState }
}

export async function rememberMode(mode: ViewMode): Promise<void> {
  uiState = { ...uiState, mode }
  await persistSession()
}

export async function rememberSearch(query: string): Promise<void> {
  uiState = { ...uiState, search: query }
  await persistSession()
}

export async function rememberMagazineUrl(raw: string): Promise<void> {
  uiState = { ...uiState, magazine: raw }
  await persistSession()
}

export async function rememberCurrentMagazine(
  magazine: { key: string; name: string } | null,
): Promise<void> {
  uiState = { ...uiState, currentMagazine: magazine ?? undefined }
  await persistSession()
}

export async function rememberArticle(article: { key: string; title: string } | null): Promise<void> {
  uiState = { ...uiState, article: article ?? undefined }
  await persistSession()
}

export interface PersistenceProbe {
  // Concatenated single-char flags: t / m / s / g / l / a / c (credentials)
  // or '-' for each that wasn't restored from bridge storage.
  bridgeFields: string
}

let lastProbe: PersistenceProbe | null = null

export function getLastProbe(): PersistenceProbe | null {
  return lastProbe
}

export function getSessionToken(): string | null {
  return sessionToken
}

// Call this after the Even Hub bridge is ready. Populates sessionToken/cached
// me from native-backed storage, overriding whatever the synchronous
// localStorage fast-path set on module load.
export async function initPersistence(bridge: PersistBridge): Promise<void> {
  persistBridge = bridge
  const [tok, meRaw, search, magazine, mode, curMagRaw, articleRaw, credsRaw] = await Promise.all([
    bridge.getLocalStorage(TOKEN_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(ME_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(SEARCH_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(MAGAZINE_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(MODE_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(CUR_MAGAZINE_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(ARTICLE_STORAGE_KEY).catch(() => ''),
    bridge.getLocalStorage(CREDS_STORAGE_KEY).catch(() => ''),
  ])
  const restored: StoredSession = {}
  if (tok) restored.token = tok
  if (meRaw) restored.me = parseJSON<MeUser>(meRaw)
  if (search) restored.search = search
  if (magazine) restored.magazine = magazine
  if (isViewMode(mode)) restored.mode = mode
  if (curMagRaw) restored.currentMagazine = parseJSON<{ key: string; name: string }>(curMagRaw)
  if (articleRaw) restored.article = parseJSON<{ key: string; title: string }>(articleRaw)
  if (credsRaw) {
    const parsed = parseJSON<StoredCredentials>(credsRaw)
    if (parsed && parsed.email && parsed.password) storedCreds = parsed
  }
  lastProbe = {
    bridgeFields: [
      restored.token ? 't' : '-',
      restored.me ? 'm' : '-',
      restored.search ? 's' : '-',
      restored.magazine ? 'g' : '-',
      restored.mode ? 'M' : '-',
      restored.currentMagazine ? 'C' : '-',
      restored.article ? 'a' : '-',
      storedCreds ? 'c' : '-',
    ].join(''),
  }
  if (restored.token) {
    sessionToken = restored.token
    lastWritten[TOKEN_STORAGE_KEY] = restored.token
  }
  if (restored.me) {
    cachedMe = restored.me
    lastWritten[ME_STORAGE_KEY] = JSON.stringify(restored.me)
  }
  uiState = {
    search: restored.search,
    magazine: restored.magazine,
    mode: restored.mode,
    currentMagazine: restored.currentMagazine,
    article: restored.article,
  }
  if (restored.search) lastWritten[SEARCH_STORAGE_KEY] = restored.search
  if (restored.magazine) lastWritten[MAGAZINE_STORAGE_KEY] = restored.magazine
  if (restored.mode) lastWritten[MODE_STORAGE_KEY] = restored.mode
  if (restored.currentMagazine)
    lastWritten[CUR_MAGAZINE_STORAGE_KEY] = JSON.stringify(restored.currentMagazine)
  if (restored.article) lastWritten[ARTICLE_STORAGE_KEY] = JSON.stringify(restored.article)
}

let lastSaveResult: string = '?'
export function getLastTokenSaveResult(): string {
  return lastSaveResult
}

// Bridge.setLocalStorage calls that overlap with each other silently drop
// writes (observed with 2 awaited calls on different keys in v0.2.4, where
// the first write vanished). Chain them so only one is ever in flight.
// In addition, even a successful awaited write is NOT flushed to disk
// immediately — a force-kill (app switcher swipe) within ~1s drops it.
// So we also debounce rapid state changes and re-flush on visibilitychange.
let writeChain: Promise<void> = Promise.resolve()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
// Every caller awaiting the currently-pending flush shares resolvers here;
// when the debounced timer (or a flushNow) eventually runs doPersistSession,
// each one is resolved so nobody's awaited `persistSession()` promise is
// orphaned if another caller coalesces with it.
let pendingResolvers: Array<() => void> = []
const DEBOUNCE_MS = 150

function scheduleFlush(): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer)
  const promise = new Promise<void>(resolve => {
    pendingResolvers.push(resolve)
  })
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const resolvers = pendingResolvers
    pendingResolvers = []
    writeChain = writeChain
      .then(doPersistSession, doPersistSession)
      .finally(() => resolvers.forEach(r => r()))
  }, DEBOUNCE_MS)
  return promise
}

function flushNow(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const resolvers = pendingResolvers
  pendingResolvers = []
  writeChain = writeChain.then(doPersistSession, doPersistSession)
  if (resolvers.length) {
    writeChain = writeChain.finally(() => resolvers.forEach(r => r()))
  }
  return writeChain
}

export function registerPersistenceLifecycle(): void {
  // Fire a synchronous flush attempt when the page is hidden / unloaded.
  // WKWebView raises `visibilitychange` on app backgrounding and `pagehide`
  // on hard termination (when it can deliver them).
  const handler = () => {
    void flushNow()
  }
  document.addEventListener('visibilitychange', handler)
  window.addEventListener('pagehide', handler)
  window.addEventListener('beforeunload', handler)
}

// Snapshot of the last successfully-persisted values so we can skip no-op
// writes and also know which individual keys actually need a bridge round
// trip.
const lastWritten: Record<string, string> = {}

async function writeKey(key: string, value: string): Promise<string> {
  if (!persistBridge) return 'no_bridge'
  if (lastWritten[key] === value) return 'skip'
  try {
    const ok = await persistBridge.setLocalStorage(key, value)
    if (ok) lastWritten[key] = value
    return `${ok}`
  } catch (err) {
    return `err:${err instanceof Error ? err.message : String(err)}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const WRITE_GAP_MS = 200

function doPersistSession(): Promise<void> {
  const writes: Array<{ k: string; v: string; tag: string }> = [
    { k: TOKEN_STORAGE_KEY, v: sessionToken ?? '', tag: 't' },
    { k: ME_STORAGE_KEY, v: cachedMe ? JSON.stringify(cachedMe) : '', tag: 'm' },
    { k: SEARCH_STORAGE_KEY, v: uiState.search ?? '', tag: 's' },
    { k: MAGAZINE_STORAGE_KEY, v: uiState.magazine ?? '', tag: 'g' },
    { k: MODE_STORAGE_KEY, v: uiState.mode ?? '', tag: 'M' },
    { k: CUR_MAGAZINE_STORAGE_KEY, v: uiState.currentMagazine ? JSON.stringify(uiState.currentMagazine) : '', tag: 'C' },
    { k: ARTICLE_STORAGE_KEY, v: uiState.article ? JSON.stringify(uiState.article) : '', tag: 'a' },
    { k: CREDS_STORAGE_KEY, v: storedCreds ? JSON.stringify(storedCreds) : '', tag: 'c' },
  ]
  for (const w of writes) {
    if (w.v) localStorage.setItem(w.k, w.v)
    else localStorage.removeItem(w.k)
  }
  if (!persistBridge) {
    lastSaveResult = 'save=no_bridge'
    return Promise.resolve()
  }
  return (async () => {
    const results: string[] = []
    let didWrite = false
    for (const w of writes) {
      // Space out sequential writes so the native side has time to persist
      // each one before the next arrives.
      if (didWrite) await sleep(WRITE_GAP_MS)
      const r = await writeKey(w.k, w.v)
      if (r !== 'skip') didWrite = true
      results.push(`${w.tag}:${r === 'true' ? '✓' : r === 'skip' ? '=' : r}`)
    }
    lastSaveResult = `save ${results.join(' ')}`
  })()
}

function persistSession(): Promise<void> {
  return scheduleFlush()
}

export function flushPersistence(): Promise<void> {
  return flushNow()
}

// Cache the user info alongside the token so we can render the "logged in"
// state immediately on reboot without round-tripping /v3/users/me (which
// can return 400 for unclear reasons from non-browser contexts).
export function getCachedMe(): MeUser | null {
  return cachedMe
}

export interface NoteSummary {
  key: string
  name: string
  user: string
}

export interface Article {
  key: string
  title: string
  author: string
  text: string
  nextKey?: string
  nextTitle?: string
}

export interface Magazine {
  key: string
  name: string
  notes: NoteSummary[]
}

export interface MagazineSummary {
  key: string
  name: string
  description?: string
}

// Dev relies on same-origin cookie via Vite proxy, so `credentials:'include'`
// is still correct there. Prod uses the bearer token injected by authHeaders().
function fetchOpts(extra: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = { ...(extra.headers as Record<string, string> | undefined) }
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`
  return { credentials: 'include', ...extra, headers }
}

export async function searchNotes(query: string, size = 15): Promise<NoteSummary[]> {
  const url = `${BASE}/v3/searches?context=note&q=${encodeURIComponent(query)}&size=${size}`
  const res = await fetch(url, fetchOpts())
  if (!res.ok) throw new Error(`search HTTP ${res.status}`)
  const j = await res.json()
  const items: any[] = j?.data?.notes?.contents ?? []
  return items.map(toSummary)
}

export async function searchMagazines(query: string, size = 15): Promise<MagazineSummary[]> {
  const url = `${BASE}/v3/searches?context=magazine&q=${encodeURIComponent(query)}&size=${size}`
  const res = await fetch(url, fetchOpts())
  if (!res.ok) throw new Error(`magazine search HTTP ${res.status}`)
  const j = await res.json()
  const items: any[] = j?.data?.magazines?.contents ?? []
  return items.map(toMagazineSummary)
}

// User's own magazines (what note.com calls "my magazines"). For accounts
// that use magazines as curated reading lists this doubles as the "frequently
// read" list. Note.com doesn't expose subscribed-membership magazines via a
// known public endpoint.
export async function fetchMyMagazines(): Promise<MagazineSummary[]> {
  const res = await fetch(`${BASE}/v1/my/magazines`, fetchOpts())
  if (!res.ok) throw new Error(`my magazines HTTP ${res.status}`)
  const j = await res.json()
  const items: any[] = j?.data?.magazines ?? []
  return items.map(toMagazineSummary)
}

export async function fetchMagazine(key: string): Promise<Magazine> {
  const res = await fetch(`${BASE}/v1/magazines/${key}/notes`, fetchOpts())
  if (!res.ok) throw new Error(`magazine HTTP ${res.status}`)
  const j = await res.json()
  const data = j?.data ?? {}
  const notes: NoteSummary[] = (data.notes ?? []).map(toSummary)
  return { key, name: String(data.name ?? '').trim(), notes }
}

export async function fetchArticle(key: string): Promise<Article> {
  const res = await fetch(`${BASE}/v3/notes/${key}`, fetchOpts())
  if (!res.ok) throw new Error(`article HTTP ${res.status}`)
  const j = await res.json()
  const d = j?.data ?? {}
  const title = String(d.name ?? '').trim()
  const author = String(d?.user?.nickname ?? '').trim()
  // note.com returns body: null for member-only / paywalled / deleted articles,
  // regardless of session. Surface a readable reason instead of rendering blank.
  const rawBody = d.body == null ? '' : String(d.body)
  if (!rawBody) {
    const base = d.is_limited
      ? 'メンバーシップ限定記事'
      : d.can_read === false
        ? 'アクセス権限がなく読めません'
        : d.price > 0 && !d.is_purchased
          ? '有料記事（未購入）'
          : '本文が取得できませんでした'
    // Diagnostic line — helps distinguish "actually locked" vs "session not
    // forwarded". `remained > 0` with `can_read=false` means note.com sees us
    // as non-member. If session should unlock this, cookies aren't reaching
    // note.com as expected.
    const diag = `[診断] is_limited=${d.is_limited} can_read=${d.can_read} price=${d.price} purchased=${d.is_purchased} remained=${d.remained_char_num ?? '-'}`
    return { key, title, author, text: `${base}\n\n${diag}` }
  }
  const next = extractNextArticle(rawBody)
  const cleanedBody = stripNavigationParagraphs(rawBody)
  return {
    key,
    title,
    author,
    text: htmlToText(cleanedBody),
    nextKey: next?.key,
    nextTitle: next?.title,
  }
}

// Authors commonly place a "次の話" / "次の記事" link at the very bottom of the
// body pointing to the next note — we prefer this over list-order navigation
// because magazine listing order often disagrees with reading order.
const NAV_MARKERS = '次の話|次の記事|次回|続き(?:はこちら)?|次へ'
const NAV_MARKERS_ALL = `${NAV_MARKERS}|前の話|前の記事|前回|前へ|プロローグ|エピローグ`

function extractNextArticle(html: string): { key: string; title: string } | null {
  // Scan per-paragraph so we don't leak across to the next <p> — the last
  // chapter may have a bare "次の話" label with no link, followed immediately
  // by a "前の話" link that would otherwise be mismatched.
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g
  const markerRe = new RegExp(NAV_MARKERS)
  const aRe = /<a[^>]*href="([^"]*?\/n\/([a-z0-9]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i
  for (let m; (m = pRe.exec(html)) !== null; ) {
    const content = m[1]
    const marker = content.match(markerRe)
    if (!marker) continue
    const a = content.slice(marker.index! + marker[0].length).match(aRe)
    if (!a) continue
    const title = a[3].replace(/<[^>]+>/g, '').trim()
    return { key: a[2], title }
  }
  return null
}

function stripNavigationParagraphs(html: string): string {
  // Match a <strong>...marker...</strong> that's almost entirely the marker
  // (bounded length of other text around it). Drops both "次の話 + link" and
  // the link-less "次の話 " left in the final chapter.
  const navStrong = new RegExp(
    `<strong>[^<]{0,8}(?:${NAV_MARKERS_ALL})[^<]{0,8}<\\/strong>`,
    'i',
  )
  return html.replace(/<p[^>]*>[\s\S]*?<\/p>/g, p => (navStrong.test(p) ? '' : p))
}

// ---------- auth ----------

export interface MeUser {
  id?: number
  urlname?: string
  nickname?: string
}

// Posts credentials directly to note.com (proxied). Returns the user object
// on success, throws with note.com's error message on failure. The proxy
// exposes the session id as `X-Session-Token`; we persist it so that later
// requests can authenticate via `Authorization: Bearer` even when WKWebView
// refuses to keep the cross-site cookie. If `rememberMe` is true, the
// (email, password) pair is also persisted so the next app boot can
// auto-login in case the token didn't survive force-kill flush.
export async function login(
  email: string,
  password: string,
  rememberMe = false,
): Promise<MeUser> {
  const res = await fetch(`${BASE}/v1/sessions/sign_in`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: email, password }),
  })
  const j = await res.json().catch(() => ({}))
  if (j?.error?.message) throw new Error(j.error.message)
  if (!res.ok) throw new Error(`login HTTP ${res.status}`)
  const token = res.headers.get('X-Session-Token')
  const me = (j?.data ?? {}) as MeUser
  sessionToken = token || null
  cachedMe = me
  storedCreds = rememberMe ? { email, password } : null
  await persistSession()
  return me
}

// Use stored credentials (if any) to re-authenticate. Returns null if no
// credentials are saved or the login fails (in which case the saved
// credentials are cleared so we stop trying).
export async function tryAutoLogin(): Promise<MeUser | null> {
  if (!storedCreds) return null
  try {
    return await login(storedCreds.email, storedCreds.password, true)
  } catch {
    storedCreds = null
    sessionToken = null
    cachedMe = null
    await persistSession()
    return null
  }
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/v1/sessions/sign_out`, { ...fetchOpts(), method: 'DELETE' }).catch(() => {})
  sessionToken = null
  cachedMe = null
  storedCreds = null
  await persistSession()
}

export async function fetchMe(): Promise<MeUser | null> {
  try {
    const res = await fetch(`${BASE}/v3/users/me`, fetchOpts())
    if (!res.ok) return null
    const j = await res.json()
    const data = j?.data
    if (!data || !data.id) return null
    return data as MeUser
  } catch {
    return null
  }
}

// Extract a magazine key (m=... or /m/<key>) from a note.com URL.
export function magazineKeyFromUrl(input: string): string | null {
  const trimmed = input.trim()
  const mParam = trimmed.match(/[?&]m(?:agazine_key)?=([a-z0-9]+)/i)
  if (mParam) return mParam[1]
  const path = trimmed.match(/\/m\/([a-z0-9]+)/i)
  if (path) return path[1]
  if (/^m[a-z0-9]+$/i.test(trimmed)) return trimmed
  return null
}

function toSummary(n: any): NoteSummary {
  return {
    key: String(n?.key ?? ''),
    name: String(n?.name ?? '').trim(),
    user: String(n?.user?.nickname ?? '').trim(),
  }
}

function toMagazineSummary(m: any): MagazineSummary {
  return {
    key: String(m?.key ?? ''),
    name: String(m?.name ?? '').trim(),
    description: m?.description ? String(m.description).trim() : undefined,
  }
}

function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<\/(?:p|h[1-6]|div|li|blockquote|pre)\s*>/gi, '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '・')
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
