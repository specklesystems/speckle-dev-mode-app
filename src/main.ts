import {
  parseVersionUrl,
  resolveVersionInfo,
  fetchArtifacts,
  downloadQueryableFiles,
  openSsoReauth,
  legacyObjectIdFrom,
  SsoSessionExpiredError,
  type ModelRef,
  type VersionRef,
  type VersionFormat,
  type VersionInfo
} from './speckleApi'
import { bundleMountSql, toBundleSchema } from './bundleSchema'
import { registerParquetBuffer, runSqlBatch } from './duckdb'
import { buildTree, type ContainerNode } from './tree'
import { renderTree } from './render'
import { fetchLegacyObject, type LegacyObject, type LegacyRef } from './legacyGraph'
import { renderLegacyTree } from './renderLegacy'
import { startLogin, completePendingLogin, getStoredSession, clearStoredSession } from './auth'
import { SPECKLE_CUBE_SVG } from './logo'
import { installDevModeApi } from './api'

const DEFAULT_ORIGIN = 'https://app.speckle.systems'

/**
 * These are plain text fields (a server URL, a model URL) sitting next to a
 * "sign in" button — password managers' login-form heuristics key off that
 * proximity and offer to fill them anyway. No single attribute reliably
 * stops this: per-manager opt-outs (1Password, Bitwarden, Dashlane) PLUS the
 * generic `autocomplete="off"`, set at both the input and its wrapping
 * `<form>` — the spec's actual container level for it, which LastPass in
 * particular weighs more than the input-level value alone. The wrapper uses
 * `display: contents` so it's invisible to the surrounding flex layout, and
 * swallows submit so Enter in the field can't trigger a real form post.
 */
function preventPasswordManagers(input: HTMLInputElement): HTMLFormElement {
  input.autocomplete = 'off'
  input.setAttribute('data-1p-ignore', '')
  input.setAttribute('data-lpignore', 'true')
  input.setAttribute('data-bwignore', 'true')
  input.setAttribute('data-form-type', 'other')

  const form = document.createElement('form')
  form.autocomplete = 'off'
  form.style.display = 'contents'
  form.addEventListener('submit', (e) => e.preventDefault())
  form.appendChild(input)
  return form
}

const app = document.getElementById('app')!

const brandBar = document.createElement('div')
brandBar.className = 'brand-bar'
app.appendChild(brandBar)

const brand = document.createElement('div')
brand.className = 'brand'
brand.innerHTML = `${SPECKLE_CUBE_SVG}<span class="brand-name">Speckle</span><span class="brand-sep">/</span><span class="brand-title">Dev Mode</span>`
brandBar.appendChild(brand)

const authControls = document.createElement('div')
authControls.className = 'auth-controls'
brandBar.appendChild(authControls)

const originInput = document.createElement('input')
originInput.id = 'origin'
originInput.value = DEFAULT_ORIGIN
authControls.appendChild(preventPasswordManagers(originInput))

const signInButton = document.createElement('button')
signInButton.textContent = 'sign in with Speckle'
authControls.appendChild(signInButton)

const signedInLabel = document.createElement('span')
signedInLabel.className = 'signed-in-label'
authControls.appendChild(signedInLabel)

const signOutButton = document.createElement('button')
signOutButton.id = 'sign-out'
signOutButton.textContent = 'sign out'
authControls.appendChild(signOutButton)

const toolbar = document.createElement('div')
toolbar.className = 'toolbar'
app.appendChild(toolbar)

const urlInput = document.createElement('input')
urlInput.id = 'version-url'
urlInput.placeholder = `${DEFAULT_ORIGIN}/projects/<projectId>/models/<modelId>[@<versionId>]`
toolbar.appendChild(preventPasswordManagers(urlInput))

const loadButton = document.createElement('button')
loadButton.textContent = 'load data'
toolbar.appendChild(loadButton)

/** This kiosk is for poking at raw data — actually working with a model
 * (viewing geometry, comments, the real UI) belongs in the main app. Same
 * URL shape the input already accepts, so it's just the pasted/loaded URL
 * opened in a new tab rather than a second thing to maintain. */
const viewInSpeckleLink = document.createElement('a')
viewInSpeckleLink.id = 'view-in-speckle'
viewInSpeckleLink.textContent = 'view in Speckle ↗'
viewInSpeckleLink.target = '_blank'
viewInSpeckleLink.rel = 'noopener noreferrer'
viewInSpeckleLink.hidden = true
toolbar.appendChild(viewInSpeckleLink)

const status = document.createElement('div')
status.className = 'status'
app.appendChild(status)

const statusAction = document.createElement('div')
statusAction.className = 'status-action'
app.appendChild(statusAction)

/** Shown whenever a version resolved BOTH a mounted bundle/packfile schema
 * (even an empty one — e.g. `bundle_fd8904416a` mounted with 0 objects for
 * https://app.speckle.systems/projects/7672e81243/models/2bf680bbf1, which
 * is itself useful to see, not just a dead end) and a legacy referencedObject
 * to walk. Lets you flip between "what migrated" and "what's actually there"
 * instead of the app silently picking one. */
const viewSwitcher = document.createElement('div')
viewSwitcher.className = 'view-switcher'
viewSwitcher.hidden = true
app.appendChild(viewSwitcher)

const bundleViewButton = document.createElement('button')
bundleViewButton.className = 'view-tab'
bundleViewButton.textContent = 'bundle'
viewSwitcher.appendChild(bundleViewButton)

const legacyViewButton = document.createElement('button')
legacyViewButton.className = 'view-tab'
legacyViewButton.textContent = 'legacy object graph'
viewSwitcher.appendChild(legacyViewButton)

const treeMount = document.createElement('div')
treeMount.id = 'tree'
app.appendChild(treeMount)

function setStatus(text: string, isError = false): void {
  status.textContent = text
  status.classList.toggle('error', isError)
  statusAction.innerHTML = ''
}

function renderAuthState(): void {
  const session = getStoredSession()
  const signedIn = !!session
  originInput.hidden = signedIn
  signInButton.hidden = signedIn
  signedInLabel.hidden = !signedIn
  signOutButton.hidden = !signedIn
  toolbar.hidden = !signedIn
  signedInLabel.textContent = session ? session.origin : ''
}

/** A workspace's SSO session timing out mid-session is routine, not a bug —
 * offer the re-auth tab and a retry rather than just an error string. Shared
 * by every call site that can hit a lapsed SSO session (resolving a version,
 * fetching bundle artifacts, fetching a legacy object): `throwForErrorResponse`
 * classifies all three identically, so there's one place that knows how to
 * respond to it. `onRetry` re-runs whatever failed, from scratch. */
function setSsoExpiredStatus(err: SsoSessionExpiredError, origin: string, onRetry: () => void): void {
  status.textContent = `${err.message}. Re-authenticate, then retry.`
  status.classList.add('error')
  statusAction.innerHTML = ''

  const reauthButton = document.createElement('button')
  reauthButton.textContent = `sign in to ${err.workspaceSlug} SSO`
  reauthButton.addEventListener('click', () => openSsoReauth(origin, err.workspaceSlug))
  statusAction.appendChild(reauthButton)

  const retryButton = document.createElement('button')
  retryButton.textContent = 'retry'
  retryButton.addEventListener('click', onRetry)
  statusAction.appendChild(retryButton)
}

let lastSchema: string | null = null
let lastTree: ContainerNode | null = null
let lastLegacyRef: LegacyRef | null = null
let lastLegacyRoot: LegacyObject | null = null

type ViewMode = 'bundle' | 'legacy'

/** What's available to switch between for the CURRENTLY loaded version —
 * reset at the top of every {@link resolveAndAttach} call, since none of it
 * carries over to a different model/version. */
interface LoadedViews {
  bundleSchema: string | null
  bundleRoot: ContainerNode | null
  legacyRef: LegacyRef
  legacyObjectId: string | null
  token: string
}
let currentLoad: LoadedViews | null = null
let currentView: ViewMode | null = null

/**
 * DOM-independent core: fetch, download, mount and build the tree for one
 * resolved version. Used by both the click handler (which adds rendering and
 * SSO-retry UI around it) and `window.speckleDevMode` (which just wants the
 * data back as plain JSON — see `src/api.ts`).
 */
export async function attachCore(
  ref: VersionRef,
  token: string,
  onProgress?: (text: string) => void
): Promise<{ schema: string; root: ContainerNode }> {
  onProgress?.('listing artifacts…')
  const files = await fetchArtifacts(ref, token)

  onProgress?.(`downloading ${files.length} artifact files…`)
  const buffers = await downloadQueryableFiles(files, (done, total) =>
    onProgress?.(`downloading artifacts… ${done}/${total}`)
  )

  onProgress?.('registering parquet buffers…')
  for (const [name, bytes] of buffers) {
    await registerParquetBuffer(name, bytes)
  }

  const schema = toBundleSchema(ref.versionId)
  onProgress?.('mounting bundle views…')
  await runSqlBatch(bundleMountSql(schema, files))

  onProgress?.('building tree…')
  const root = await buildTree(schema)

  lastSchema = schema
  lastTree = root
  return { schema, root }
}

/** Renders into the live UI as a side effect; rethrows so a caller (the click
 * handler, or `window.speckleDevMode`) can also tell success from failure.
 * Also sets up `currentLoad`/the view switcher — `info`/`legacyRef` are only
 * needed for that, not for the attach itself. Lets errors (including a
 * lapsed SSO session) propagate rather than handling them here — the caller
 * (`resolveAndAttach`, by way of `performLoad`) is the one place that knows
 * how to respond to those, covering this AND the version-resolution and
 * legacy-graph fetches around it with the same handling. */
async function attach(
  ref: VersionRef,
  token: string,
  format: VersionFormat,
  info: VersionInfo,
  legacyRef: LegacyRef
): Promise<{ schema: string; format: VersionFormat; root: ContainerNode }> {
  loadButton.disabled = true
  treeMount.innerHTML = ''
  try {
    const result = await attachCore(ref, token, (text) => setStatus(text))
    renderTree(result.root, result.schema, treeMount)
    setStatus(`loaded ${result.schema} (${format}) — ${result.root.totalObjectCount} objects`)

    const legacyObjectId = legacyObjectIdFrom(info)
    currentLoad = {
      bundleSchema: result.schema,
      bundleRoot: result.root,
      legacyRef,
      legacyObjectId,
      token
    }
    currentView = 'bundle'
    if (legacyObjectId) {
      if (result.root.totalObjectCount === 0) {
        await showLegacyGraph(
          legacyRef,
          legacyObjectId,
          token,
          `${result.schema} (${format}) mounted with 0 objects`
        )
        currentView = 'legacy'
      }
      viewSwitcher.hidden = false
      updateViewSwitcherUI()
    }

    return { ...result, format }
  } finally {
    loadButton.disabled = false
  }
}

signInButton.addEventListener('click', () => {
  void startLogin(originInput.value.trim() || DEFAULT_ORIGIN)
})

signOutButton.addEventListener('click', () => {
  clearStoredSession()
  renderAuthState()
})

/**
 * A bundle (or legacy packfile) having nothing to mount isn't necessarily a
 * migration failure — the bundle vocabulary (`elements`/`displayValue`/
 * collections) only covers geometry-shaped data. A generic `Base`-as-container
 * payload has nothing matching that shape to extract, so this is the expected
 * outcome, not a bug to chase. The real content, if any, is still reachable
 * one object at a time via the legacy graph.
 */
async function showLegacyGraph(
  legacyRef: LegacyRef,
  objectId: string,
  token: string,
  reason: string | null
): Promise<void> {
  const prefix = reason ? `${reason} — ` : ''
  setStatus(`${prefix}loading legacy object graph…`)
  const root = await fetchLegacyObject(legacyRef, objectId, token)
  lastLegacyRef = legacyRef
  lastLegacyRoot = root
  renderLegacyTree(root, legacyRef, token, treeMount)
  setStatus(`${prefix}showing legacy object graph (${root.totalChildrenCount} total children)`)
}

function updateViewSwitcherUI(): void {
  bundleViewButton.classList.toggle('active', currentView === 'bundle')
  legacyViewButton.classList.toggle('active', currentView === 'legacy')
}

/** Switches the tree panel between the two views for the currently loaded
 * version, fetching the legacy graph on first switch to it and reusing
 * `lastLegacyRoot` afterward — `resolveAndAttach` clears that cache on every
 * new load, so "cached" here always means "cached for this version". */
async function switchView(mode: ViewMode): Promise<void> {
  if (!currentLoad || currentView === mode) return

  if (mode === 'bundle') {
    if (currentLoad.bundleRoot === null || currentLoad.bundleSchema === null) return
    currentView = 'bundle'
    updateViewSwitcherUI()
    renderTree(currentLoad.bundleRoot, currentLoad.bundleSchema, treeMount)
    setStatus(`showing ${currentLoad.bundleSchema} — ${currentLoad.bundleRoot.totalObjectCount} objects`)
    return
  }

  if (!currentLoad.legacyObjectId) return
  currentView = 'legacy'
  updateViewSwitcherUI()
  if (lastLegacyRoot) {
    renderLegacyTree(lastLegacyRoot, currentLoad.legacyRef, currentLoad.token, treeMount)
    setStatus(`showing legacy object graph (${lastLegacyRoot.totalChildrenCount} total children)`)
    return
  }
  try {
    await showLegacyGraph(currentLoad.legacyRef, currentLoad.legacyObjectId, currentLoad.token, null)
  } catch (err) {
    if (err instanceof SsoSessionExpiredError) {
      setSsoExpiredStatus(err, currentLoad.legacyRef.origin, () => {
        void switchView('legacy')
      })
    } else {
      setStatus(err instanceof Error ? err.message : String(err), true)
    }
  }
}

bundleViewButton.addEventListener('click', () => {
  void switchView('bundle')
})
legacyViewButton.addEventListener('click', () => {
  void switchView('legacy')
})

/** `window.speckleDevMode.resolveLegacyObject(id)` — the data-level equivalent
 * of clicking a `{referencedId, speckle_type: "reference"}` row open. Walking
 * the legacy graph programmatically is just repeated calls to this against
 * ids found in `data`, never a DOM click. */
async function resolveLegacyObject(objectId: string): Promise<LegacyObject> {
  const session = getStoredSession()
  if (!session) throw new Error('Not signed in — call speckleDevMode.signIn() first.')
  if (!lastLegacyRef) {
    throw new Error('No legacy graph loaded yet — call speckleDevMode.attach(url) first.')
  }
  return fetchLegacyObject(lastLegacyRef, objectId, session.token)
}

/**
 * Resolves a model URL to a concrete version (latest, if the URL named none)
 * and attaches it. When the version has both a mounted bundle/packfile
 * schema AND a legacy referencedObject, shows the view switcher so either
 * can be inspected — defaulting to whichever actually has content (the
 * legacy graph when the bundle mounted empty, the bundle otherwise). Shows
 * only the legacy graph, with no switcher, when there's no bundle/packfile
 * at all (`format === 'json'`).
 */
async function resolveAndAttach(
  model: ModelRef,
  token: string
): Promise<{ schema: string | null; format: VersionFormat; root: ContainerNode | null }> {
  setStatus('resolving version…')
  const info = await resolveVersionInfo(model, model.versionId, token)
  const legacyRef: LegacyRef = { origin: model.origin, projectId: model.projectId }

  lastLegacyRef = null
  lastLegacyRoot = null
  currentLoad = null
  currentView = null
  viewSwitcher.hidden = true

  if (info.format === 'json') {
    const legacyObjectId = legacyObjectIdFrom(info)
    if (!legacyObjectId) {
      setStatus('This version has no bundle, packfile, or referencedObject at all — nothing to show.', true)
      return { schema: null, format: info.format, root: null }
    }
    currentLoad = {
      bundleSchema: null,
      bundleRoot: null,
      legacyRef,
      legacyObjectId,
      token
    }
    currentView = 'legacy'
    await showLegacyGraph(legacyRef, legacyObjectId, token, 'No bundle or packfile for this version')
    return { schema: null, format: info.format, root: null }
  }

  const ref: VersionRef = { ...model, versionId: info.versionId }
  return attach(ref, token, info.format, info, legacyRef)
}

/** Mirrors the model URL into `?url=` on a successful load — the same param
 * `stashDeepLinkParam`/`init` already consume, so the address bar itself
 * becomes the bookmark: reload (or share the link) and it signs in if
 * needed, then re-loads this exact model automatically. `replaceState`, not
 * `pushState` — repeated loads during one exploring session shouldn't pile
 * up browser-history entries. */
function setBookmarkableUrl(rawUrl: string): void {
  const url = new URL(window.location.pathname, window.location.origin)
  url.searchParams.set('url', rawUrl)
  history.replaceState(null, '', url.toString())
}

/** The one place that handles a load failing outright — including a lapsed
 * SSO session, wherever in the flow it surfaces (version resolution, bundle
 * artifacts, or the legacy graph; `resolveAndAttach` and everything it calls
 * let those propagate up to here rather than handling them locally). Retry
 * re-runs the whole load, which re-resolves the version too rather than
 * trying to resume mid-flow — simpler, and version resolution is cheap. */
async function performLoad(model: ModelRef, token: string): Promise<void> {
  try {
    await resolveAndAttach(model, token)
  } catch (err) {
    if (err instanceof SsoSessionExpiredError) {
      setSsoExpiredStatus(err, model.origin, () => {
        void performLoad(model, token)
      })
    } else {
      setStatus(err instanceof Error ? err.message : String(err), true)
    }
  }
}

/** Shared by the button click and the `?url=` deep-link auto-load — same
 * validation either way, just a different trigger. */
function loadFromUrl(rawUrl: string): void {
  const session = getStoredSession()
  if (!session) {
    setStatus('Sign in first.', true)
    return
  }
  const trimmed = rawUrl.trim()
  const model = parseVersionUrl(trimmed)
  if (!model) {
    setStatus('Paste a .../projects/<id>/models/<id> (optionally @<versionId>) URL', true)
    return
  }
  if (model.origin !== session.origin) {
    setStatus(`Signed in to ${session.origin}, but this URL is on ${model.origin} — sign in against that server instead.`, true)
    return
  }
  setBookmarkableUrl(trimmed)
  viewInSpeckleLink.href = trimmed
  viewInSpeckleLink.hidden = false
  void performLoad(model, session.token)
}

loadButton.addEventListener('click', () => loadFromUrl(urlInput.value))

installDevModeApi({
  resolveAndAttach,
  getLastResult: () => (lastSchema && lastTree ? { schema: lastSchema, root: lastTree } : null),
  getLegacyRoot: () => lastLegacyRoot,
  resolveLegacyObject,
  getStatusText: () => status.textContent ?? ''
})

/**
 * `?url=` deep-linking. The query param only exists on the ORIGINAL
 * navigation — signing in (if needed) replaces it with `?access_code=` on
 * the way back — so it's parked in sessionStorage the moment it's seen and
 * consumed from there afterward, the same survive-a-redirect pattern
 * `auth.ts` uses for the PKCE verifier.
 */
const DEEP_LINK_STORAGE_KEY = 'speckle-dev-mode:pending-url'

function stashDeepLinkParam(): void {
  const url = new URLSearchParams(window.location.search).get('url')
  if (!url) return
  history.replaceState(null, '', window.location.pathname)
  sessionStorage.setItem(DEEP_LINK_STORAGE_KEY, url)
}

async function init(): Promise<void> {
  stashDeepLinkParam()
  try {
    const token = await completePendingLogin()
    if (token) setStatus('signed in.')
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true)
  }
  renderAuthState()

  const pendingUrl = sessionStorage.getItem(DEEP_LINK_STORAGE_KEY)
  if (pendingUrl) {
    urlInput.value = pendingUrl
    if (getStoredSession()) {
      sessionStorage.removeItem(DEEP_LINK_STORAGE_KEY)
      loadFromUrl(pendingUrl)
    }
    // Not signed in yet: leave it in sessionStorage and pre-filled in the
    // field — it'll auto-load the moment sign-in completes and this
    // function runs again after the redirect back.
  }
}

void init()
