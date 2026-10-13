import {
  parseVersionUrl,
  resolveVersionInfo,
  fetchArtifacts,
  downloadQueryableFiles,
  openSsoReauth,
  SsoSessionExpiredError,
  type ModelRef,
  type VersionRef,
  type VersionFormat
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

const status = document.createElement('div')
status.className = 'status'
app.appendChild(status)

const statusAction = document.createElement('div')
statusAction.className = 'status-action'
app.appendChild(statusAction)

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
 * offer the re-auth tab and a retry rather than just an error string. */
function setSsoExpiredStatus(
  err: SsoSessionExpiredError,
  ref: VersionRef,
  token: string,
  format: VersionFormat
): void {
  status.textContent = `${err.message}. Re-authenticate, then retry.`
  status.classList.add('error')
  statusAction.innerHTML = ''

  const reauthButton = document.createElement('button')
  reauthButton.textContent = `sign in to ${err.workspaceSlug} SSO`
  reauthButton.addEventListener('click', () => openSsoReauth(ref.origin, err.workspaceSlug))
  statusAction.appendChild(reauthButton)

  const retryButton = document.createElement('button')
  retryButton.textContent = 'retry'
  retryButton.addEventListener('click', () => {
    attach(ref, token, format).catch(() => {})
  })
  statusAction.appendChild(retryButton)
}

let lastSchema: string | null = null
let lastTree: ContainerNode | null = null
let lastLegacyRef: LegacyRef | null = null
let lastLegacyRoot: LegacyObject | null = null

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
 * handler, or `window.speckleDevMode`) can also tell success from failure. */
async function attach(
  ref: VersionRef,
  token: string,
  format: VersionFormat
): Promise<{ schema: string; format: VersionFormat; root: ContainerNode }> {
  loadButton.disabled = true
  treeMount.innerHTML = ''
  try {
    const result = await attachCore(ref, token, (text) => setStatus(text))
    renderTree(result.root, result.schema, treeMount)
    setStatus(`loaded ${result.schema} (${format}) — ${result.root.totalObjectCount} objects`)
    return { ...result, format }
  } catch (err) {
    if (err instanceof SsoSessionExpiredError) {
      setSsoExpiredStatus(err, ref, token, format)
    } else {
      setStatus(err instanceof Error ? err.message : String(err), true)
    }
    throw err
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
  reason: string
): Promise<void> {
  setStatus(`${reason} — loading legacy object graph…`)
  const root = await fetchLegacyObject(legacyRef, objectId, token)
  lastLegacyRef = legacyRef
  lastLegacyRoot = root
  renderLegacyTree(root, legacyRef, token, treeMount)
  setStatus(`${reason} — showing legacy object graph (${root.totalChildrenCount} total children)`)
}

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
 * and attaches it. Falls back to the legacy object graph when there's
 * nothing bundle-shaped to mount — either the version never had a bundle or
 * packfile at all (`format === 'json'`), or it mounted with zero objects
 * (a bundle exists, but the source data had nothing geometry-shaped in it).
 */
async function resolveAndAttach(
  model: ModelRef,
  token: string
): Promise<{ schema: string | null; format: VersionFormat; root: ContainerNode | null }> {
  setStatus('resolving version…')
  const info = await resolveVersionInfo(model, model.versionId, token)
  const legacyRef: LegacyRef = { origin: model.origin, projectId: model.projectId }

  if (info.format === 'json') {
    if (!info.referencedObject) {
      setStatus('This version has no bundle, packfile, or referencedObject at all — nothing to show.', true)
      return { schema: null, format: info.format, root: null }
    }
    await showLegacyGraph(
      legacyRef,
      info.referencedObject,
      token,
      'No bundle or packfile for this version'
    )
    return { schema: null, format: info.format, root: null }
  }

  const ref: VersionRef = { ...model, versionId: info.versionId }
  const result = await attach(ref, token, info.format)
  if (result.root.totalObjectCount === 0 && info.referencedObject) {
    await showLegacyGraph(
      legacyRef,
      info.referencedObject,
      token,
      `${result.schema} (${info.format}) mounted with 0 objects`
    )
  }
  return result
}

loadButton.addEventListener('click', () => {
  const session = getStoredSession()
  if (!session) {
    setStatus('Sign in first.', true)
    return
  }
  const model = parseVersionUrl(urlInput.value.trim())
  if (!model) {
    setStatus('Paste a .../projects/<id>/models/<id> (optionally @<versionId>) URL', true)
    return
  }
  if (model.origin !== session.origin) {
    setStatus(`Signed in to ${session.origin}, but this URL is on ${model.origin} — sign in against that server instead.`, true)
    return
  }
  resolveAndAttach(model, session.token).catch((err) => {
    setStatus(err instanceof Error ? err.message : String(err), true)
  })
})

installDevModeApi({
  resolveAndAttach,
  getLastResult: () => (lastSchema && lastTree ? { schema: lastSchema, root: lastTree } : null),
  getLegacyRoot: () => lastLegacyRoot,
  resolveLegacyObject,
  getStatusText: () => status.textContent ?? ''
})

async function init(): Promise<void> {
  try {
    const token = await completePendingLogin()
    if (token) setStatus('signed in.')
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true)
  }
  renderAuthState()
}

void init()
