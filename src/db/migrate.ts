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
      
      // Remove comment-only lines
      let cleanedSchema = schema
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          return trimmed.length === 0 || !trimmed.startsWith('--') || trimmed.includes('CREATE') || trimmed.includes('ALTER');
        })
        .join('\n');

      // Protect $$...$$ blocks so splitting on ; doesn't break trigger functions
      const dollarBlocks: string[] = [];
      const schemaWithPlaceholders = cleanedSchema.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
        const idx = dollarBlocks.length;
        dollarBlocks.push(match);
        return `__DOLLAR_BLOCK_${idx}__`;
      });

      // Split by semicolon followed by optional whitespace and newline
      let statements = schemaWithPlaceholders
        .split(/;\s*\n/)
        .map(s => s.trim())
        .filter(s => {
          const cleaned = s.replace(/--[^\n]*/g, '').trim();
          return cleaned.length > 0 && (cleaned.toUpperCase().startsWith('CREATE') || cleaned.toUpperCase().startsWith('DROP') || cleaned.toUpperCase().startsWith('INSERT'));
        });

      // Restore $$...$$ blocks in each statement
      statements = statements.map(stmt => {
        let out = stmt;
        dollarBlocks.forEach((block, i) => {
          out = out.replace(`__DOLLAR_BLOCK_${i}__`, block);
        });
        return out;
      });

      // Only migrate core tables: crm_projects, contacts, project_contacts (and their triggers)
      const coreOnly = true;
      const allowedTables = ['crm_projects', 'contacts', 'project_contacts'];
      if (coreOnly) {
        statements = statements.filter(stmt => {
          const upper = stmt.toUpperCase();
          if (upper.includes('CALL_SESSIONS') || upper.includes('TERMINAL_SESSIONS')) return false;
          if (upper.includes('CREATE EXTENSION')) return true;
          if (upper.includes('CREATE OR REPLACE FUNCTION')) return true;
          if (upper.includes('CREATE TRIGGER')) {
            return allowedTables.some(t => upper.includes(t.toUpperCase()));
          }
          return allowedTables.some(t => stmt.includes(t));
        });
        console.log('Applying core tables only: crm_projects, contacts, project_contacts');
      }
      
      // Check if core tables exist but are incomplete (from previous failed migration)
      const checkResult = await query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('crm_projects', 'contacts', 'project_contacts')
      `);
      
      if (checkResult.rows.length > 0) {
        console.log('Found existing core tables. Checking if they need to be recreated...');
        const projectsCheck = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'crm_projects' AND column_name = 'call_suppressed'
        `);
        
        if (projectsCheck.rows.length === 0) {
          console.log('CRM projects table is incomplete. Dropping and recreating core tables...');
          await query('DROP TABLE IF EXISTS project_contacts CASCADE');
          await query('DROP TABLE IF EXISTS contacts CASCADE');
          await query('DROP TABLE IF EXISTS crm_projects CASCADE');
        }
      }
      
      // Execute each statement separately (not in a transaction)
      for (const statement of statements) {
        if (statement.trim().length > 0) {
          try {
            await query(statement);
          } catch (error: any) {
            // Already exists (table, index, trigger, etc.)
            if (error.code === '42P07' || error.code === '42710' || error.code === '42723') continue;
            if (error.code === '42601' && statement.includes('CREATE OR REPLACE FUNCTION')) {
              // Run trigger function as single query (avoids $$ split issues)
              const funcSql = `CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $fn$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$fn$ language 'plpgsql'`;
              try {
                await query(funcSql);
              } catch (e2: any) {
                console.warn('Trigger function skipped:', e2.message);
              }
              continue;
            }
            console.error('Error executing statement:', statement.substring(0, 200));
            console.error('Error code:', error.code, 'Message:', error.message);
            throw error;
          }
        }
      }
      // Ensure trigger function exists (in case it was skipped by filter)
      try {
        await query(`CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $fn$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$fn$ language 'plpgsql'`);
      } catch (e: any) {
        if (e.code !== '42P07') console.warn('Trigger function:', e.message);
      }
      // Create triggers for core tables
      for (const t of ['crm_projects', 'contacts', 'project_contacts']) {
        try {
          await query(`CREATE TRIGGER update_${t}_updated_at BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`);
        } catch (e: any) {
          if (e.code === '42710') continue; // already exists
          console.warn(`Trigger on ${t}:`, e.message);
        }
      }
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial_schema']);
      console.log('Initial schema applied successfully');
    } else {
      console.log('Schema already up to date');
    }

    if (!appliedVersions.has('002_align_hubspot_fields')) {
      console.log('Applying 002_align_hubspot_fields...');
      const fs = require('fs');
      const migrationPath = join(__dirname, 'migrations', '002_align_hubspot_fields.sql');
      if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf-8').replace(/\r\n/g, '\n');
        const doBlocks = sql.split('END $$;').map((s: string) => s.trim()).filter((s: string) => s.startsWith('DO $$'));
        for (const block of doBlocks) {
          await query(block + 'END $$;');
        }
        const rest = sql.split('END $$;').pop() || '';
        for (const line of rest.split(';')) {
          const stmt = line.trim().replace(/^--.*$/gm, '').trim();
          if (stmt && (stmt.toUpperCase().startsWith('DROP') || stmt.toUpperCase().startsWith('CREATE'))) {
            await query(stmt + ';');
          }
        }
        await query('INSERT INTO schema_migrations (version) VALUES ($1)', ['002_align_hubspot_fields']);
        console.log('002_align_hubspot_fields applied');
      }
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
