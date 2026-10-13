/**
 * `window.speckleDevMode` — the same pattern as Bashboards' browser API
 * (anthropic-skills:bash-ai): the live kiosk tab's own functions, exposed on
 * `window` so an agent can call them directly via JS eval instead of
 * simulating clicks and pasted text. Drives the SAME visible UI (the tree
 * still renders, status bar still updates) — this isn't a second headless
 * copy of the app.
 */
import { parseVersionUrl, type ModelRef, type VersionFormat } from './speckleApi'
import { startLogin, clearStoredSession, getStoredSession } from './auth'
import { getObjectProperties, type ContainerNode, type ObjectProperty } from './tree'
import { runSql } from './duckdb'
import type { LegacyObject } from './legacyGraph'

export interface AttachResult {
  format: VersionFormat
  /** `null` when `format` is `'json'` — a plain legacy object graph has nothing queryable to mount. */
  schema: string | null
  tree: ContainerNode | null
}

export interface SpeckleDevModeApi {
  /** `{ origin }` if signed in, else `null`. */
  getSession(): { origin: string } | null
  /** Redirects the tab to the Speckle consent page; doesn't resolve (navigation interrupts it). */
  signIn(origin?: string): void
  signOut(): void
  /** A `.../projects/<id>/models/<id>[@<versionId>]` URL. Resolves latest version when omitted. */
  attach(url: string): Promise<AttachResult>
  /** The last-attached tree, or `null` before any attach. */
  getTree(): ContainerNode | null
  getSchema(): string | null
  getObjectProperties(objectIndex: number): Promise<ObjectProperty[]>
  /** Current status-bar text, for polling a long attach without re-reading the DOM. */
  getStatus(): string
  /** Raw SQL against the last-attached schema's DuckDB views, for ad hoc
   * investigation — e.g. `query('SELECT count(*) AS n FROM "${schema}"."objects"')`.
   * Use `getSchema()` to get the schema name to qualify table refs with. */
  query(sql: string): Promise<Record<string, unknown>[]>
  /**
   * The legacy-graph root `attach()` fell back to (no bundle/packfile had
   * anything queryable), or `null` if the last attach was bundle-backed.
   * `tree`/`getTree()` only ever reflect the bundle side — this is the
   * separate accessor for the legacy side.
   */
  getLegacyRoot(): LegacyObject | null
  /**
   * The programmatic equivalent of clicking a `{referencedId,
   * speckle_type: "reference"}` row open: fetches that object directly, no
   * DOM interaction. Walk the whole legacy graph by reading `data` for more
   * reference stubs and calling this again on each `referencedId`.
   */
  resolveLegacyObject(objectId: string): Promise<LegacyObject>
}

export interface DevModeApiDeps {
  resolveAndAttach(
    model: ModelRef,
    token: string
  ): Promise<{ schema: string | null; format: VersionFormat; root: ContainerNode | null }>
  getLastResult(): { schema: string; root: ContainerNode } | null
  getLegacyRoot(): LegacyObject | null
  resolveLegacyObject(objectId: string): Promise<LegacyObject>
  getStatusText(): string
}

export function installDevModeApi(deps: DevModeApiDeps): void {
  const api: SpeckleDevModeApi = {
    getSession() {
      const session = getStoredSession()
      return session ? { origin: session.origin } : null
    },
    signIn(origin) {
      void startLogin(origin ?? 'https://app.speckle.systems')
    },
    signOut() {
      clearStoredSession()
    },
    async attach(url) {
      const session = getStoredSession()
      if (!session) throw new Error('Not signed in — call speckleDevMode.signIn() first.')
      const model = parseVersionUrl(url)
      if (!model) throw new Error(`Could not parse a project/model URL from: ${url}`)
      if (model.origin !== session.origin) {
        throw new Error(
          `Signed in to ${session.origin}, but this URL is on ${model.origin} — sign in against that server instead.`
        )
      }
      const { schema, format, root } = await deps.resolveAndAttach(model, session.token)
      return { schema, format, tree: root }
    },
    getTree() {
      return deps.getLastResult()?.root ?? null
    },
    getSchema() {
      return deps.getLastResult()?.schema ?? null
    },
    getObjectProperties(objectIndex) {
      const schema = deps.getLastResult()?.schema
      if (!schema) throw new Error('No bundle attached yet — call speckleDevMode.attach(url) first.')
      return getObjectProperties(schema, objectIndex)
    },
    getStatus() {
      return deps.getStatusText()
    },
    async query(sql) {
      const result = await runSql(sql)
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < result.numRows; i++) {
        const row = result.get(i)
        if (row) rows.push(row)
      }
      return rows
    },
    getLegacyRoot() {
      return deps.getLegacyRoot()
    },
    resolveLegacyObject(objectId) {
      return deps.resolveLegacyObject(objectId)
    }
  }
  ;(window as unknown as { speckleDevMode: SpeckleDevModeApi }).speckleDevMode = api
}
