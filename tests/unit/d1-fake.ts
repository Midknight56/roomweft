// A small D1 stand-in for unit tests, on Node's built-in SQLite. It covers the surface the app uses:
// prepare().bind().first/all/run, batch and exec. Migrations are applied from the files in migrations/.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>

class FakeStatement {
  constructor(private db: FakeD1, private sql: string, private values: unknown[] = []) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values)
  }

  private params(): (string | number | bigint | null | Uint8Array)[] {
    return this.values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as never
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    this.db.check()
    const row = this.db.sqlite.prepare(this.sql).get(...this.params()) as Row | undefined
    if (!row) return null
    const plain = { ...row }
    return (column ? (plain[column] as T) : (plain as T)) ?? null
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    this.db.check()
    const rows = this.db.sqlite.prepare(this.sql).all(...this.params()) as Row[]
    return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: { changes: 0 } }
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    this.db.check()
    const stmt = this.db.sqlite.prepare(this.sql)
    if (/\breturning\b/i.test(this.sql)) {
      const rows = stmt.all(...this.params())
      return { success: true, meta: { changes: rows.length, last_row_id: 0 } }
    }
    const info = stmt.run(...this.params())
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.db.check()
    const rows = this.db.sqlite.prepare(this.sql).all(...this.params()) as Row[]
    return rows.map((r) => Object.values(r) as T)
  }
}

export class FakeD1 {
  sqlite = new DatabaseSync(':memory:')
  /** Set to make every next call throw, to test fail closed paths. */
  broken = false

  check(): void {
    if (this.broken) throw new Error('D1 is down (test)')
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.check()
    this.sqlite.exec('BEGIN')
    try {
      const out = []
      for (const s of statements) out.push(await s.run())
      this.sqlite.exec('COMMIT')
      return out
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  async exec(sql: string): Promise<void> {
    this.check()
    this.sqlite.exec(sql)
  }
}

/** A fresh database with every migration in migrations/ applied in name order. */
export function freshD1(extraSql = ''): FakeD1 {
  const db = new FakeD1()
  const dir = join(process.cwd(), 'migrations')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    files = []
  }
  for (const f of files) db.sqlite.exec(readFileSync(join(dir, f), 'utf8'))
  if (extraSql) db.sqlite.exec(extraSql)
  return db
}

/** The shared hackathon ledger's table, as it is in the real database. */
export const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, day TEXT NOT NULL, neurons REAL NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')));`

export function asD1(db: FakeD1): D1Database {
  return db as unknown as D1Database
}
