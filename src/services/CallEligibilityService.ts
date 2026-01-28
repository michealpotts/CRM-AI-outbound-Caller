import { query } from '../db/connection';
import { EligibleCall } from '../types';
import { TerminalService } from './TerminalService';

/**
 * CallEligibilityService
 * 
 * Determines which projects/contacts are eligible for calling based on:
 * - Suppression flags (project.call_suppressed, contact.do_not_call, project_contact.suppress_for_project)
 * - Cooldown periods (next_call_eligible_at)
 * - Terminal sessions (must never call if terminal session exists)
 * - Builder/contact fatigue limits (configurable)
 * 
 * This is the source of truth for call eligibility logic.
 */
export class CallEligibilityService {
  private terminalService: TerminalService;
  
  // Configuration constants
  private readonly MIN_CALL_COOLDOWN_HOURS = 24; // Minimum hours between calls
  private readonly MAX_CALLS_PER_DAY = 3; // Max calls per day per project/contact
  private readonly MAX_CALLS_PER_WEEK = 10; // Max calls per week per project/contact
  
  constructor() {
    this.terminalService = new TerminalService();
  }
  
  /**
   * Check if a project is eligible for calling
   */
  async isProjectEligible(projectId: string): Promise<{ eligible: boolean; reason?: string }> {
    // Get project
    const projectResult = await query(
      'SELECT * FROM projects WHERE project_id = $1',
      [projectId]
    );
    
    if (projectResult.rows.length === 0) {
      return { eligible: false, reason: 'Project not found' };
    }
    
    const project = projectResult.rows[0];
    
    // Check 1: Project suppression flag
    if (project.call_suppressed) {
      return { eligible: false, reason: 'Project is suppressed' };
    }
    
    // Check 2: Terminal session for project
    const terminalCheck = await this.terminalService.hasActiveTerminalSession('project', project.id);
    if (terminalCheck.hasTerminal) {
      return { eligible: false, reason: `Terminal session exists: ${terminalCheck.reason}` };
    }
    
    // Check 3: Cooldown period
    if (project.next_call_eligible_at) {
      const eligibleAt = new Date(project.next_call_eligible_at);
      if (eligibleAt > new Date()) {
        return { eligible: false, reason: `Cooldown period active until ${eligibleAt.toISOString()}` };
      }
    }
    
    // Check 4: Call frequency limits (fatigue)
    const fatigueCheck = await this.checkCallFatigue(project.id, null);
    if (!fatigueCheck.allowed) {
      return { eligible: false, reason: fatigueCheck.reason };
    }
    
    return { eligible: true };
  }
  
  /**
   * Check if a contact is eligible for calling
   */
  async isContactEligible(contactId: string, projectId?: string): Promise<{ eligible: boolean; reason?: string }> {
    // Get contact
    const contactResult = await query(
      'SELECT * FROM contacts WHERE id = $1',
      [contactId]
    );
    
    if (contactResult.rows.length === 0) {
      return { eligible: false, reason: 'Contact not found' };
    }
    
    const contact = contactResult.rows[0];
    
    // Check 1: Global do not call flag
    if (contact.do_not_call) {
      return { eligible: false, reason: 'Contact has do_not_call flag' };
    }
    
    // Check 2: Terminal session for contact
    const terminalCheck = await this.terminalService.hasActiveTerminalSession('contact', contact.id);
    if (terminalCheck.hasTerminal) {
      return { eligible: false, reason: `Terminal session exists: ${terminalCheck.reason}` };
    }
    
    // Check 3: Project-specific suppression (if project provided)
    if (projectId) {
      const projectResult = await query(
        'SELECT id FROM projects WHERE project_id = $1',
        [projectId]
      );
      
      if (projectResult.rows.length > 0) {
        const projectContactResult = await query(
          'SELECT suppress_for_project FROM project_contacts WHERE project_id = $1 AND contact_id = $2',
          [projectResult.rows[0].id, contactId]
        );
        
        if (projectContactResult.rows.length > 0 && projectContactResult.rows[0].suppress_for_project) {
          return { eligible: false, reason: 'Contact suppressed for this project' };
        }
      }
    }
    
    // Check 4: Call frequency limits
    const fatigueCheck = await this.checkCallFatigue(null, contactId);
    if (!fatigueCheck.allowed) {
      return { eligible: false, reason: fatigueCheck.reason };
    }
    
    return { eligible: true };
  }
  
  /**
   * Check if a project-contact combination is eligible for calling
   */
  async isProjectContactEligible(
    projectId: string,
    contactId: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    // Check project eligibility
    const projectCheck = await this.isProjectEligible(projectId);
    if (!projectCheck.eligible) {
      return projectCheck;
    }
    
    // Check contact eligibility
    const contactCheck = await this.isContactEligible(contactId, projectId);
    if (!contactCheck.eligible) {
      return contactCheck;
    }
    
    // Check project-contact specific terminal session
    const projectResult = await query(
      'SELECT id FROM projects WHERE project_id = $1',
      [projectId]
    );
    
    if (projectResult.rows.length > 0) {
      const terminalCheck = await this.terminalService.hasActiveTerminalSession(
        'project',
        projectResult.rows[0].id,
        contactId
      );
      if (terminalCheck.hasTerminal) {
        return { eligible: false, reason: `Terminal session exists: ${terminalCheck.reason}` };
      }
    }
    
    return { eligible: true };
  }
  
  /**
   * Get all eligible calls (for batch processing)
   * Returns project-contact pairs that are eligible for calling
   */
  async getEligibleCalls(limit: number = 100): Promise<EligibleCall[]> {
    const queryText = `
      SELECT DISTINCT
        p.project_id,
        p.project_name,
        c.id as contact_id,
        c.name as contact_name,
        c.phone,
        pc.role_for_project,
        pc.role_confidence,
        COALESCE(pc.preferred_channel_project, c.preferred_channel, 'phone') as preferred_channel
      FROM projects p
      INNER JOIN project_contacts pc ON p.id = pc.project_id
      INNER JOIN contacts c ON pc.contact_id = c.id
      WHERE
        -- Project not suppressed
        p.call_suppressed = false
        -- Contact not globally suppressed
        AND c.do_not_call = false
        -- Project-contact not suppressed
        AND (pc.suppress_for_project = false OR pc.suppress_for_project IS NULL)
        -- Cooldown period passed
        AND (p.next_call_eligible_at IS NULL OR p.next_call_eligible_at <= NOW())
        -- Has phone number
        AND c.phone IS NOT NULL
        AND c.phone != ''
      ORDER BY p.priority_score DESC, p.next_call_eligible_at ASC NULLS FIRST
      LIMIT $1
    `;
    
    const result = await query(queryText, [limit]);
    
    // Filter out contacts/projects with terminal sessions
    const eligibleCalls: EligibleCall[] = [];
    
    for (const row of result.rows) {
      // Check terminal sessions
      const projectResult = await query(
        'SELECT id FROM projects WHERE project_id = $1',
        [row.project_id]
      );
      
      if (projectResult.rows.length === 0) continue;
      
      const projectInternalId = projectResult.rows[0].id;
      
      // Check project terminal
      const projectTerminal = await this.terminalService.hasActiveTerminalSession('project', projectInternalId);
      if (projectTerminal.hasTerminal) continue;
      
      // Check contact terminal
      const contactTerminal = await this.terminalService.hasActiveTerminalSession('contact', row.contact_id);
      if (contactTerminal.hasTerminal) continue;
      
      // Check call fatigue
      const fatigueCheck = await this.checkCallFatigue(projectInternalId, row.contact_id);
      if (!fatigueCheck.allowed) continue;
      
      eligibleCalls.push({
        project_id: row.project_id,
        project_name: row.project_name,
        contact_id: row.contact_id,
        contact_name: row.contact_name,
        phone: row.phone,
        role_for_project: row.role_for_project,
        role_confidence: row.role_confidence ? parseFloat(row.role_confidence) : undefined,
        preferred_channel: row.preferred_channel,
      });
    }
    
    return eligibleCalls;
  }
  
  /**
   * Check call fatigue limits (max calls per day/week)
   */
  private async checkCallFatigue(
    projectId: string | null,
    contactId: string | null
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!projectId && !contactId) {
      return { allowed: false, reason: 'Must provide project or contact ID' };
    }
    
    // Count calls today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayQuery = projectId
      ? 'SELECT COUNT(*) as count FROM call_sessions WHERE project_id = $1 AND started_at >= $2'
      : 'SELECT COUNT(*) as count FROM call_sessions WHERE contact_id = $1 AND started_at >= $2';
    
    const todayResult = await query(todayQuery, [
      projectId || contactId,
      todayStart
    ]);
    
    const callsToday = parseInt(todayResult.rows[0].count);
    if (callsToday >= this.MAX_CALLS_PER_DAY) {
      return { allowed: false, reason: `Daily call limit reached (${callsToday}/${this.MAX_CALLS_PER_DAY})` };
    }
    
    // Count calls this week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    
    const weekQuery = projectId
      ? 'SELECT COUNT(*) as count FROM call_sessions WHERE project_id = $1 AND started_at >= $2'
      : 'SELECT COUNT(*) as count FROM call_sessions WHERE contact_id = $1 AND started_at >= $2';
    
    const weekResult = await query(weekQuery, [
      projectId || contactId,
      weekStart
    ]);
    
    const callsThisWeek = parseInt(weekResult.rows[0].count);
    if (callsThisWeek >= this.MAX_CALLS_PER_WEEK) {
      return { allowed: false, reason: `Weekly call limit reached (${callsThisWeek}/${this.MAX_CALLS_PER_WEEK})` };
    }
    
    return { allowed: true };
  }
}
