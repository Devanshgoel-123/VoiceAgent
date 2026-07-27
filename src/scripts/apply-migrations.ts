#!/usr/bin/env node
/**
 * Applies committed SQL files in drizzle/ in filename order.
 * Future schema changes: update src/db/schema.ts, run `npm run db:generate`,
 * commit the new drizzle/*.sql file, then run `npm run db:migrate` in each env.
 */
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Postgres has no `CREATE DATABASE IF NOT EXISTS` — connect to a maintenance db and create it directly. */
async function createDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!dbName) {
    throw new Error(`DATABASE_URL has no database name: ${url}`);
  }

  const maintenanceDbName = process.env.MIGRATION_MAINTENANCE_DB?.trim() || 'postgres';
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = `/${maintenanceDbName}`;

  console.log(`database ${dbName} does not exist, creating`);
  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdent(dbName)}`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42P04') throw error; // 42P04 = duplicate_database (lost a create race)
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function runMigrations(url: string): Promise<void> {
  const dir = join(process.cwd(), 'drizzle');
  const files = (await readdir(dir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No SQL migrations found in drizzle/');
    return;
  }

  const sql = postgres(url, { max: 1 });
  try {
    await sql`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    for (const file of files) {
      const already = await sql`
        select 1 from schema_migrations where filename = ${file} limit 1
      `;
      if (already.length > 0) {
        console.log(`skip ${file} (already applied)`);
        continue;
      }

      const body = await readFile(join(dir, file), 'utf8');
      console.log(`apply ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          insert into schema_migrations (filename) values (${file})
        `;
      });
    }

    console.log('Migrations complete');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is required to apply migrations');
    process.exit(1);
  }

  try {
    await runMigrations(url);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '3D000') throw error; // 3D000 = invalid_catalog_name (database does not exist)

    await createDatabase(url);
    await runMigrations(url);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
