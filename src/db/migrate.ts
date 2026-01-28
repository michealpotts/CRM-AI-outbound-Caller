import { readFileSync } from 'fs';
import { join } from 'path';
import pool, { query } from './connection';

/**
 * Migration runner
 * Applies SQL migrations in order
 */
async function runMigrations() {
  try {
    // Create migrations table if it doesn't exist
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get applied migrations
    const appliedResult = await query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = new Set(appliedResult.rows.map((r: any) => r.version));

    // Read schema.sql (for initial setup)
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    // Check if initial schema is applied
    if (!appliedVersions.has('001_initial_schema')) {
      console.log('Applying initial schema...');
      
      // Split schema into statements
      // Remove comment-only lines first, then split by semicolons
      let cleanedSchema = schema
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          // Keep lines that are not pure comments (but allow inline comments)
          return trimmed.length === 0 || !trimmed.startsWith('--') || trimmed.includes('CREATE') || trimmed.includes('ALTER');
        })
        .join('\n');
      
      // Split by semicolon followed by optional whitespace and newline
      const statements = cleanedSchema
        .split(/;\s*\n/)
        .map(s => s.trim())
        .filter(s => {
          // Remove empty statements
          const cleaned = s.replace(/--[^\n]*/g, '').trim();
          return cleaned.length > 0 && (cleaned.toUpperCase().startsWith('CREATE') || cleaned.toUpperCase().startsWith('DROP') || cleaned.toUpperCase().startsWith('INSERT'));
        });
      
      // Check if tables exist but are incomplete (from previous failed migration)
      // If so, drop them to start fresh
      const checkResult = await query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('projects', 'contacts', 'project_contacts', 'call_sessions', 'terminal_sessions')
      `);
      
      if (checkResult.rows.length > 0) {
        console.log('Found existing tables. Checking if they need to be recreated...');
        // Check if projects table has call_suppressed column
        const projectsCheck = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'projects' AND column_name = 'call_suppressed'
        `);
        
        if (projectsCheck.rows.length === 0) {
          console.log('Projects table is incomplete. Dropping and recreating...');
          // Drop tables in reverse dependency order
          await query('DROP TABLE IF EXISTS terminal_sessions CASCADE');
          await query('DROP TABLE IF EXISTS call_sessions CASCADE');
          await query('DROP TABLE IF EXISTS project_contacts CASCADE');
          await query('DROP TABLE IF EXISTS contacts CASCADE');
          await query('DROP TABLE IF EXISTS projects CASCADE');
        }
      }
      
      // Execute each statement separately (not in a transaction)
      // CREATE IF NOT EXISTS is idempotent, so this is safe
      for (const statement of statements) {
        if (statement.trim().length > 0) {
          try {
            await query(statement);
          } catch (error: any) {
            // Ignore "already exists" errors for CREATE IF NOT EXISTS
            if (error.code === '42P07' || error.code === '42710' || error.code === '42723') {
              // Object already exists, which is fine for IF NOT EXISTS
              continue;
            }
            // For other errors, log and rethrow
            console.error('Error executing statement:', statement.substring(0, 200));
            console.error('Error code:', error.code, 'Message:', error.message);
            throw error;
          }
        }
      }
      
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial_schema']);
      console.log('Initial schema applied successfully');
    } else {
      console.log('Schema already up to date');
    }

    console.log('Migrations completed');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migrations if called directly
if (require.main === module) {
  runMigrations();
}

export { runMigrations };
