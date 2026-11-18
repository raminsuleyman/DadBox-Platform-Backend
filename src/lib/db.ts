import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from './config.js';

// PostgreSQL int8 and numeric fields are constrained to safe values by our schema.
pg.types.setTypeParser(20, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('Unsafe integer from database'); return n; });
pg.types.setTypeParser(1700, value => Number(value));
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
pool.on('error', () => console.error('PostgreSQL bağlantısı kəsildi.'));
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { try { await client.query('ROLLBACK'); } catch { /* original error is retained */ } throw error; }
  finally { client.release(); }
}
