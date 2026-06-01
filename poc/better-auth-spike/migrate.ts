// Apply the generated DDL to a fresh SQLite DB using bun:sqlite (zero native
// addon). Spike equivalent of `drizzle-kit push` / `better-auth migrate`.
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { DB_FILE } from "./db";

for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  if (existsSync(f)) rmSync(f);
}

const sql = readFileSync("./spike-ddl.sql", "utf8");
const dbm = new Database(DB_FILE);
dbm.exec(sql);

const rows = dbm
  .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];
console.log("Created tables:", rows.map((r) => r.name).join(", "));
dbm.close();
console.log("Migration complete ->", DB_FILE);
