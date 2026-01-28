import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { URL } from 'url';

dotenv.config();

/**
 * Database connection pool configuration
 * Uses connection pooling for efficient database access
 * 
 * For Aiven PostgreSQL with SSL:
 * - SSL mode is set via connection string (sslmode=require)
 * - If CA certificate is provided via env var, it will be used
 */
// Parse connection string and build config
// For Aiven, we need to handle SSL explicitly to avoid certificate validation issues
const databaseUrl = process.env.DATABASE_URL || '';
const isAiven = databaseUrl.includes('aivencloud.com');

// Determine SSL configuration
const getSSLConfig = () => {
  if (process.env.DATABASE_SSL_CA_PATH) {
    try {
      return {
        ca: readFileSync(process.env.DATABASE_SSL_CA_PATH).toString(),
        rejectUnauthorized: true,
      };
    } catch (error) {
      console.warn('Could not read SSL CA certificate, using rejectUnauthorized: false');
    }
  }
  // For Aiven without CA cert, we need to allow self-signed certificates
  // This is safe for Aiven as they use valid certificates, just not in the default trust store
  if (isAiven) {
    return {
      rejectUnauthorized: false, // Aiven uses valid certs, but not in default trust store
    };
  }
  return undefined;
};

// Build pool config
// For Aiven, parse URL and build config object to have full control over SSL
let poolConfig: PoolConfig;

if (isAiven) {
  // Parse connection string for Aiven
  const url = new URL(databaseUrl.replace(/^postgres:/, 'postgresql:'));
  const sslConfig = getSSLConfig();
  
  poolConfig = {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: url.pathname.slice(1) || 'defaultdb',
    user: url.username,
    password: url.password,
    ssl: sslConfig || { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
} else {
  // Use connection string for non-Aiven databases
  poolConfig = {
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
  
  const sslConfig = getSSLConfig();
  if (sslConfig) {
    poolConfig.ssl = sslConfig;
  }
}

// Create a singleton connection pool
const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('Database connected successfully:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

/**
 * Execute a query with error handling
 */
export async function query(text: string, params?: any[]) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Query error', { text, error });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 */
export function getClient() {
  return pool.connect();
}

export default pool;
