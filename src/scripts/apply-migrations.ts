#!/usr/bin/env node
/**
 * Applies Drizzle SQL migrations from drizzle/ using the official migrator.
 *
 * Workflow for new schema changes:
 * 1. Update src/db/schema.ts
 * 2. npm run db:generate
 * 3. Commit drizzle/*.sql + drizzle/meta/*
 * 4. npm run db:migrate (each environment)
 *
 * Databases that previously used the legacy `schema_migrations` table are
 * bridged automatically on first run.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

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

async function bridgeLegacySchemaMigrations(sql: postgres.Sql): Promise<void> {
  const legacyTable = await sql`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    ) AS exists
  `;
  if (!legacyTable[0]?.exists) return;

  const applied = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations ORDER BY filename
  `;
  if (applied.length === 0) return;

  const journalPath = join(process.cwd(), 'drizzle/meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  const appliedTags = new Set(
    applied.map((row) => row.filename.replace(/\.sql$/, '')),
  );

  let maxWhen = 0;
  let lastTag: string | null = null;
  for (const entry of journal.entries) {
    if (!appliedTags.has(entry.tag)) continue;
    if (entry.when >= maxWhen) {
      maxWhen = entry.when;
      lastTag = entry.tag;
    }
  }
  if (!lastTag) return;

  const body = await readFile(join(process.cwd(), 'drizzle', `${lastTag}.sql`), 'utf8');
  const hash = createHash('sha256').update(body).digest('hex');

  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const existing = await sql<{ created_at: string | number }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC LIMIT 1
  `;
  if (existing.length > 0 && Number(existing[0].created_at) >= maxWhen) {
    console.log('Legacy schema_migrations already bridged to Drizzle');
    return;
  }

  await sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES (${hash}, ${maxWhen})
  `;
  console.log(
    `Bridged legacy schema_migrations through ${lastTag} into drizzle.__drizzle_migrations`,
  );
}

async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  try {
    await bridgeLegacySchemaMigrations(sql);
    await migrate(db, { migrationsFolder: './drizzle' });
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
