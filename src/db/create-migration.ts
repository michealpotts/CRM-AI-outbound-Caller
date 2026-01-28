import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Helper script to create new migration files
 * Usage: npm run migrate:create -- migration_name
 */
const migrationName = process.argv[2];

if (!migrationName) {
  console.error('Usage: npm run migrate:create -- migration_name');
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
const fileName = `${timestamp}_${migrationName}.sql`;
const filePath = join(__dirname, 'migrations', fileName);

const content = `-- Migration: ${migrationName}
-- Description: 
-- Created: ${new Date().toISOString()}

-- Add your migration SQL here

`;

writeFileSync(filePath, content);
console.log(`Created migration file: ${filePath}`);
