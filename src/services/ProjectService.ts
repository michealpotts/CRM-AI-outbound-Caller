import { query, getClient } from '../db/connection';
import { Project } from '../types';

/**
 * ProjectService
 * Handles all project-related operations with idempotency
 * 
 * Idempotency Strategy:
 * - Uses external project_id as the unique identifier
 * - All upsert operations check for existing project_id first
 * - If exists, update; if not, insert
 * - This ensures the same project data can be ingested multiple times safely
 */
export class ProjectService {
  /**
   * Upsert a project (idempotent)
   * If project_id exists, updates the project; otherwise creates a new one
   */
  async upsertProject(project: Project): Promise<Project> {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // Check if project exists by external project_id
      const existingResult = await client.query(
        'SELECT id FROM crm_projects WHERE project_id = $1',
        [project.project_id]
      );
      
      if (existingResult.rows.length > 0) {
        // Update existing project
        const updateFields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;
        
        // Build dynamic update query
        const fieldsToUpdate: (keyof Project)[] = [
          'name', 'address', 'suburb', 'postcode', 'state', 'category',
          'awarded_date', 'distance', 'budget', 'quotes_due_date', 'country',
          'last_contacted_at', 'next_call_eligible_at', 'call_suppressed'
        ];
        
        for (const field of fieldsToUpdate) {
          if (project[field] !== undefined) {
            updateFields.push(`${field} = $${paramIndex}`);
            values.push(project[field]);
            paramIndex++;
          }
        }
        
        values.push(project.project_id);
        
        const updateQuery = `
          UPDATE crm_projects
          SET ${updateFields.join(', ')}
          WHERE project_id = $${paramIndex}
          RETURNING *
        `;
        
        const result = await client.query(updateQuery, values);
        await client.query('COMMIT');
        return this.mapRowToProject(result.rows[0]);
      } else {
        // Insert new project
        const insertQuery = `
          INSERT INTO crm_projects (
            project_id, name, address, suburb, postcode, state, category,
            awarded_date, distance, budget, quotes_due_date, country,
            last_contacted_at, next_call_eligible_at, call_suppressed
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
          )
          RETURNING *
        `;
        
        const result = await client.query(insertQuery, [
          project.project_id,
          project.name,
          project.address || null,
          project.suburb || null,
          project.postcode || null,
          project.state || null,
          project.category || null,
          project.awarded_date || null,
          project.distance ?? null,
          project.budget || null,
          project.quotes_due_date || null,
          project.country || 'AU',
          project.last_contacted_at || null,
          project.next_call_eligible_at || null,
          project.call_suppressed || false,
        ]);
        
        await client.query('COMMIT');
        return this.mapRowToProject(result.rows[0]);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get project by external project_id
   */
  async getProjectByExternalId(projectId: string): Promise<Project | null> {
    const result = await query(
      'SELECT * FROM crm_projects WHERE project_id = $1',
      [projectId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToProject(result.rows[0]);
  }
  
  /**
   * Get project by internal UUID
   */
  async getProjectById(id: string): Promise<Project | null> {
    const result = await query(
      'SELECT * FROM crm_projects WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToProject(result.rows[0]);
  }
  
  /**
   * Update call suppression status
   */
  async updateCallSuppression(projectId: string, suppressed: boolean): Promise<void> {
    await query(
      'UPDATE crm_projects SET call_suppressed = $1 WHERE project_id = $2',
      [suppressed, projectId]
    );
  }
  
  /**
   * Update next call eligible time
   */
  async updateNextCallEligibleAt(projectId: string, eligibleAt: Date): Promise<void> {
    await query(
      'UPDATE crm_projects SET next_call_eligible_at = $1 WHERE project_id = $2',
      [eligibleAt, projectId]
    );
  }
  
  /**
   * Update last contacted timestamp
   */
  async updateLastContactedAt(projectId: string, contactedAt: Date): Promise<void> {
    await query(
      'UPDATE crm_projects SET last_contacted_at = $1 WHERE project_id = $2',
      [contactedAt, projectId]
    );
  }
  
  /**
   * Map database row to Project type
   */
  private mapRowToProject(row: any): Project {
    return {
      id: row.id,
      project_id: row.project_id,
      name: row.name,
      address: row.address,
      suburb: row.suburb,
      postcode: row.postcode,
      state: row.state,
      category: row.category,
      awarded_date: row.awarded_date,
      distance: row.distance != null ? parseFloat(row.distance) : undefined,
      budget: row.budget,
      quotes_due_date: row.quotes_due_date,
      country: row.country,
      last_contacted_at: row.last_contacted_at,
      next_call_eligible_at: row.next_call_eligible_at,
      call_suppressed: row.call_suppressed,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
