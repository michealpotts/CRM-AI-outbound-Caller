import { query, getClient } from '../db/connection';
import { ProjectContact } from '../types';

/**
 * ProjectContactService
 * Manages associations between projects and contacts
 */
export class ProjectContactService {
  /**
   * Upsert project-contact association
   * Uses (project_id, contact_id) as unique key for idempotency
   */
  async upsertProjectContact(
    projectId: string, // Internal UUID
    contactId: string, // Internal UUID
    data: Partial<ProjectContact>
  ): Promise<ProjectContact> {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // Check if association exists
      const existingResult = await client.query(
        'SELECT id FROM project_contacts WHERE project_id = $1 AND contact_id = $2',
        [projectId, contactId]
      );
      
      if (existingResult.rows.length > 0) {
        // Update existing association
        const updateFields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;
        
        const fieldsToUpdate: (keyof ProjectContact)[] = [
          'role_for_project', 'role_confidence', 'role_confirmed',
          'preferred_channel_project', 'last_contacted_at', 'suppress_for_project'
        ];
        
        for (const field of fieldsToUpdate) {
          if (data[field] !== undefined) {
            updateFields.push(`${field} = $${paramIndex}`);
            values.push(data[field]);
            paramIndex++;
          }
        }
        
        values.push(projectId, contactId);
        
        const updateQuery = `
          UPDATE project_contacts
          SET ${updateFields.join(', ')}
          WHERE project_id = $${paramIndex} AND contact_id = $${paramIndex + 1}
          RETURNING *
        `;
        
        const result = await client.query(updateQuery, values);
        await client.query('COMMIT');
        return this.mapRowToProjectContact(result.rows[0]);
      } else {
        // Insert new association
        const insertQuery = `
          INSERT INTO project_contacts (
            project_id, contact_id, role_for_project, role_confidence,
            role_confirmed, preferred_channel_project, last_contacted_at,
            suppress_for_project
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
          )
          RETURNING *
        `;
        
        const result = await client.query(insertQuery, [
          projectId,
          contactId,
          data.role_for_project || null,
          data.role_confidence || null,
          data.role_confirmed || false,
          data.preferred_channel_project || null,
          data.last_contacted_at || null,
          data.suppress_for_project || false,
        ]);
        
        await client.query('COMMIT');
        return this.mapRowToProjectContact(result.rows[0]);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get project contacts by project ID
   */
  async getContactsByProject(projectId: string): Promise<ProjectContact[]> {
    const result = await query(
      'SELECT * FROM project_contacts WHERE project_id = $1',
      [projectId]
    );
    
    return result.rows.map(row => this.mapRowToProjectContact(row));
  }
  
  /**
   * Get projects by contact ID
   */
  async getProjectsByContact(contactId: string): Promise<ProjectContact[]> {
    const result = await query(
      'SELECT * FROM project_contacts WHERE contact_id = $1',
      [contactId]
    );
    
    return result.rows.map(row => this.mapRowToProjectContact(row));
  }
  
  /**
   * Map database row to ProjectContact type
   */
  private mapRowToProjectContact(row: any): ProjectContact {
    return {
      id: row.id,
      project_id: row.project_id,
      contact_id: row.contact_id,
      role_for_project: row.role_for_project,
      role_confidence: row.role_confidence ? parseFloat(row.role_confidence) : undefined,
      role_confirmed: row.role_confirmed,
      preferred_channel_project: row.preferred_channel_project,
      last_contacted_at: row.last_contacted_at,
      suppress_for_project: row.suppress_for_project,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
