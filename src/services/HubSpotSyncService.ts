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
    // HubSpot now uses access tokens (private app tokens)
    // Format: pat-ap1-xxxxx-xxxxx-xxxxx-xxxxx
    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
    if (accessToken) {
      this.client = new Client({ accessToken });
      this.enabled = true;
      console.log('HubSpot sync enabled with access token');
    } else {
      console.warn('HubSpot access token not found. HubSpot sync disabled.');
      console.warn('Set HUBSPOT_ACCESS_TOKEN in .env to enable HubSpot sync');
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
      const dealProperties: Record<string, string> = {
        dealname: project.name,
        dealstage: this.mapProjectStatusToDealStage((project as any).project_status),
        amount: (project as any).priority_score?.toString() || '0',
        project_id: project.project_id,
        call_suppressed: project.call_suppressed ? 'true' : 'false',
      };
      if (project.awarded_date) {
        dealProperties.closedate = new Date(project.awarded_date).getTime().toString();
      }
      if ((project as any).category) {
        dealProperties.category = (project as any).category;
      }
      if (project.last_contacted_at) {
        dealProperties.last_contacted_at = new Date(project.last_contacted_at).getTime().toString();
      }
      if (project.next_call_eligible_at) {
        dealProperties.next_call_eligible_at = new Date(project.next_call_eligible_at).getTime().toString();
      }
      const address = this.formatAddress(project);
      if (address) {
        dealProperties.address = address;
      }
      
      // Try to update deal using project_id as external ID
      // Note: HubSpot API v3+ uses different methods, we'll search first then update/create
      try {
        // Search for existing deal by project_id custom property
        const searchResult = await this.client!.crm.deals.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'project_id',
              operator: 'EQ',
              value: project.project_id,
            }],
          }],
          properties: ['id'],
          limit: 1,
          sorts: [],
          after: 0,
        });
        
        if (searchResult.results && searchResult.results.length > 0) {
          // Update existing deal
          await this.client!.crm.deals.basicApi.update(
            searchResult.results[0].id,
            { properties: dealProperties }
          );
        } else {
          throw new Error('Deal not found');
        }
      } catch (error: any) {
        // If not found or error, create new deal
        throw new Error('CREATE_NEW');
      }
      
      console.log(`Synced project to HubSpot: ${project.project_id}`);
    } catch (error: any) {
      // If deal doesn't exist, create it
      if (error.code === 404 || error.message === 'CREATE_NEW') {
        try {
          const dealProperties: Record<string, string> = {
            dealname: project.name,
            dealstage: this.mapProjectStatusToDealStage((project as any).project_status),
            amount: (project as any).priority_score?.toString() || '0',
            project_id: project.project_id,
            call_suppressed: project.call_suppressed ? 'true' : 'false',
          };
          if ((project as any).category) {
            dealProperties.category = (project as any).category;
          }
          
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
        phone: contact.phonenumber,
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
      
      // Try to find existing contact by external ID, phonenumber, or email
      let hubspotContactId: string | null = null;
      
      if (contact.contact_id) {
        try {
          // Search by custom property (contact_id)
          const searchResult = await this.client!.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'contact_id',
                operator: 'EQ',
                value: contact.contact_id,
              }],
            }],
            properties: ['id'],
            limit: 1,
            sorts: [],
            after: 0,
          });
          if (searchResult.results && searchResult.results.length > 0) {
            hubspotContactId = searchResult.results[0].id;
          }
        } catch (e) {
          // Contact not found by external ID, continue
        }
      }
      
      if (!hubspotContactId && contact.email) {
        try {
          // Search by email
          const searchResult = await this.client!.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{
                propertyName: 'email',
                operator: 'EQ',
                value: contact.email,
              }],
            }],
            properties: ['id'],
            limit: 1,
            sorts: [],
            after: 0,
          });
          if (searchResult.results && searchResult.results.length > 0) {
            hubspotContactId = searchResult.results[0].id;
          }
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
          associations: [],
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
      // Get HubSpot deal ID by project_id (search by custom property)
      const dealSearch = await this.client!.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'project_id',
            operator: 'EQ',
            value: projectId,
          }],
        }],
        properties: ['id'],
        limit: 1,
        sorts: [],
        after: 0,
      });
      
      if (!dealSearch.results || dealSearch.results.length === 0) {
        console.warn(`Deal not found for project_id: ${projectId}`);
        return;
      }
      
      const dealId = dealSearch.results[0].id;
      
      // Get HubSpot contact ID by internal UUID
      const contact = await this.client!.crm.contacts.basicApi.getById(contactId);
      
      // Associate contact with deal using batch API
      await this.client!.crm.deals.batchApi.create({
        inputs: [{
          from: { id: dealId },
          to: { id: contact.id },
          type: 'deal_to_contact',
        }],
      } as any);
      
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
      // Get HubSpot deal ID by project_id (search by custom property)
      const dealSearch = await this.client!.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'project_id',
            operator: 'EQ',
            value: callSession.project_id,
          }],
        }],
        properties: ['id'],
        limit: 1,
        sorts: [],
        after: 0,
      });
      
      if (!dealSearch.results || dealSearch.results.length === 0) {
        console.warn(`Deal not found for project_id: ${callSession.project_id}`);
        return;
      }
      
      const dealId = dealSearch.results[0].id;
      
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
          to: { id: dealId },
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
        // Find deal by project_id and update with terminal state
        const dealSearch = await this.client!.crm.deals.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'project_id',
              operator: 'EQ',
              value: terminalSession.project_id,
            }],
          }],
          properties: ['id'],
          limit: 1,
          sorts: [],
          after: 0,
        });
        
        if (dealSearch.results && dealSearch.results.length > 0) {
          await this.client!.crm.deals.basicApi.update(
            dealSearch.results[0].id,
            {
              properties: {
                terminal_state: 'true',
                terminal_reason: terminalSession.reason,
              },
            }
          );
        }
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
      project.address,
      project.suburb,
      project.state,
      project.postcode,
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
