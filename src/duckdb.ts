import * as duckdb from '@duckdb/duckdb-wasm'

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null

async function instantiate(): Promise<duckdb.AsyncDuckDB> {
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
  )
  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  return db
}

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = instantiate()
  return dbPromise
}

export interface QueryResult {
  numRows: number
  get(i: number): Record<string, unknown> | null
}

export async function registerParquetBuffer(name: string, bytes: Uint8Array): Promise<void> {
  const db = await getDb()
  await db.registerFileBuffer(name, bytes)
}

export async function runSql(sql: string): Promise<QueryResult> {
  const db = await getDb()
  const conn = await db.connect()
  try {
    const table = await conn.query(sql)
    const rows = table.toArray().map((row) => row.toJSON() as Record<string, unknown>)
    return {
      numRows: rows.length,
      get: (i: number) => rows[i] ?? null
    }
  } finally {
    await conn.close()
  }
}

export async function runSqlBatch(statements: string[]): Promise<void> {
  const db = await getDb()
  const conn = await db.connect()
  try {
    for (const stmt of statements) {
      await conn.query(stmt)
    }
  } finally {
    await conn.close()
  }
}
