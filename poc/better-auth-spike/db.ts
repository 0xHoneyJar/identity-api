// Drizzle + bun:sqlite DB handle. Zero-infra: SQLite file on disk, NO native
// addon compile (bun:sqlite is built into the bun runtime).
//
// FRICTION NOTE: better-sqlite3's native binding fails to dlopen under bun 1.3.13
// (bun issue #4290 — ERR_DLOPEN_FAILED). It works fine under node v23. We use
// bun's built-in `bun:sqlite` via drizzle's `bun-sqlite` driver instead — same
// Drizzle adapter, different SQLite engine, still zero-infra.
//
// Postgres swap: replace these two imports + handle with
//   import { drizzle } from "drizzle-orm/node-postgres"; import { Pool } from "pg";
//   export const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema });
// and flip the adapter `provider` "sqlite" -> "pg" in auth.ts. Nothing else changes.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export const DB_FILE = "./spike.db";

export const sqlite = new Database(DB_FILE);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });
