// Consistency checks between the documented setup, the SQL and the TypeScript code.
// They only read files: no database and no network are needed.
// Mitigations for risk R-01 (README setup misses a migration) and
// risk R-04 (booking rules duplicated in SQL and demoApi.ts).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKIN_OPENS_MS, FREE_CANCEL_MS } from "../../src/lib/format";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const sorted = (xs: Iterable<string>) => [...xs].sort();
const SQL_FILES = readdirSync(join(ROOT, "supabase")).filter((f) => f.endsWith(".sql")).map((f) => `supabase/${f}`);

/** SQL files that step 1 of "Connecting Supabase" in the README tells you to run. */
function readmeSetupFiles(): string[] {
  const readme = read("README.md");
  const start = readme.indexOf("### Connecting Supabase");
  const step1 = readme.slice(start, readme.indexOf("\n2. ", start));
  return [...step1.matchAll(/`(supabase\/[a-z_]+\.sql)`/g)].map((m) => m[1]);
}

/** Names of the functions a SQL file creates. */
const sqlFunctions = (sql: string) =>
  [...sql.matchAll(/create (?:or replace )?function public\.([a-z_]+)/gi)].map((m) => m[1]);

/** Database functions the app calls with rpc("..."). */
const calledRpcs = (...files: string[]) =>
  new Set(files.flatMap((f) => [...read(f).matchAll(/\brpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])));

/** Every definition of one SQL function in a file (a migration may redefine it). */
function sqlBodies(sql: string, fn: string): string[] {
  const bodies: string[] = [];
  for (const m of sql.matchAll(new RegExp(`create (?:or replace )?function public\\.${fn}\\b`, "gi"))) {
    const open = sql.indexOf("$$", m.index);
    bodies.push(sql.slice(m.index, sql.indexOf("$$;", open + 2)));
  }
  return bodies;
}

/** Result codes a SQL function returns: public.result(true|false, 'code', ...). */
const sqlCodes = (body: string) =>
  new Set([...body.matchAll(/public\.result\(\s*(?:true|false)\s*,\s*'([a-z_]+)'/g)].map((m) => m[1]));

/** Source of one demoApi method, from "async name(" to the next method. */
function demoMethod(name: string): string {
  const demo = read("src/lib/demoApi.ts");
  const start = demo.indexOf(`\n  async ${name}(`);
  if (start < 0) throw new Error(`demoApi.${name} not found`);
  return demo.slice(start, demo.indexOf("\n  async ", start + 1));
}

/** Result codes a demoApi method returns: ok("code") / no("code"), also inside a ternary. */
const tsCodes = (body: string) =>
  new Set([...body.matchAll(/\b(?:no|ok)\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])));

describe("Setup and rule consistency (risks R-01, R-04)", () => {
  it("TC-36 README setup creates every database function the app calls", () => {
    const files = readmeSetupFiles();
    expect(files[0]).toBe("supabase/schema.sql");
    const defined = new Set(files.flatMap((f) => sqlFunctions(read(f))));
    const called = calledRpcs("src/lib/supabaseApi.ts", "src/app/api/register/route.ts", "src/app/api/reset-password/route.ts");
    expect(called.size).toBeGreaterThan(0);
    const missing = sorted([...called].filter((fn) => !defined.has(fn)));
    expect(missing, "functions called by the app but not created by the README setup steps").toEqual([]);
  });

  it("TC-37 the 3-hour cancel and 30-minute check-in windows are the same in every SQL copy and in TypeScript", () => {
    let cancelCopies = 0;
    let checkInCopies = 0;
    for (const file of SQL_FILES) {
      const sql = read(file);
      for (const body of sqlBodies(sql, "cancel_booking")) {
        for (const m of body.matchAll(/interval '(\d+) hours'/g)) {
          expect(Number(m[1]) * 3600_000, `${file} cancel_booking`).toBe(FREE_CANCEL_MS);
          cancelCopies++;
        }
      }
      for (const body of sqlBodies(sql, "check_in_booking")) {
        for (const m of body.matchAll(/interval '(\d+) minutes'/g)) {
          expect(Number(m[1]) * 60_000, `${file} check_in_booking`).toBe(CHECKIN_OPENS_MS);
          checkInCopies++;
        }
      }
    }
    expect(cancelCopies).toBeGreaterThan(0);
    expect(checkInCopies).toBeGreaterThan(0);
  });

  it("TC-38 book, cancel and check-in return the same result codes in schema.sql and demoApi.ts", () => {
    const schema = read("supabase/schema.sql");
    const pairs: [string, string][] = [["book_session", "book"], ["cancel_booking", "cancel"], ["check_in_booking", "checkIn"]];
    for (const [fn, method] of pairs) {
      const bodies = sqlBodies(schema, fn);
      expect(bodies.length, `${fn} in schema.sql`).toBe(1);
      expect(sorted(sqlCodes(bodies[0])), `${fn} (SQL) vs demoApi.${method}`).toEqual(sorted(tsCodes(demoMethod(method))));
    }
  });
});
