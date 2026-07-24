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

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is required to apply migrations');
    process.exit(1);
  }

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
