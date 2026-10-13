/**
 * View-SQL mirror of speckle-server-internal/packages/ts-sdk/src/data/bundleAttach.ts
 * and src/data/bundleQueries.ts (containerWhere, REL_IN_COLLECTION, REL_IN_MODEL).
 * Kept byte-compatible with that module's statements; re-check against it if a
 * query here returns an unexpected shape.
 */

export interface ArtifactFile {
  name: string
  url: string
}

export const GEOMETRY_SHARD_RE = /\.geometries(?:\.\d+)?\.parquet$/

export function viewNameOf(name: string): string | null {
  const m = name.match(/\.(?:eav|envelope)\.(.+)\.parquet$/)
  return m ? m[1] : null
}

export function toBundleSchema(versionId: string): string {
  return `bundle_${versionId}`
}

export function buildArtifactsUrl(
  origin: string,
  projectId: string,
  modelId: string,
  versionId: string
): string {
  return `${origin}/api/v2/projects/${projectId}/models/${modelId}/versions/${versionId}/artifacts`
}

export interface BundleViewFile {
  view: string
  /** The name the parquet bytes are registered under in DuckDB-WASM's virtual FS. */
  registeredName: string
  file: ArtifactFile
}

export function bundleViewFiles(files: ArtifactFile[]): BundleViewFile[] {
  return files
    .filter((f) => !GEOMETRY_SHARD_RE.test(f.name))
    .map((f) => ({ view: viewNameOf(f.name), registeredName: f.name, file: f }))
    .filter((v): v is BundleViewFile => Boolean(v.view))
}

export function bundleViewSql(schema: string, view: string, registeredName: string): string {
  return (
    `CREATE OR REPLACE VIEW "${schema}"."${view}" AS ` +
    `SELECT * FROM read_parquet('${registeredName.replace(/'/g, "''")}')`
  )
}

const PATHS_RAW_VIEW = 'paths_raw'
const APPLICATION_ID_PATH = 'applicationId'
const APPLICATION_ID_PATH_INDEX = -1

function renameRawPathsView(views: BundleViewFile[]): BundleViewFile[] {
  return views.map((v) => (v.view === 'paths' ? { ...v, view: PATHS_RAW_VIEW } : v))
}

function pathsViewSql(schema: string): string {
  const s = schema
  return (
    `CREATE OR REPLACE VIEW "${s}"."paths" AS ` +
    `SELECT path_index, path FROM "${s}"."${PATHS_RAW_VIEW}" ` +
    `UNION ALL ` +
    `SELECT ${APPLICATION_ID_PATH_INDEX} AS path_index, '${APPLICATION_ID_PATH}' AS path ` +
    `WHERE NOT EXISTS (SELECT 1 FROM "${s}"."${PATHS_RAW_VIEW}" WHERE path = '${APPLICATION_ID_PATH}')`
  )
}

function objectPropertiesViewSql(schema: string): string {
  const s = schema
  const cols =
    'object_index, path_index, value_string, value_double, value_boolean, unit, internal_definition_name'
  return (
    `CREATE OR REPLACE VIEW "${s}"."object_properties" AS ` +
    `SELECT ${cols} FROM "${s}"."eav" ` +
    `UNION ALL ` +
    `SELECT ot.object_index, te.path_index, te.value_string, te.value_double, ` +
    `te.value_boolean, te.unit, te.internal_definition_name ` +
    `FROM "${s}"."object_type" ot JOIN "${s}"."type_eav" te ON te.type_index = ot.type_index ` +
    `UNION ALL ` +
    `SELECT o.object_index, ${APPLICATION_ID_PATH_INDEX}, o.application_id, NULL, NULL, NULL, NULL ` +
    `FROM "${s}"."objects" o WHERE NOT EXISTS (SELECT 1 FROM "${s}"."paths" ` +
    `WHERE path = '${APPLICATION_ID_PATH}' AND path_index >= 0)`
  )
}

/** The full DDL to mount a bundle's registered parquet buffers under `schema`. */
export function bundleMountSql(schema: string, files: ArtifactFile[]): string[] {
  const views = renameRawPathsView(bundleViewFiles(files))
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    ...views.map((v) => bundleViewSql(schema, v.view, v.registeredName)),
    pathsViewSql(schema),
    objectPropertiesViewSql(schema)
  ]
}

export const REL_IN_COLLECTION = 10
export const REL_IN_MODEL = 11

/** Both container dimensions live in kind-7 CONTAINER nodes told apart by `subtype`. */
export function containerWhere(kind: 'collection' | 'model'): string {
  return kind === 'model'
    ? `kind = 7 AND subtype = 'Model'`
    : `kind = 7 AND COALESCE(subtype, '') NOT IN ('Model', 'Network', 'MEP System')`
}
