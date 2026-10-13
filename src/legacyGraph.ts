/**
 * Fallback for versions with nothing bundle-shaped to mount: Haskoning's data
 * is a generic `Base`-as-container payload (custom pydantic schemas, no
 * `elements`/`displayValue`/collection conventions), so the big-truck bundle
 * migrator correctly extracts zero rows — there's nothing geometry-shaped to
 * migrate. The real content only exists on the legacy graph, reached one
 * object at a time via GraphQL `project.object(id)` and its detached
 * `{referencedId, speckle_type: "reference"}` stubs — the same indirection
 * `@speckle/objectloader2` resolves lazily and specklepy's `operations.receive`
 * resolves eagerly (see the Dev Mode discussion this traces back to).
 */

import { throwForErrorResponse } from './speckleApi'

export interface LegacyRef {
  origin: string
  projectId: string
}

export interface LegacyObject {
  id: string
  totalChildrenCount: number
  data: Record<string, unknown>
}

interface GqlObjectBody {
  data?: { project?: { object?: LegacyObject | null } | null }
  errors?: { message: string }[]
}

export async function fetchLegacyObject(
  ref: LegacyRef,
  objectId: string,
  token: string
): Promise<LegacyObject> {
  const resp = await fetch(`${ref.origin}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: `query DevModeLegacyObject($projectId: String!, $objectId: String!) {
        project(id: $projectId) {
          object(id: $objectId) { id totalChildrenCount data }
        }
      }`,
      variables: { projectId: ref.projectId, objectId }
    })
  })
  if (!resp.ok) await throwForErrorResponse(resp)
  const body = (await resp.json()) as GqlObjectBody
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join(', ')}`)
  }
  const obj = body.data?.project?.object
  if (!obj) throw new Error(`Object ${objectId} not found in project ${ref.projectId}`)
  return obj
}

export function isReferenceStub(
  value: unknown
): value is { referencedId: string; speckle_type: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.referencedId === 'string' && v.speckle_type === 'reference'
}
