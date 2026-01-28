import { query, getClient } from '../db/connection';
import { CallSession } from '../types';
import { ProjectService } from './ProjectService';
import { ProjectContactService } from './ProjectContactService';

/**
 * CallSessionService
 * Manages call session creation and updates
 * 
 * Idempotency Strategy:
 * - Uses external call_session_id if provided
 * - If call_session_id exists, returns existing session (idempotent)
 * - All call sessions are append-only (never deleted, only created)
 */
export class CallSessionService {
  private projectService: ProjectService;
  private projectContactService: ProjectContactService;
  
  constructor() {
    this.projectService = new ProjectService();
    this.projectContactService = new ProjectContactService();
  }
  
  /**
   * Create a call session (idempotent)
   * If call_session_id provided and exists, returns existing session
   */
  async createCallSession(session: CallSession): Promise<CallSession> {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // Idempotency check: if call_session_id provided, check if exists
      if (session.call_session_id) {
        const existingResult = await client.query(
          'SELECT * FROM call_sessions WHERE call_session_id = $1',
          [session.call_session_id]
        );
        
        if (existingResult.rows.length > 0) {
          await client.query('COMMIT');
          return this.mapRowToCallSession(existingResult.rows[0]);
        }
      }
      
      // Get project internal ID
      const project = await this.projectService.getProjectByExternalId(session.project_id);
      if (!project || !project.id) {
        throw new Error(`Project not found: ${session.project_id}`);
      }
      
      // Get contact internal ID if provided
      let contactInternalId: string | null = null;
      if (session.contact_id) {
        const contactResult = await client.query(
          'SELECT id FROM contacts WHERE id = $1',
          [session.contact_id]
        );
        if (contactResult.rows.length > 0) {
          contactInternalId = contactResult.rows[0].id;
        }
      }
      
      // Insert call session
      const insertQuery = `
        INSERT INTO call_sessions (
          call_session_id, project_id, contact_id, call_type, call_status,
          detected_role, role_confidence, outcome, sentiment, escalated,
          escalation_reason, transcript, recording_url, started_at, ended_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        session.call_session_id || null,
        project.id,
        contactInternalId,
        session.call_type,
        session.call_status,
        session.detected_role || null,
        session.role_confidence || null,
        session.outcome || null,
        session.sentiment || null,
        session.escalated || false,
        session.escalation_reason || null,
        session.transcript || null,
        session.recording_url || null,
        session.started_at || new Date(),
        session.ended_at || null,
      ]);
      
      // Get external project_id for response
      const sessionWithProject = await query(
        `SELECT cs.*, p.project_id as external_project_id
         FROM call_sessions cs
         INNER JOIN projects p ON cs.project_id = p.id
         WHERE cs.id = $1`,
        [result.rows[0].id]
      );
      
      const createdSession = this.mapRowToCallSession(sessionWithProject.rows[0]);
      
      // Update project last_contacted_at and next_call_eligible_at
      const now = new Date();
      const nextEligibleAt = new Date(now);
      nextEligibleAt.setHours(nextEligibleAt.getHours() + 24); // 24 hour cooldown
      
      await this.projectService.updateLastContactedAt(session.project_id, now);
      await this.projectService.updateNextCallEligibleAt(session.project_id, nextEligibleAt);
      
      // Update project-contact last_contacted_at if contact provided
      if (contactInternalId) {
        await this.projectContactService.upsertProjectContact(
          project.id,
          contactInternalId,
          { last_contacted_at: now }
        );
      }
      
      await client.query('COMMIT');
      return createdSession;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Update call session (for ongoing calls)
   */
  async updateCallSession(
    sessionId: string,
    updates: Partial<CallSession>
  ): Promise<CallSession> {
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    const fieldsToUpdate: (keyof CallSession)[] = [
      'call_status', 'detected_role', 'role_confidence', 'outcome',
      'sentiment', 'escalated', 'escalation_reason', 'transcript',
      'recording_url', 'ended_at'
    ];
    
    for (const field of fieldsToUpdate) {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }
    
    values.push(sessionId);
    
    const updateQuery = `
      UPDATE call_sessions
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;
    
    const result = await query(updateQuery, values);
    
    if (result.rows.length === 0) {
      throw new Error(`Call session not found: ${sessionId}`);
    }
    
    // Get external project_id for response
    const sessionWithProject = await query(
      `SELECT cs.*, p.project_id as external_project_id
       FROM call_sessions cs
       INNER JOIN projects p ON cs.project_id = p.id
       WHERE cs.id = $1`,
      [sessionId]
    );
    
    return this.mapRowToCallSession(sessionWithProject.rows[0]);
  }
  
  /**
   * Get call session by ID
   */
  async getCallSessionById(id: string): Promise<CallSession | null> {
    const result = await query(
      `SELECT cs.*, p.project_id as external_project_id
       FROM call_sessions cs
       INNER JOIN projects p ON cs.project_id = p.id
       WHERE cs.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToCallSession(result.rows[0]);
  }
  
  /**
   * Get call sessions by project
   */
  async getCallSessionsByProject(projectId: string): Promise<CallSession[]> {
    const project = await this.projectService.getProjectByExternalId(projectId);
    if (!project || !project.id) {
      return [];
    }
    
    const result = await query(
      `SELECT cs.*, p.project_id as external_project_id
       FROM call_sessions cs
       INNER JOIN projects p ON cs.project_id = p.id
       WHERE cs.project_id = $1
       ORDER BY cs.started_at DESC`,
      [project.id]
    );
    
    return result.rows.map(row => this.mapRowToCallSession(row));
  }
  
  /**
   * Map database row to CallSession type
   * Note: Expects row to have external_project_id from JOIN with projects table
   */
  private mapRowToCallSession(row: any): CallSession {
    return {
      id: row.id,
      call_session_id: row.call_session_id,
      project_id: row.external_project_id || row.project_id, // Use external ID if available
      contact_id: row.contact_id,
      call_type: row.call_type,
      call_status: row.call_status,
      detected_role: row.detected_role,
      role_confidence: row.role_confidence ? parseFloat(row.role_confidence) : undefined,
      outcome: row.outcome,
      sentiment: row.sentiment,
      escalated: row.escalated,
      escalation_reason: row.escalation_reason,
      transcript: row.transcript,
      recording_url: row.recording_url,
      started_at: row.started_at,
      ended_at: row.ended_at,
      created_at: row.created_at,
    };
  }
}
