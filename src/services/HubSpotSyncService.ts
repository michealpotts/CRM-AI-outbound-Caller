import { Client } from '@hubspot/api-client';
import dotenv from 'dotenv';
import { Project, Contact, CallSession, TerminalSession } from '../types';

dotenv.config();

/**
 * HubSpotSyncService
 * 
 * One-way sync: Backend → HubSpot
 * Uses external IDs for upsert operations (idempotent)
 * 
 * Sync Strategy:
 * - Projects → HubSpot Deals
 * - Contacts → HubSpot Contacts
 * - Project-Contact associations → Deal-Contact associations
 * - Call outcomes → Deal notes/activities
 * - Terminal states → Custom properties
 * 
 * All operations are idempotent using external IDs
 */
export class HubSpotSyncService {
  private client: Client | null = null;
  private enabled: boolean = false;
  
  constructor() {
    const apiKey = process.env.HUBSPOT_API_KEY;
    if (apiKey) {
      this.client = new Client({ accessToken: apiKey });
      this.enabled = true;
      console.log('HubSpot sync enabled');
    } else {
      console.warn('HubSpot API key not found. HubSpot sync disabled.');
    }
  }
  
  /**
   * Check if HubSpot sync is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }
  
  /**
   * Sync a project to HubSpot as a Deal
   * Uses project_id as external ID for idempotency
   */
  async syncProject(project: Project): Promise<void> {
    if (!this.isEnabled()) {
      console.log('HubSpot sync disabled, skipping project sync');
      return;
    }
    
    try {
      const dealProperties = {
        dealname: project.project_name,
        dealstage: this.mapProjectStatusToDealStage(project.project_status),
        amount: project.priority_score?.toString() || '0',
        closedate: project.awarded_date ? new Date(project.awarded_date).getTime().toString() : undefined,
        // Custom properties
        project_id: project.project_id,
        source_platform: project.source_platform,
        is_multi_package: project.is_multi_package ? 'true' : 'false',
        painting_package_status: project.painting_package_status,
        call_suppressed: project.call_suppressed ? 'true' : 'false',
        last_contacted_at: project.last_contacted_at ? new Date(project.last_contacted_at).getTime().toString() : undefined,
        next_call_eligible_at: project.next_call_eligible_at ? new Date(project.next_call_eligible_at).getTime().toString() : undefined,
        // Address fields
        address: this.formatAddress(project),
      };
      
      // Remove undefined values
      Object.keys(dealProperties).forEach(key => {
        if (dealProperties[key as keyof typeof dealProperties] === undefined) {
          delete dealProperties[key as keyof typeof dealProperties];
        }
      });
      
      // Upsert deal using project_id as external ID
      await this.client!.crm.deals.basicApi.update(
        project.project_id,
        { properties: dealProperties },
        undefined,
        'project_id' // Use project_id as external ID
      );
      
      console.log(`Synced project to HubSpot: ${project.project_id}`);
    } catch (error: any) {
      // If deal doesn't exist, create it
      if (error.code === 404) {
        try {
          const dealProperties = {
            dealname: project.project_name,
            dealstage: this.mapProjectStatusToDealStage(project.project_status),
            amount: project.priority_score?.toString() || '0',
            project_id: project.project_id,
            source_platform: project.source_platform,
            is_multi_package: project.is_multi_package ? 'true' : 'false',
            painting_package_status: project.painting_package_status,
            call_suppressed: project.call_suppressed ? 'true' : 'false',
          };
          
          await this.client!.crm.deals.basicApi.create({
            properties: dealProperties,
            associations: [],
          });
          
          console.log(`Created new deal in HubSpot: ${project.project_id}`);
        } catch (createError) {
          console.error(`Error creating deal in HubSpot:`, createError);
          throw createError;
        }
      } else {
        console.error(`Error syncing project to HubSpot:`, error);
        throw error;
      }
    }
  }
  
  /**
   * Sync a contact to HubSpot
   * Uses contact_id as external ID if available, otherwise uses phone/email for deduplication
   */
  async syncContact(contact: Contact): Promise<void> {
    if (!this.isEnabled()) {
      console.log('HubSpot sync disabled, skipping contact sync');
      return;
    }
    
    try {
      const contactProperties: any = {
        firstname: this.extractFirstName(contact.name),
        lastname: this.extractLastName(contact.name),
        phone: contact.phone,
        email: contact.email,
        // Custom properties
        global_role: contact.global_role,
        authority_level: contact.authority_level,
        preferred_channel: contact.preferred_channel,
        do_not_call: contact.do_not_call ? 'true' : 'false',
      };
      
      // Add external ID if available
      if (contact.contact_id) {
        contactProperties.contact_id = contact.contact_id;
      }
      
      // Remove undefined values
      Object.keys(contactProperties).forEach(key => {
        if (contactProperties[key] === undefined) {
          delete contactProperties[key];
        }
      });
      
      // Try to find existing contact by external ID, phone, or email
      let hubspotContactId: string | null = null;
      
      if (contact.contact_id) {
        try {
          const result = await this.client!.crm.contacts.basicApi.getById(
            contact.contact_id,
            undefined,
            undefined,
            'contact_id'
          );
          hubspotContactId = result.id;
        } catch (e) {
          // Contact not found by external ID, continue
        }
      }
      
      if (!hubspotContactId && contact.email) {
        try {
          const result = await this.client!.crm.contacts.basicApi.getByEmail(contact.email);
          hubspotContactId = result.id;
        } catch (e) {
          // Contact not found by email, continue
        }
      }
      
      if (hubspotContactId) {
        // Update existing contact
        await this.client!.crm.contacts.basicApi.update(
          hubspotContactId,
          { properties: contactProperties }
        );
        console.log(`Updated contact in HubSpot: ${hubspotContactId}`);
      } else {
        // Create new contact
        await this.client!.crm.contacts.basicApi.create({
          properties: contactProperties,
        });
        console.log(`Created new contact in HubSpot`);
      }
    } catch (error) {
      console.error(`Error syncing contact to HubSpot:`, error);
      throw error;
    }
  }
  
  /**
   * Sync project-contact association to HubSpot
   * Associates a contact with a deal
   */
  async syncProjectContact(
    projectId: string,
    contactId: string,
    roleForProject?: string
  ): Promise<void> {
    if (!this.isEnabled()) {
      console.log('HubSpot sync disabled, skipping project-contact sync');
      return;
    }
    
    try {
      // Get HubSpot deal ID by project_id
      const deal = await this.client!.crm.deals.basicApi.getById(
        projectId,
        undefined,
        undefined,
        'project_id'
      );
      
      // Get HubSpot contact ID (try by contact_id, then email, then phone)
      // Note: This is simplified - in production you'd want to store HubSpot IDs
      const contact = await this.client!.crm.contacts.basicApi.getById(contactId);
      
      // Associate contact with deal
      await this.client!.crm.deals.associationsApi.create(
        deal.id,
        'contacts',
        contact.id,
        [{
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: 3, // Deal to Contact association
        }]
      );
      
      console.log(`Associated contact ${contactId} with project ${projectId} in HubSpot`);
    } catch (error) {
      console.error(`Error syncing project-contact association to HubSpot:`, error);
      // Don't throw - association errors are non-critical
    }
  }
  
  /**
   * Sync call session outcome to HubSpot
   * Creates a note or activity on the deal
   */
  async syncCallSession(callSession: CallSession): Promise<void> {
    if (!this.isEnabled()) {
      console.log('HubSpot sync disabled, skipping call session sync');
      return;
    }
    
    try {
      // Get HubSpot deal ID by project_id
      const deal = await this.client!.crm.deals.basicApi.getById(
        callSession.project_id,
        undefined,
        undefined,
        'project_id'
      );
      
      // Create a note with call outcome
      const noteBody = `
Call Type: ${callSession.call_type}
Status: ${callSession.call_status}
Outcome: ${callSession.outcome || 'N/A'}
Sentiment: ${callSession.sentiment || 'N/A'}
${callSession.escalated ? `Escalated: ${callSession.escalation_reason}` : ''}
${callSession.transcript ? `Transcript: ${callSession.transcript.substring(0, 500)}` : ''}
      `.trim();
      
      await this.client!.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: new Date(callSession.started_at || new Date()).getTime().toString(),
        },
        associations: [{
          to: { id: deal.id },
          types: [{
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 214, // Note to Deal association
          }],
        }],
      });
      
      console.log(`Synced call session to HubSpot: ${callSession.id}`);
    } catch (error) {
      console.error(`Error syncing call session to HubSpot:`, error);
      // Don't throw - sync errors are non-critical
    }
  }
  
  /**
   * Sync terminal state to HubSpot
   * Updates deal/contact properties
   */
  async syncTerminalSession(terminalSession: TerminalSession): Promise<void> {
    if (!this.isEnabled()) {
      console.log('HubSpot sync disabled, skipping terminal session sync');
      return;
    }
    
    try {
      if (terminalSession.scope === 'project' && terminalSession.project_id) {
        // Update deal with terminal state
        await this.client!.crm.deals.basicApi.update(
          terminalSession.project_id,
          {
            properties: {
              terminal_state: 'true',
              terminal_reason: terminalSession.reason,
            },
          },
          undefined,
          'project_id'
        );
      } else if (terminalSession.scope === 'contact' && terminalSession.contact_id) {
        // Update contact with terminal state
        await this.client!.crm.contacts.basicApi.update(
          terminalSession.contact_id,
          {
            properties: {
              terminal_state: 'true',
              terminal_reason: terminalSession.reason,
            },
          }
        );
      }
      
      console.log(`Synced terminal session to HubSpot`);
    } catch (error) {
      console.error(`Error syncing terminal session to HubSpot:`, error);
      // Don't throw - sync errors are non-critical
    }
  }
  
  /**
   * Helper: Map project status to HubSpot deal stage
   */
  private mapProjectStatusToDealStage(status?: string): string {
    // Map your project statuses to HubSpot deal stages
    // This is a placeholder - adjust based on your HubSpot pipeline
    const statusMap: Record<string, string> = {
      'awarded': 'closedwon',
      'completed': 'closedwon',
      'in_progress': 'qualifiedtobuy',
      'pending': 'appointmentscheduled',
    };
    
    return statusMap[status || ''] || 'appointmentscheduled';
  }
  
  /**
   * Helper: Format address for HubSpot
   */
  private formatAddress(project: Project): string {
    const parts = [
      project.address_line1,
      project.address_line2,
      project.city,
      project.state,
      project.zip_code,
    ].filter(Boolean);
    
    return parts.join(', ');
  }
  
  /**
   * Helper: Extract first name from full name
   */
  private extractFirstName(fullName: string): string {
    return fullName.split(' ')[0] || fullName;
  }
  
  /**
   * Helper: Extract last name from full name
   */
  private extractLastName(fullName: string): string {
    const parts = fullName.split(' ');
    return parts.length > 1 ? parts.slice(1).join(' ') : '';
  }
}
