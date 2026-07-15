import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getSettings } from '../config/settings.js';
import * as schema from './schema.js';

let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function isDatabaseEnabled(): boolean {
  return Boolean(getSettings().databaseUrl);
}

export function getDb() {
  const url = getSettings().databaseUrl;
  if (!url) {
    throw new Error('DATABASE_URL is not configured');
  }

  if (!client || !db) {
    client = postgres(url, { max: 5 });
    db = drizzle(client, { schema });
  }

  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = null;
    db = null;
  }
}
