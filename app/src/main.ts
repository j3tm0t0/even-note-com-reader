declare const __APP_VERSION__: string

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { wrapToLines } from './wrap'
import {
  searchNotes,
  searchMagazines,
  fetchMagazine,
  fetchMyMagazines,
  fetchArticle,
  magazineKeyFromUrl,
  login,
  logout,
  fetchMe,
  tryAutoLogin,
  getSessionToken,
  getCachedMe,
  hasStoredCredentials,
  initPersistence,
  getLastProbe,
  getLastTokenSaveResult,
  getCachedUIState,
  rememberMode,
  rememberSearch,
  rememberMagazineUrl,
  rememberCurrentMagazine,
  rememberArticle,
  registerPersistenceLifecycle,
  type Article,
  type MagazineSummary,
  type MeUser,
  type NoteSummary,
  type ViewMode,
} from './api'

const BODY_W = 576
const BODY_PAD = 4
const BODY_BORDER = 0
const LINE_HEIGHT = 27
const LINES_PER_VIEW = 9
const BODY_H = LINES_PER_VIEW * LINE_HEIGHT + 2 * (BODY_PAD + BODY_BORDER)
const INNER_W = BODY_W - 2 * (BODY_PAD + BODY_BORDER)
const STEP = LINES_PER_VIEW
const READING_CPM = 500

const PAGER_Y = BODY_H + 4
const PAGER_PAD = 4
const PAGER_INNER_W = BODY_W - 2 * PAGER_PAD

// ---------- session persistence ----------
// Legacy dev-mode cookie mirror. Prod uses bearer tokens via api.ts, but
// keeping this around so Vite dev still roundtrips the session cookie.
const COOKIE_STORAGE_KEY = 'eveng2.note.cookies'

function restoreCookies(): void {
  const saved = localStorage.getItem(COOKIE_STORAGE_KEY)
  if (!saved) return
  for (const pair of saved.split(';')) {
    const trimmed = pair.trim()
    if (trimmed) document.cookie = `${trimmed}; path=/; max-age=2592000`
  }
}

function persistCookies(): void {
  if (document.cookie) localStorage.setItem(COOKIE_STORAGE_KEY, document.cookie)
  else localStorage.removeItem(COOKIE_STORAGE_KEY)
}

function clearCookies(): void {
  localStorage.removeItem(COOKIE_STORAGE_KEY)
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0].trim()
    if (name) document.cookie = `${name}=; path=/; max-age=0`
  }
}

restoreCookies()

// ---------- bridge first, before any DOM mutation ----------
const bridge = await waitForEvenAppBridge()

// Bridge-backed storage survives WebView relaunch where browser localStorage
// does not. Await this so setAuth below sees the restored token/me.
await initPersistence(bridge)
registerPersistenceLifecycle()

let allLines: string[] = ['(loading...)']
let topLine = 0
let maxTop = 0
let activeArticle: Article | null = null
let currentList: NoteSummary[] = []
let currentIndex = -1

const body = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: BODY_W,
  height: BODY_H,
  borderWidth: BODY_BORDER,
  borderColor: 5,
  paddingLength: BODY_PAD,
  containerID: 1,
  containerName: 'body',
  content: visibleText(),
  isEventCapture: 1,
})

const pager = new TextContainerProperty({
  xPosition: 0,
  yPosition: PAGER_Y,
  width: BODY_W,
  height: 288 - PAGER_Y,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: PAGER_PAD,
  containerID: 2,
  containerName: 'pager',
  content: pagerLabel(),
  isEventCapture: 0,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [body, pager] }),
)
if (created !== 0) console.error('createStartUpPageContainer failed:', created)

// ---------- reader logic ----------
function visibleText(): string {
  return allLines.slice(topLine, topLine + LINES_PER_VIEW).join('\n')
}

function justify(left: string, right: string, innerWidth: number): string {
  const leftW = getTextWidth(left)
  const rightW = getTextWidth(right)
  const spaceW = Math.max(1, getTextWidth(' '))
  const gap = innerWidth - leftW - rightW
  if (gap <= spaceW) return `${left}  ${right}`
  return `${left}${' '.repeat(Math.floor(gap / spaceW))}${right}`
}

function currentHHMM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function pagerLabel(): string {
  // Trailing space keeps the LVGL textarea cursor (which we can't disable)
  // one glyph-width off the digits so it doesn't look like it's touching.
  const clock = `${currentHHMM()} `
  if (!activeArticle) {
    return justify('', clock, PAGER_INNER_W)
  }
  const seenLines = Math.min(allLines.length, topLine + LINES_PER_VIEW)
  const ratio = allLines.length ? seenLines / allLines.length : 1
  const pct = `${Math.round(ratio * 100)}%`

  const remainingChars = allLines.slice(seenLines).reduce((s, l) => s + l.length, 0)
  const remaining = remainingChars === 0
    ? '読了'
    : `残り ${Math.ceil(remainingChars / READING_CPM)} 分`

  const left = `${pct}  ${remaining}`
  return justify(left, clock, PAGER_INNER_W)
}

// Serialize container upgrades so they hit the bridge in order, but always
// swallow a prior rejection on the head of the queue — one transient
// textContainerUpgrade failure would otherwise wedge the chain permanently
// and freeze the display until reload.
let rendering: Promise<unknown> = Promise.resolve()

function enqueueRender(job: () => Promise<void>): Promise<void> {
  const next = rendering.catch(() => {}).then(job).catch(err => {
    console.error('render bridge update failed:', err)
  })
  rendering = next
  return next
}

async function render(): Promise<void> {
  await enqueueRender(async () => {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'body', content: visibleText() }),
    )
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 2, containerName: 'pager', content: pagerLabel() }),
    )
  })
  mirrorCompanion()
}

// Pager-only refresh so the clock ticks over without blinking the body.
async function renderPager(): Promise<void> {
  await enqueueRender(async () => {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 2, containerName: 'pager', content: pagerLabel() }),
    )
  })
  const progress = $<HTMLPreElement>('progress')
  if (progress) progress.textContent = pagerLabel()
}

// Align clock ticks to real minute boundaries: wait until the next :00
// second, fire once, then every 60s.
setTimeout(() => {
  void renderPager()
  setInterval(() => void renderPager(), 60_000)
}, (60 - new Date().getSeconds()) * 1000 + 50)

function advance(delta: number): void {
  const next = Math.max(0, Math.min(maxTop, topLine + delta))
  if (next === topLine) {
    // Tapping at the last page advances to the next article in the current
    // list (search / magazine results). Lets the reader move forward without
    // looking at the phone.
    if (delta > 0 && topLine === maxTop) advanceToNextArticle()
    return
  }
  topLine = next
  render().catch(err => console.error(err))
}

function advanceToNextArticle(): void {
  // Prefer the "次の話" link the author embedded in the article body — magazine
  // listing order often disagrees with reading order (e.g. prologue placed
  // last). Only fall back to list-order when the article has no such link.
  if (activeArticle?.nextKey) {
    void loadArticle(activeArticle.nextKey, activeArticle.nextTitle)
    return
  }
  if (currentList.length === 0) {
    showPlaceholder('記事の終わり', '次の記事はありません')
    render().catch(err => console.error(err))
    return
  }
  const nextIdx = currentIndex + 1
  if (nextIdx >= currentList.length) {
    showPlaceholder('リストの終わり', '次の記事はありません')
    render().catch(err => console.error(err))
    return
  }
  const next = currentList[nextIdx]
  currentIndex = nextIdx
  highlightActive()
  void loadArticle(next.key, next.name)
}

async function loadArticle(key: string, hintTitle?: string): Promise<void> {
  setStatus(`記事取得中: ${key}`)
  showPlaceholder('読み込み中...', hintTitle)
  await render()
  try {
    const article = await fetchArticle(key)
    activeArticle = article
    void rememberArticle({ key: article.key, title: article.title }).then(() =>
      updateDiag(`article_persisted`),
    )
    const titleLines = article.title ? wrapToLines(article.title, INNER_W) : []
    const bodyLines = wrapToLines(article.text, INNER_W)
    allLines = titleLines.length ? [...titleLines, '', ...bodyLines] : bodyLines
    maxTop = Math.max(0, allLines.length - LINES_PER_VIEW)
    topLine = 0
    setActiveLabel(article)
    setStatus('')
    // If the article belongs to the currently displayed list, sync the index
    // so DOUBLE_CLICK / end-of-article advance picks the right next entry.
    const idx = currentList.findIndex(n => n.key === key)
    if (idx !== -1) currentIndex = idx
    highlightActive()
    await render()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus(`記事取得失敗: ${msg}`)
    showPlaceholder('読み込み失敗', msg)
    await render()
  }
}

// Render a centered single-line message to the body. Used while loading or
// on error so the G2 reflects the action immediately.
function showPlaceholder(message: string, sub?: string): void {
  activeArticle = null
  const blank = ' '
  const lines: string[] = Array(LINES_PER_VIEW).fill(blank)
  lines[Math.floor(LINES_PER_VIEW / 2) - 1] = centerLine(message)
  if (sub) lines[Math.floor(LINES_PER_VIEW / 2) + 1] = centerLine(sub)
  allLines = lines
  maxTop = 0
  topLine = 0
}

function centerLine(text: string): string {
  const textW = getTextWidth(text)
  const spaceW = Math.max(1, getTextWidth(' '))
  const pad = Math.max(0, Math.floor((INNER_W - textW) / (2 * spaceW)))
  return `${' '.repeat(pad)}${text}`
}

// ---------- input events from G2 ----------
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    advance(-STEP)
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    advance(+STEP)
    return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT) {
    advance(+STEP)
    return
  }
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
if (import.meta.hot) import.meta.hot.dispose(() => cleanup())

// ---------- companion DOM (iPhone WebView) ----------
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main style="margin:0 auto;padding:16px;max-width:680px;width:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;">
    <header style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-end;gap:8px;">
      <div>
        <h1 style="font-size:18px;font-weight:600;margin:0 0 4px;">note.com reader <span style="font-size:11px;color:#9b9b9b;font-weight:400;">v${__APP_VERSION__}</span></h1>
        <div id="status" style="font-size:11px;color:#9b9b9b;min-height:14px;"></div>
      </div>
      <div id="authBox" style="font-size:11px;color:#9ED69E;text-align:right;line-height:1.4;"></div>
    </header>

    <section id="loginPanel" style="display:none;flex-direction:column;gap:8px;margin-bottom:14px;padding:10px;border:1px solid #3E3E3E;border-radius:8px;background:#1A1A1A;">
      <div style="font-size:12px;color:#9b9b9b;">note.com のアカウントでログイン</div>
      <input id="loginEmail" type="email" placeholder="メールアドレス" autocomplete="username" style="padding:8px 10px;border:1px solid #3E3E3E;border-radius:8px;background:#0F0F0F;color:#E5E5E5;font-size:14px;" />
      <input id="loginPassword" type="password" placeholder="パスワード" autocomplete="current-password" style="padding:8px 10px;border:1px solid #3E3E3E;border-radius:8px;background:#0F0F0F;color:#E5E5E5;font-size:14px;" />
      <label style="font-size:12px;color:#9b9b9b;display:flex;align-items:center;gap:6px;">
        <input id="rememberMe" type="checkbox" checked style="margin:0;" />
        ログイン状態を保持する
      </label>
      <div style="font-size:10px;color:#6b6b6b;margin-top:-4px;">チェック時はパスワードを端末内に保存し、次回から自動でログインします。</div>
      <button id="loginBtn" style="padding:8px 12px;border:0;border-radius:8px;background:#3A6F3A;color:#fff;font-size:13px;">ログイン</button>
    </section>

    <nav id="modeTabs" style="display:flex;gap:4px;margin-bottom:10px;border-bottom:1px solid #2E2E2E;">
      <button data-mode="my" class="modeTab" style="display:none;padding:6px 10px;border:0;background:transparent;color:#9b9b9b;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;">マイマガジン</button>
      <button data-mode="note" class="modeTab" style="padding:6px 10px;border:0;background:transparent;color:#9b9b9b;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;">記事検索</button>
      <button data-mode="mag" class="modeTab" style="padding:6px 10px;border:0;background:transparent;color:#9b9b9b;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;">マガジン検索</button>
      <button data-mode="url" class="modeTab" style="padding:6px 10px;border:0;background:transparent;color:#9b9b9b;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;">URL で開く</button>
    </nav>

    <section id="modePanel" style="margin-bottom:14px;">
      <div id="panel-my" class="modePanel" style="display:none;gap:6px;">
        <button id="refreshMyBtn" style="padding:8px 12px;border:0;border-radius:8px;background:#3A6F3A;color:#fff;font-size:13px;">マイマガジンを読み込む</button>
      </div>
      <div id="panel-note" class="modePanel" style="display:none;gap:6px;">
        <input id="searchInput" type="search" placeholder="記事を検索…" style="flex:1;padding:8px 10px;border:1px solid #3E3E3E;border-radius:8px;background:#1A1A1A;color:#E5E5E5;font-size:14px;" />
        <button id="searchBtn" style="padding:8px 12px;border:0;border-radius:8px;background:#3A6F3A;color:#fff;font-size:13px;">検索</button>
      </div>
      <div id="panel-mag" class="modePanel" style="display:none;gap:6px;">
        <input id="magSearchInput" type="search" placeholder="マガジンを検索…" style="flex:1;padding:8px 10px;border:1px solid #3E3E3E;border-radius:8px;background:#1A1A1A;color:#E5E5E5;font-size:14px;" />
        <button id="magSearchBtn" style="padding:8px 12px;border:0;border-radius:8px;background:#3A6F3A;color:#fff;font-size:13px;">検索</button>
      </div>
      <div id="panel-url" class="modePanel" style="display:none;gap:6px;">
        <input id="magInput" type="text" placeholder="マガジン URL or key" style="flex:1;padding:8px 10px;border:1px solid #3E3E3E;border-radius:8px;background:#1A1A1A;color:#E5E5E5;font-size:14px;" />
        <button id="magBtn" style="padding:8px 12px;border:0;border-radius:8px;background:#5B5B5B;color:#fff;font-size:13px;">開く</button>
      </div>
    </section>

    <div id="breadcrumb" style="display:none;font-size:12px;margin-bottom:6px;">
      <a href="#" id="breadcrumbBack" style="color:#9ED69E;">← マガジン一覧に戻る</a>
      <span id="breadcrumbCurrent" style="color:#9b9b9b;margin-left:8px;"></span>
    </div>

    <section style="margin-bottom:14px;">
      <div id="listLabel" style="font-size:12px;color:#9b9b9b;margin-bottom:6px;"></div>
      <ol id="list" style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;border:1px solid #2E2E2E;border-radius:8px;background:#1A1A1A;"></ol>
    </section>

    <section>
      <div id="activeLabel" style="font-size:12px;color:#9ED69E;margin-bottom:6px;">記事を選んでください</div>
      <pre id="mirror" style="background:#2E2E2E;border:1px solid #3E3E3E;border-radius:12px;padding:16px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#E5E5E5;margin:0 0 8px;min-height:160px;"></pre>
      <pre id="progress" style="font-family:ui-monospace,monospace;color:#9ED69E;text-align:center;margin:0;"></pre>
    </section>

    <div id="diag" style="font-size:10px;color:#6b6b6b;margin-top:14px;word-break:break-all;"></div>
  </main>
`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null
const searchInput = $<HTMLInputElement>('searchInput')!
const searchBtn = $<HTMLButtonElement>('searchBtn')!
const magSearchInput = $<HTMLInputElement>('magSearchInput')!
const magSearchBtn = $<HTMLButtonElement>('magSearchBtn')!
const magInput = $<HTMLInputElement>('magInput')!
const magBtn = $<HTMLButtonElement>('magBtn')!
const refreshMyBtn = $<HTMLButtonElement>('refreshMyBtn')!
const listEl = $<HTMLOListElement>('list')!
const listLabel = $<HTMLDivElement>('listLabel')!
const activeLabel = $<HTMLDivElement>('activeLabel')!
const authBox = $<HTMLDivElement>('authBox')!
const loginPanel = $<HTMLElement>('loginPanel')!
const loginEmail = $<HTMLInputElement>('loginEmail')!
const loginPassword = $<HTMLInputElement>('loginPassword')!
const loginBtn = $<HTMLButtonElement>('loginBtn')!
const rememberMe = $<HTMLInputElement>('rememberMe')!
const diagEl = $<HTMLDivElement>('diag')!
const breadcrumbEl = $<HTMLDivElement>('breadcrumb')!
const breadcrumbBack = $<HTMLAnchorElement>('breadcrumbBack')!
const breadcrumbCurrent = $<HTMLSpanElement>('breadcrumbCurrent')!

let activeMode: ViewMode = 'my'
let activeMagazine: { key: string; name: string } | null = null

function setMode(mode: ViewMode, options: { persist?: boolean } = {}): void {
  activeMode = mode
  document.querySelectorAll<HTMLButtonElement>('.modeTab').forEach(btn => {
    const isActive = btn.dataset.mode === mode
    btn.style.color = isActive ? '#E5E5E5' : '#9b9b9b'
    btn.style.borderBottom = isActive ? '2px solid #9ED69E' : '2px solid transparent'
  })
  document.querySelectorAll<HTMLDivElement>('.modePanel').forEach(p => {
    p.style.display = p.id === `panel-${mode}` ? 'flex' : 'none'
  })
  if (options.persist !== false) void rememberMode(mode)
}

function setBreadcrumb(mag: { key: string; name: string } | null): void {
  if (mag) {
    breadcrumbEl.style.display = 'block'
    breadcrumbCurrent.textContent = mag.name || mag.key
  } else {
    breadcrumbEl.style.display = 'none'
    breadcrumbCurrent.textContent = ''
  }
}

document.querySelectorAll<HTMLButtonElement>('.modeTab').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode as ViewMode
    if (!m || m === activeMode) return
    setMode(m)
    // Switching modes clears the current-magazine breadcrumb so the new mode
    // shows its own fresh content. Articles stay loaded on G2 / preview.
    activeMagazine = null
    void rememberCurrentMagazine(null)
    setBreadcrumb(null)
    listEl.innerHTML = ''
    listLabel.textContent = ''
    if (m === 'my') void runMyMagazines()
  })
})

breadcrumbBack.addEventListener('click', e => {
  e.preventDefault()
  activeMagazine = null
  void rememberCurrentMagazine(null)
  setBreadcrumb(null)
  if (activeMode === 'my') void runMyMagazines()
  else if (activeMode === 'mag' && magSearchInput.value.trim()) void runMagazineSearch()
  else listEl.innerHTML = ''
})

function updateDiag(extra = ''): void {
  const token = getSessionToken()
  const probe = getLastProbe()
  const parts = [
    token ? `token=${token.slice(0, 8)}…` : 'token=none',
  ]
  if (probe) {
    parts.push(`boot{br=${probe.bridgeFields}}`)
  }
  parts.push(getLastTokenSaveResult())
  if (extra) parts.push(extra)
  diagEl.textContent = parts.join(' | ')
}
updateDiag()

searchBtn.addEventListener('click', runSearch)
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch()
})
magSearchBtn.addEventListener('click', runMagazineSearch)
magSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runMagazineSearch()
})
magBtn.addEventListener('click', runMagazineUrl)
magInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runMagazineUrl()
})
refreshMyBtn.addEventListener('click', runMyMagazines)

loginBtn.addEventListener('click', runLogin)
loginPassword.addEventListener('keydown', e => {
  if (e.key === 'Enter') runLogin()
})

async function runLogin(): Promise<void> {
  const email = loginEmail.value.trim()
  const password = loginPassword.value
  if (!email || !password) return
  loginBtn.disabled = true
  setStatus('ログイン中...')
  try {
    const me = await login(email, password, rememberMe.checked)
    persistCookies()
    loginPassword.value = ''
    loginEmail.value = ''
    setAuth(me)
    updateDiag(`login_ok nick=${me.nickname ?? '?'}`)
    setStatus('ログインしました')
    // Reload current article so paid sections render now that we're authed.
    if (activeArticle) void loadArticle(activeArticle.key, activeArticle.title)
  } catch (err) {
    setStatus(`ログイン失敗: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    loginBtn.disabled = false
  }
}

async function runLogout(): Promise<void> {
  setStatus('ログアウト中...')
  try {
    await logout()
  } finally {
    clearCookies()
    setAuth(null)
    updateDiag('logout_done')
    setStatus('ログアウトしました')
    if (activeArticle) void loadArticle(activeArticle.key, activeArticle.title)
  }
}

function setAuth(user: MeUser | null): void {
  // マイマガジンはログイン必須のエンドポイントなので、未ログイン時はタブを隠す。
  const myTab = document.querySelector<HTMLButtonElement>('.modeTab[data-mode="my"]')
  if (myTab) myTab.style.display = user ? 'inline-block' : 'none'
  if (user) {
    const name = user.nickname || user.urlname || `id:${user.id}`
    authBox.innerHTML = `<div>${escapeHtml(name)} としてログイン中</div><a href="#" id="logoutLink" style="color:#9ED69E;font-size:11px;">ログアウト</a>`
    document.getElementById('logoutLink')!.addEventListener('click', e => {
      e.preventDefault()
      void runLogout()
    })
    loginPanel.style.display = 'none'
  } else {
    // マイマガジンモード中にログアウトされたら記事検索に寄せる。
    if (activeMode === 'my') setMode('note')
    // Stored session present but /users/me said unauthed → stale token.
    // Surface "再ログイン" to hint that credentials are remembered but expired.
    const hasStoredSession =
      getSessionToken() !== null || localStorage.getItem(COOKIE_STORAGE_KEY) !== null
    const label = hasStoredSession ? '再ログイン' : 'ログイン'
    authBox.innerHTML = `<a href="#" id="showLoginLink" style="color:#9ED69E;">${label}</a>`
    loginBtn.textContent = label
    document.getElementById('showLoginLink')!.addEventListener('click', e => {
      e.preventDefault()
      loginPanel.style.display = loginPanel.style.display === 'none' ? 'flex' : 'none'
    })
  }
}

async function runSearch(): Promise<void> {
  const q = searchInput.value.trim()
  if (!q) return
  setStatus(`検索中: ${q}`)
  try {
    const hits = await searchNotes(q)
    renderNoteList(hits, `検索結果: ${q} (${hits.length})`)
    activeMagazine = null
    setBreadcrumb(null)
    void rememberCurrentMagazine(null)
    void rememberSearch(q)
    setStatus('')
  } catch (err) {
    setStatus(`検索失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runMagazineSearch(): Promise<void> {
  const q = magSearchInput.value.trim()
  if (!q) return
  setStatus(`マガジン検索中: ${q}`)
  try {
    const hits = await searchMagazines(q)
    renderMagazineList(hits, `マガジン検索結果: ${q} (${hits.length})`)
    activeMagazine = null
    setBreadcrumb(null)
    void rememberCurrentMagazine(null)
    void rememberSearch(q)
    setStatus('')
  } catch (err) {
    setStatus(`マガジン検索失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runMagazineUrl(): Promise<void> {
  const raw = magInput.value.trim()
  const key = magazineKeyFromUrl(raw) ?? raw
  if (!key) return
  void rememberMagazineUrl(raw)
  await openMagazine({ key, name: raw })
}

async function runMyMagazines(): Promise<void> {
  setStatus('マイマガジン取得中...')
  try {
    const mags = await fetchMyMagazines()
    renderMagazineList(mags, `マイマガジン (${mags.length})`)
    activeMagazine = null
    setBreadcrumb(null)
    void rememberCurrentMagazine(null)
    setStatus('')
  } catch (err) {
    setStatus(`マイマガジン失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function openMagazine(mag: { key: string; name: string }): Promise<void> {
  setStatus(`マガジン取得中: ${mag.name || mag.key}`)
  try {
    const data = await fetchMagazine(mag.key)
    const displayName = data.name || mag.name || mag.key
    activeMagazine = { key: mag.key, name: displayName }
    setBreadcrumb(activeMagazine)
    void rememberCurrentMagazine(activeMagazine)
    renderNoteList(data.notes, `マガジン: ${displayName} (${data.notes.length})`)
    setStatus('')
  } catch (err) {
    setStatus(`マガジン失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function renderNoteList(notes: NoteSummary[], label: string): void {
  listLabel.textContent = label
  listEl.innerHTML = ''
  currentList = notes
  currentIndex = activeArticle
    ? notes.findIndex(n => n.key === activeArticle!.key)
    : -1
  notes.forEach((note, idx) => {
    const li = document.createElement('li')
    li.dataset.key = note.key
    li.style.cssText = 'padding:8px 12px;border-bottom:1px solid #2E2E2E;cursor:pointer;color:#E5E5E5;'
    li.innerHTML = `
      <div style="font-size:14px;line-height:1.4;">${escapeHtml(note.name)}</div>
      <div style="font-size:11px;color:#7B7B7B;margin-top:2px;">${escapeHtml(note.user)} · ${note.key}</div>
    `
    li.addEventListener('click', () => {
      currentIndex = idx
      void loadArticle(note.key, note.name)
    })
    listEl.appendChild(li)
  })
  highlightActive()
}

function renderMagazineList(mags: MagazineSummary[], label: string): void {
  listLabel.textContent = label
  listEl.innerHTML = ''
  currentList = []
  currentIndex = -1
  mags.forEach(mag => {
    const li = document.createElement('li')
    li.dataset.key = mag.key
    li.style.cssText = 'padding:8px 12px;border-bottom:1px solid #2E2E2E;cursor:pointer;color:#E5E5E5;'
    const desc = mag.description ? `<div style="font-size:11px;color:#7B7B7B;margin-top:2px;">${escapeHtml(mag.description)}</div>` : ''
    li.innerHTML = `
      <div style="font-size:14px;line-height:1.4;">${escapeHtml(mag.name || mag.key)}</div>
      ${desc}
    `
    li.addEventListener('click', () => {
      void openMagazine({ key: mag.key, name: mag.name })
    })
    listEl.appendChild(li)
  })
}

function highlightActive(): void {
  const items = listEl.querySelectorAll<HTMLLIElement>('li')
  items.forEach((li, idx) => {
    if (idx === currentIndex) {
      li.style.background = '#2A4A2A'
      li.style.borderLeft = '3px solid #9ED69E'
    } else {
      li.style.background = ''
      li.style.borderLeft = ''
    }
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function setStatus(text: string): void {
  const el = $<HTMLDivElement>('status')
  if (el) el.textContent = text
}

function setActiveLabel(article: Article): void {
  activeLabel.textContent = `▶ ${article.title}${article.author ? ` / ${article.author}` : ''}`
}

function mirrorCompanion(): void {
  const mirror = $<HTMLPreElement>('mirror')
  const progress = $<HTMLPreElement>('progress')
  if (mirror) mirror.textContent = visibleText()
  if (progress) progress.textContent = pagerLabel()
}

const ui = getCachedUIState()
searchInput.value = ui.search ?? ''
magSearchInput.value = ui.search ?? ''
magInput.value = ui.magazine ?? ''
// Default to マイマガジン if we already know we'll be logged in; otherwise
// fall back to 記事検索 so the fresh-install / logged-out state doesn't land
// on a mode whose only action (/v1/my/magazines) is going to 401.
const defaultMode: ViewMode =
  getSessionToken() || hasStoredCredentials() ? 'my' : 'note'
setMode(ui.mode ?? defaultMode, { persist: false })
activeMagazine = ui.currentMagazine ?? null
setBreadcrumb(activeMagazine)

showPlaceholder('記事を選んでください', '検索またはマガジン URL を入力')
void render()
// Optimistically paint the logged-in UI from cached me if we either have a
// token or stored credentials (which will auto-login shortly). Avoids the
// "ログイン" link flashing for a second on every boot while auto-login runs.
const canAuth = getSessionToken() !== null || hasStoredCredentials()
setAuth(canAuth ? getCachedMe() : null)

void (async () => {
  if (!getSessionToken() && hasStoredCredentials()) {
    const me = await tryAutoLogin()
    if (me) {
      setAuth(me)
      updateDiag(`auto_login nick=${me.nickname ?? '?'}`)
      const cur = activeArticle as Article | null
      if (cur) void loadArticle(cur.key, cur.title)
      return
    }
    setAuth(null)
    updateDiag('auto_login_failed')
    return
  }
  const me = await fetchMe()
  if (me) setAuth(me)
  else if (!getSessionToken()) setAuth(null)
  updateDiag(me ? `me_ok nick=${me.nickname ?? '?'}` : 'me_skip')
})()

// Re-hydrate the list area based on the last mode. If the user was drilled
// into a specific magazine (activeMagazine set), go straight to its notes.
if (activeMagazine) {
  void openMagazine(activeMagazine)
} else if (activeMode === 'my') {
  void runMyMagazines()
} else if (activeMode === 'note' && ui.search) {
  void runSearch()
} else if (activeMode === 'mag' && ui.search) {
  void runMagazineSearch()
}
if (ui.article) void loadArticle(ui.article.key, ui.article.title)
