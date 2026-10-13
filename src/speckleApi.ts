import { buildArtifactsUrl, GEOMETRY_SHARD_RE, type ArtifactFile } from './bundleSchema'

export interface VersionRef {
  origin: string
  projectId: string
  modelId: string
  versionId: string
}

export interface ModelRef {
  origin: string
  projectId: string
  modelId: string
  /** Absent when the URL names a model with no `@versionId` — resolve via {@link resolveLatestVersionId}. */
  versionId: string | null
}

/**
 * Accepts a frontend-3 model URL, with or without a version
 * (`https://host/projects/<p>/models/<m>` or `.../models/<m>@<v>`).
 */
export function parseVersionUrl(url: string): ModelRef | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/projects\/([^/]+)\/models\/([^/@]+)(?:@([^/]+))?/)
    if (!m) return null
    return { origin: u.origin, projectId: m[1], modelId: m[2], versionId: m[3] ?? null }
  } catch {
    return null
  }
}

/**
 * What's actually queryable for a version. Not every version has a bundle —
 * a hash-era `referencedObject` with no `objectKey` and no `schemaVersion`
 * has no queryable artifact at all (a plain legacy JSON object graph; the
 * big-truck migration hasn't reached it, may never, or the data was never
 * geometry-shaped to begin with). `objectKey` non-null means a legacy
 * packfile's own EAV artifact; `schemaVersion === 3` means the native v2
 * bundle. Mirrors `hasQueryableData`/`schemaVersion` in
 * `speckle-server-internal/packages/ts-sdk/src/assets/versionResolver.ts`.
 */
export type VersionFormat = 'bundle' | 'packfile' | 'json'

export interface VersionInfo {
  versionId: string
  format: VersionFormat
  referencedObject: string | null
}

const BUNDLE_REFERENCE_PREFIX = 'bundle.'

/**
 * `Version.referencedObject` isn't always a legacy content hash — a version
 * created directly as a bundle (never had a legacy graph to begin with) gets
 * a synthetic `bundle.<projectId>.<modelId>.<versionId>` marker planted at
 * creation instead, so the non-nullable legacy field still has *something*.
 * Sending one of these to the legacy object endpoints always 404s; dispatch
 * on the prefix only, never parse the embedded triple (it goes stale if the
 * version is later moved to another model). Server-owned contract:
 * `speckle-server-internal/packages/server/modules/data/docs/bundle-reference.md`.
 */
export function isBundleReference(referencedObject: string | null): boolean {
  return referencedObject !== null && referencedObject.startsWith(BUNDLE_REFERENCE_PREFIX)
}

/** The real legacy referencedObject to fetch, or `null` when there isn't one
 * — either the field itself is null, or it's a {@link isBundleReference}
 * marker rather than a content hash. */
export function legacyObjectIdFrom(info: Pick<VersionInfo, 'referencedObject'>): string | null {
  return info.referencedObject !== null && !isBundleReference(info.referencedObject)
    ? info.referencedObject
    : null
}

interface GqlVersionFields {
  id: string
  referencedObject: string | null
  objectKey: string | null
  schemaVersion: number | null
}

function classifyFormat(objectKey: string | null, schemaVersion: number | null): VersionFormat {
  if (schemaVersion === 3) return 'bundle'
  if (objectKey !== null) return 'packfile'
  return 'json'
}

const VERSION_FIELDS_QUERY_FRAGMENT = `id referencedObject objectKey schemaVersion`

/**
 * Resolves a model's version — the latest one when `versionId` is omitted —
 * and classifies its format. Query shape mirrors
 * `speckle-server-internal/packages/ts-sdk/src/assets/versionResolver.ts`'s
 * `resolveLatestVersion` / `resolveSpecificVersion`.
 */
export async function resolveVersionInfo(
  ref: Pick<ModelRef, 'origin' | 'projectId' | 'modelId'>,
  versionId: string | null,
  token: string
): Promise<VersionInfo> {
  const query = versionId
    ? `query DevModeResolveVersion($projectId: String!, $modelId: String!, $versionId: String!) {
        project(id: $projectId) {
          model(id: $modelId) {
            version(id: $versionId) { ${VERSION_FIELDS_QUERY_FRAGMENT} }
          }
        }
      }`
    : `query DevModeResolveLatest($projectId: String!, $modelId: String!) {
        project(id: $projectId) {
          model(id: $modelId) {
            versions(limit: 1) {
              items { ${VERSION_FIELDS_QUERY_FRAGMENT} }
            }
          }
        }
      }`

  const resp = await fetch(`${ref.origin}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query,
      variables: { projectId: ref.projectId, modelId: ref.modelId, versionId: versionId ?? undefined }
    })
  })
  if (!resp.ok) await throwForErrorResponse(resp)
  const body = (await resp.json()) as {
    data?: {
      project?: {
        model?:
          | { version?: GqlVersionFields | null; versions?: { items?: GqlVersionFields[] } }
          | null
      } | null
    }
    errors?: { message: string }[]
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join(', ')}`)
  }
  const model = body.data?.project?.model
  const version = versionId ? model?.version : model?.versions?.items?.[0]
  if (!version) {
    throw new Error(
      versionId
        ? `Version ${versionId} not found for model ${ref.modelId} in project ${ref.projectId}`
        : `No versions found for model ${ref.modelId} in project ${ref.projectId}`
    )
  }
  return {
    versionId: version.id,
    format: classifyFormat(version.objectKey, version.schemaVersion),
    referencedObject: version.referencedObject
  }
}

/**
 * Thrown for the server's `SSO_SESSION_MISSING_OR_EXPIRED_ERROR` (401,
 * `packages/server/modules/workspacesCore/errors/index.ts`): the workspace's
 * SSO session timed out (7-day default) while the bearer token is still
 * otherwise valid. Re-authenticating at `{origin}/api/v1/workspaces/{slug}/sso/auth`
 * refreshes the session server-side; the existing token then works again
 * without needing to be reissued.
 */
export class SsoSessionExpiredError extends Error {
  constructor(
    public readonly workspaceSlug: string,
    public readonly errorType: 'expired' | 'notFound'
  ) {
    super(`Workspace "${workspaceSlug}" SSO session ${errorType === 'notFound' ? 'was not found' : 'has expired'}`)
    this.name = 'SsoSessionExpiredError'
  }
}

interface ServerErrorBody {
  error?: {
    code?: string
    message?: string
    info?: { workspaceSlug?: string; errorType?: 'expired' | 'notFound' }
  }
}

async function throwForErrorResponse(resp: Response): Promise<never> {
  let body: ServerErrorBody | null = null
  try {
    body = (await resp.json()) as ServerErrorBody
  } catch {
    /* non-JSON error body */
  }
  const info = body?.error?.info
  if (resp.status === 401 && body?.error?.code === 'SSO_SESSION_MISSING_OR_EXPIRED_ERROR' && info?.workspaceSlug) {
    throw new SsoSessionExpiredError(info.workspaceSlug, info.errorType ?? 'expired')
  }
  throw new Error(
    `request failed: ${resp.status} ${resp.statusText}${body?.error?.message ? ` — ${body.error.message}` : ''}`
  )
}

export async function fetchArtifacts(
  ref: VersionRef,
  token: string
): Promise<ArtifactFile[]> {
  const url = buildArtifactsUrl(ref.origin, ref.projectId, ref.modelId, ref.versionId)
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) await throwForErrorResponse(resp)
  const body = (await resp.json()) as { files: ArtifactFile[] }
  if (!body.files?.length) throw new Error('artifacts response has no files')
  return body.files
}

/** Opens the workspace's SSO login in a new tab; completing it refreshes the
 * session server-side, so the kiosk's existing token works again on retry. */
export function openSsoReauth(origin: string, workspaceSlug: string): void {
  window.open(`${origin}/api/v1/workspaces/${workspaceSlug}/sso/auth`, '_blank')
}

/** Downloads every non-geometry artifact file as raw bytes, keyed by filename. */
export async function downloadQueryableFiles(
  files: ArtifactFile[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, Uint8Array>> {
  const queryable = files.filter((f) => !GEOMETRY_SHARD_RE.test(f.name))
  const out = new Map<string, Uint8Array>()
  let done = 0
  for (const f of queryable) {
    const resp = await fetch(f.url)
    if (!resp.ok) throw new Error(`failed to download ${f.name}: ${resp.status}`)
    out.set(f.name, new Uint8Array(await resp.arrayBuffer()))
    done += 1
    onProgress?.(done, queryable.length)
  }
  return out
}
