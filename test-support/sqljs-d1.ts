/**
 * D1 over sql.js (MIT, pure WASM SQLite) for tests. Runs a worker's real schema file
 * so tests exercise the SQL the worker ships, not a hand-written fake.
 */

import { readFileSync } from 'node:fs';
import initSqlJs, { type Database } from 'sql.js';

function selectRows(db: Database, sql: string, args: unknown[]): Record<string, unknown>[] {
  const s = db.prepare(sql);
  s.bind(args as never);
  const out: Record<string, unknown>[] = [];
  while (s.step()) out.push(s.getAsObject() as Record<string, unknown>);
  s.free();
  return out;
}

class Stmt {
  private args: unknown[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = args.map(a => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
    return this;
  }
  async run() { this.db.run(this.sql, this.args as never); return { success: true }; }
  async first<T>() { return (selectRows(this.db, this.sql, this.args)[0] ?? null) as T | null; }
  async all<T>() { return { results: selectRows(this.db, this.sql, this.args) as T[] }; }
}

export async function makeD1(schemaPath: string) {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(readFileSync(schemaPath, 'utf8')); // no params -> sqlite3_exec, runs every statement
  const d1 = { prepare: (sql: string) => new Stmt(raw, sql) } as unknown as D1Database;
  const query = (sql: string, ...args: unknown[]) => selectRows(raw, sql, args);
  return { d1, raw, query };
}

