import { runSql } from './duckdb'
import { REL_IN_COLLECTION, REL_IN_MODEL } from './bundleSchema'

export interface ContainerNode {
  kind: 'container'
  id: number
  name: string
  subtype: string | null
  children: TreeNode[]
  /** Objects directly in this container, descendants not included. */
  directObjectCount: number
  /** This container's objects plus every descendant container's. */
  totalObjectCount: number
}

export interface ObjectNode {
  kind: 'object'
  objectIndex: number
  applicationId: string
  propertyCount: number
}

export type TreeNode = ContainerNode | ObjectNode

async function queryAll(schema: string, sql: string): Promise<Record<string, unknown>[]> {
  const result = await runSql(sql.replace(/\$schema/g, `"${schema}"`))
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < result.numRows; i++) {
    const row = result.get(i)
    if (row) rows.push(row)
  }
  return rows
}

export async function buildTree(schema: string): Promise<ContainerNode> {
  const containerRows = await queryAll(
    schema,
    `SELECT id, name, subtype, def_ref FROM $schema."nodes" WHERE kind = 7`
  )
  const objectRows = await queryAll(
    schema,
    `SELECT object_index, application_id FROM $schema."objects"`
  )
  const propCountRows = await queryAll(
    schema,
    `SELECT object_index, count(*) AS n FROM $schema."object_properties" ` +
      `WHERE path_index >= 0 GROUP BY object_index`
  )
  const membershipRows = await queryAll(
    schema,
    `SELECT DISTINCT src, dst FROM $schema."relations" WHERE rel IN (${REL_IN_COLLECTION}, ${REL_IN_MODEL})`
  )

  const propCountByObject = new Map<number, number>()
  for (const r of propCountRows) {
    propCountByObject.set(Number(r.object_index), Number(r.n))
  }

  const objectByIndex = new Map<number, ObjectNode>()
  for (const r of objectRows) {
    const objectIndex = Number(r.object_index)
    objectByIndex.set(objectIndex, {
      kind: 'object',
      objectIndex,
      applicationId: String(r.application_id),
      propertyCount: propCountByObject.get(objectIndex) ?? 0
    })
  }

  const containers = new Map<number, ContainerNode>()
  const parentOf = new Map<number, number | null>()
  for (const r of containerRows) {
    const id = Number(r.id)
    containers.set(id, {
      kind: 'container',
      id,
      name: (r.name as string | null) ?? '(unnamed)',
      subtype: r.subtype as string | null,
      children: [],
      directObjectCount: 0,
      totalObjectCount: 0
    })
    parentOf.set(id, r.def_ref === null || r.def_ref === undefined ? null : Number(r.def_ref))
  }

  for (const [id, container] of containers) {
    const parentId = parentOf.get(id)
    if (parentId !== null && parentId !== undefined && containers.has(parentId)) {
      containers.get(parentId)!.children.push(container)
    }
  }

  const claimed = new Set<number>()
  for (const r of membershipRows) {
    const containerId = Number(r.dst)
    const objectIndex = Number(r.src)
    const container = containers.get(containerId)
    const object = objectByIndex.get(objectIndex)
    if (container && object) {
      container.children.push(object)
      container.directObjectCount += 1
      claimed.add(objectIndex)
    }
  }

  // Not every bundle has a scene hierarchy — custom data objects (e.g. a
  // pydantic payload sent straight from a backend, no CAD connector) can
  // carry properties with zero containers and zero membership relations.
  // A virtual root holds the real top-level containers (if any) plus every
  // object no container claimed, so the tree always shows the full object
  // set rather than failing when there's nothing to nest it under.
  const root: ContainerNode = {
    kind: 'container',
    id: -1,
    name: '(root)',
    subtype: null,
    children: [],
    directObjectCount: 0,
    totalObjectCount: 0
  }
  const modelContainer = Array.from(containers.values()).find((c) => c.subtype === 'Model')
  if (modelContainer) {
    root.children.push(modelContainer)
  } else {
    for (const [id, container] of containers) {
      const parentId = parentOf.get(id)
      if (parentId === null || parentId === undefined || !containers.has(parentId)) {
        root.children.push(container)
      }
    }
  }
  for (const [objectIndex, object] of objectByIndex) {
    if (!claimed.has(objectIndex)) {
      root.children.push(object)
      root.directObjectCount += 1
    }
  }

  const countTotals = (node: ContainerNode): number => {
    let total = node.directObjectCount
    for (const child of node.children) {
      if (child.kind === 'container') total += countTotals(child)
    }
    node.totalObjectCount = total
    return total
  }
  countTotals(root)
  return root
}

export interface ObjectProperty {
  path: string
  value: string | number | boolean | null
  unit: string | null
}

export async function getObjectProperties(
  schema: string,
  objectIndex: number
): Promise<ObjectProperty[]> {
  const rows = await queryAll(
    schema,
    `SELECT pa.path AS path, op.value_string, op.value_double, op.value_boolean, op.unit ` +
      `FROM $schema."object_properties" op ` +
      `JOIN $schema."paths" pa ON pa.path_index = op.path_index ` +
      `WHERE op.object_index = ${objectIndex} ORDER BY pa.path`
  )
  return rows.map((r) => ({
    path: String(r.path),
    value:
      (r.value_string as string | null) ??
      (r.value_double as number | null) ??
      (r.value_boolean as boolean | null) ??
      null,
    unit: (r.unit as string | null) ?? null
  }))
}
