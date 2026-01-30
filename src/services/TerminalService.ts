import { query, getClient } from '../db/connection';
import { TerminalSession } from '../types';

/**
 * TerminalService
 * Manages terminal states that prevent calling
 * 
 * Terminal sessions are used for:
 * - Opt-outs
 * - Do not call requests
 * - Project completion
 * - Permanent suppressions
 * 
 * Idempotency Strategy:
 * - Uses external terminal_id if provided
 * - If terminal_id exists, returns existing session (idempotent)
 * - Terminal sessions can expire (expires_at) or be permanent (NULL)
 */
export class TerminalService {
  /**
   * Create a terminal session (idempotent)
   * If terminal_id provided and exists, returns existing session
   */
  async createTerminalSession(session: TerminalSession): Promise<TerminalSession> {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // Idempotency check
      if (session.terminal_id) {
        const existingResult = await client.query(
          'SELECT * FROM terminal_sessions WHERE terminal_id = $1',
          [session.terminal_id]
        );
        
        if (existingResult.rows.length > 0) {
          await client.query('COMMIT');
          return this.mapRowToTerminalSession(existingResult.rows[0]);
        }
      }
      
      // Resolve project/contact IDs based on scope
      let projectInternalId: string | null = null;
      let contactInternalId: string | null = null;
      
      if (session.scope === 'project' && session.project_id) {
        const projectResult = await query(
          'SELECT id FROM crm_projects WHERE project_id = $1',
          [session.project_id]
        );
        if (projectResult.rows.length > 0) {
          projectInternalId = projectResult.rows[0].id;
        } else {
          throw new Error(`Project not found: ${session.project_id}`);
        }
      } else if (session.scope === 'contact' && session.contact_id) {
        contactInternalId = session.contact_id; // Assume it's already internal ID
      }
      
      // Insert terminal session
      const insertQuery = `
        INSERT INTO terminal_sessions (
          terminal_id, scope, project_id, contact_id, reason,
          created_by, expires_at, override_allowed
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        session.terminal_id || null,
        session.scope,
        projectInternalId,
        contactInternalId,
        session.reason,
        session.created_by || 'system',
        session.expires_at || null,
        session.override_allowed || false,
      ]);
      
      await client.query('COMMIT');
      return this.mapRowToTerminalSession(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Check if an active terminal session exists
   * Returns true if a non-expired terminal session exists
   */
  async hasActiveTerminalSession(
    scope: 'project' | 'contact' | 'global',
    resourceId: string,
    contactId?: string
  ): Promise<{ hasTerminal: boolean; reason?: string }> {
    let queryText: string;
    let params: any[];
    
    if (scope === 'global') {
      queryText = `
        SELECT reason FROM terminal_sessions
        WHERE scope = 'global'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;
      params = [];
    } else if (scope === 'project') {
      queryText = `
        SELECT reason FROM terminal_sessions
        WHERE scope = 'project' AND project_id = $1
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;
      params = [resourceId];
    } else {
      // contact scope
      queryText = `
        SELECT reason FROM terminal_sessions
        WHERE scope = 'contact' AND contact_id = $1
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;
      params = [resourceId];
    }
    
    const result = await query(queryText, params);
    
    if (result.rows.length > 0) {
      return {
        hasTerminal: true,
        reason: result.rows[0].reason,
      };
    }
    
    return { hasTerminal: false };
  }
  
  /**
   * Get terminal session by ID
   */
  async getTerminalSessionById(id: string): Promise<TerminalSession | null> {
    const result = await query(
      'SELECT * FROM terminal_sessions WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToTerminalSession(result.rows[0]);
  }
  
  /**
   * Delete/expire a terminal session (if override_allowed is true)
   */
  async removeTerminalSession(id: string): Promise<boolean> {
    const session = await this.getTerminalSessionById(id);
    if (!session) {
      return false;
    }
    
    if (!session.override_allowed) {
      throw new Error('Terminal session cannot be removed (override_allowed is false)');
    }
    
    await query(
      'UPDATE terminal_sessions SET expires_at = NOW() WHERE id = $1',
      [id]
    );
    
    return true;
  }
  
  /**
   * Map database row to TerminalSession type
   */
  private mapRowToTerminalSession(row: any): TerminalSession {
    return {
      id: row.id,
      terminal_id: row.terminal_id,
      scope: row.scope,
      project_id: row.project_id,
      contact_id: row.contact_id,
      reason: row.reason,
      created_by: row.created_by,
      expires_at: row.expires_at,
      override_allowed: row.override_allowed,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
