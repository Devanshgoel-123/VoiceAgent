#!/usr/bin/env node
/**
 * Run before `drizzle-kit migrate` (see package.json's `db:migrate`).
 * Postgres has no `CREATE DATABASE IF NOT EXISTS` — check pg_database via a
 * maintenance-db connection and create the target database if it's missing.
 */
import 'dotenv/config';
import postgres from 'postgres';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!dbName) {
    throw new Error(`DATABASE_URL has no database name: ${url}`);
  }

  const maintenanceDbName = process.env.MIGRATION_MAINTENANCE_DB?.trim() || 'postgres';
  if (maintenanceDbName === dbName) return;

  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = `/${maintenanceDbName}`;

  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (existing.length > 0) return;

    console.log(`database ${dbName} does not exist, creating`);
    try {
      await admin.unsafe(`create database ${quoteIdent(dbName)}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== '42P04') throw error; // 42P04 = duplicate_database (lost a create race)
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }

  await ensureDatabaseExists(url);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
