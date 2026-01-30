import { query, getClient } from '../db/connection';
import { Contact } from '../types';

/**
 * ContactService
 * Handles all contact-related operations with deduplication
 * 
 * Deduplication Strategy:
 * - Primary: Use external contact_id if available (idempotent upsert)
 * - Secondary: Natural key deduplication by phone or email
 * - If phone/email matches existing contact, update that contact
 * - This prevents duplicate contacts from multiple data sources
 */
export class ContactService {
  /**
   * Upsert a contact (idempotent with deduplication)
   * 
   * Strategy:
   * 1. If contact_id provided and exists, update that contact
   * 2. If contact_id not provided or doesn't exist:
   *    - Check for existing contact by phone (if phone provided)
   *    - Check for existing contact by email (if email provided)
   *    - If match found, update that contact
   *    - If no match, create new contact
   */
  async upsertContact(contact: Contact): Promise<Contact> {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      let existingContactId: string | null = null;
      
      // Strategy 1: Check by external contact_id if provided
      if (contact.contact_id) {
        const result = await client.query(
          'SELECT id FROM contacts WHERE contact_id = $1',
          [contact.contact_id]
        );
        if (result.rows.length > 0) {
          existingContactId = result.rows[0].id;
        }
      }
      
      // Strategy 2: Natural key deduplication (if not found by contact_id)
      if (!existingContactId) {
        if (contact.phonenumber) {
          const phoneResult = await client.query(
            'SELECT id FROM contacts WHERE phonenumber = $1',
            [contact.phonenumber]
          );
          if (phoneResult.rows.length > 0) {
            existingContactId = phoneResult.rows[0].id;
          }
        }
        if (!existingContactId && contact.email) {
          const emailResult = await client.query(
            'SELECT id FROM contacts WHERE email = $1',
            [contact.email]
          );
          if (emailResult.rows.length > 0) {
            existingContactId = emailResult.rows[0].id;
          }
        }
      }
      
      if (existingContactId) {
        // Update existing contact
        const updateFields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;
        
        const fieldsToUpdate: (keyof Contact)[] = [
          'contact_id', 'name', 'email', 'companyname', 'phonenumber', 'global_role',
          'authority_level', 'preferred_channel', 'do_not_call', 'last_ai_contact'
        ];
        
        for (const field of fieldsToUpdate) {
          if (contact[field] !== undefined) {
            updateFields.push(`${field} = $${paramIndex}`);
            values.push(contact[field]);
            paramIndex++;
          }
        }
        
        values.push(existingContactId);
        
        const updateQuery = `
          UPDATE contacts
          SET ${updateFields.join(', ')}
          WHERE id = $${paramIndex}
          RETURNING *
        `;
        
        const result = await client.query(updateQuery, values);
        await client.query('COMMIT');
        return this.mapRowToContact(result.rows[0]);
      } else {
        // Insert new contact
        const insertQuery = `
          INSERT INTO contacts (
            contact_id, name, email, companyname, phonenumber, global_role,
            authority_level, preferred_channel, do_not_call, last_ai_contact
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )
          RETURNING *
        `;
        
        const result = await client.query(insertQuery, [
          contact.contact_id || null,
          contact.name,
          contact.email || null,
          contact.companyname || null,
          contact.phonenumber || null,
          contact.global_role || null,
          contact.authority_level || null,
          contact.preferred_channel || null,
          contact.do_not_call || false,
          contact.last_ai_contact || null,
        ]);
        
        await client.query('COMMIT');
        return this.mapRowToContact(result.rows[0]);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get contact by external contact_id
   */
  async getContactByExternalId(contactId: string): Promise<Contact | null> {
    const result = await query(
      'SELECT * FROM contacts WHERE contact_id = $1',
      [contactId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToContact(result.rows[0]);
  }
  
  /**
   * Get contact by internal UUID
   */
  async getContactById(id: string): Promise<Contact | null> {
    const result = await query(
      'SELECT * FROM contacts WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToContact(result.rows[0]);
  }
  
  /**
   * Get contact by phone (for deduplication)
   */
  async getContactByPhone(phonenumber: string): Promise<Contact | null> {
    const result = await query(
      'SELECT * FROM contacts WHERE phonenumber = $1',
      [phonenumber]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToContact(result.rows[0]);
  }
  
  /**
   * Get contact by email (for deduplication)
   */
  async getContactByEmail(email: string): Promise<Contact | null> {
    const result = await query(
      'SELECT * FROM contacts WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapRowToContact(result.rows[0]);
  }
  
  /**
   * Map database row to Contact type
   */
  private mapRowToContact(row: any): Contact {
    return {
      id: row.id,
      contact_id: row.contact_id,
      name: row.name,
      email: row.email,
      companyname: row.companyname,
      phonenumber: row.phonenumber,
      global_role: row.global_role,
      authority_level: row.authority_level,
      preferred_channel: row.preferred_channel,
      do_not_call: row.do_not_call,
      last_ai_contact: row.last_ai_contact,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
