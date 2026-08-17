import { createRequire } from "node:module"
import { homedir } from "os"
import { join, isAbsolute } from "path"

type Statement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

type Database = {
  query(sql: string): Statement
}

export type SessionRow = {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  directory: string
  time_created: number
  time_updated: number
}

export type ProjectRow = {
  id: string
  worktree: string
  name: string | null
}

export type PartRow = {
  message_id: string
  data: string
}

export type MessageRow = {
  id: string
  time_created: number
  data: string
}

function xdgDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim()) return xdg
  return join(homedir(), ".local", "share")
}

export function resolveDbPath(): string {
  const flag = process.env.OPENCODE_DB
  const dataDir = join(xdgDataHome(), "opencode")
  if (flag && flag.trim()) {
    if (flag === ":memory:" || isAbsolute(flag)) return flag
    return join(dataDir, flag)
  }
  return join(dataDir, "opencode.db")
}

let cached: Database | null = null

function createDatabase(path: string): Database {
  const require = createRequire(import.meta.url)
  if ("bun" in process.versions) {
    const { Database } = require("bun:sqlite")
    return new Database(path, { readonly: true })
  }

  const { DatabaseSync } = require("node:sqlite")
  const database = new DatabaseSync(path, { readOnly: true })
  return {
    query(sql) {
      return database.prepare(sql)
    },
  }
}

export function openDb(): Database {
  if (cached) return cached
  const db = createDatabase(resolveDbPath())
  cached = db
  return db
}

export function getProjectForDirectory(db: Database, directory: string): ProjectRow | null {
  const direct = db
    .query("SELECT id, worktree, name FROM project WHERE worktree = ? LIMIT 1")
    .get(directory) as ProjectRow | undefined
  if (direct) return direct

  const sessionProject = db
    .query(
      "SELECT p.id, p.worktree, p.name FROM session s JOIN project p ON p.id = s.project_id WHERE s.directory = ? ORDER BY s.time_updated DESC LIMIT 1",
    )
    .get(directory) as ProjectRow | undefined
  return sessionProject ?? null
}

export function listSessions(
  db: Database,
  opts: { projectId?: string; limit: number; includeChildren: boolean },
): (SessionRow & { project_name: string | null; project_worktree: string })[] {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (opts.projectId) {
    conditions.push("s.project_id = ?")
    params.push(opts.projectId)
  }
  if (!opts.includeChildren) {
    conditions.push("s.parent_id IS NULL")
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  params.push(opts.limit)

  return db
    .query(
      `SELECT s.id, s.project_id, s.parent_id, s.title, s.directory, s.time_created, s.time_updated,
              p.name AS project_name, p.worktree AS project_worktree
       FROM session s
       JOIN project p ON p.id = s.project_id
       ${where}
       ORDER BY s.time_updated DESC
       LIMIT ?`,
    )
    .all(...params) as (SessionRow & { project_name: string | null; project_worktree: string })[]
}

export function getSession(db: Database, sessionId: string): SessionRow | null {
  return (
    (db
      .query(
        "SELECT id, project_id, parent_id, title, directory, time_created, time_updated FROM session WHERE id = ? LIMIT 1",
      )
      .get(sessionId) as SessionRow | undefined) ?? null
  )
}

export function getMessages(db: Database, sessionId: string): MessageRow[] {
  return db
    .query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as MessageRow[]
}

export function getParts(db: Database, sessionId: string): PartRow[] {
  return db
    .query(
      "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(sessionId) as PartRow[]
}
