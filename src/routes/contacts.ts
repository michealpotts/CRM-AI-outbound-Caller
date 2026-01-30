import { Router, Request, Response } from 'express';
import { ContactService } from '../services/ContactService';
import { z } from 'zod';

const router = Router();
const contactService = new ContactService();

/**
 * Request validation schemas
 */
const ContactSchema = z.object({
  contact_id: z.string().optional(),
  name: z.string(),
  email: z.string().email().optional(),
  companyname: z.string().optional(),
  phonenumber: z.string().optional(),
  global_role: z.string().optional(),
  authority_level: z.string().optional(),
  preferred_channel: z.enum(['phone', 'email', 'sms']).optional(),
  do_not_call: z.boolean().optional(),
  last_ai_contact: z.string().optional(),
});

/**
 * POST /api/contacts
 * Upsert contact (idempotent with deduplication)
 * 
 * Idempotency Strategy:
 * 1. If contact_id provided and exists, updates that contact
 * 2. If contact_id not provided or doesn't exist:
 *    - Checks for existing contact by phone (if provided)
 *    - Checks for existing contact by email (if provided)
 *    - If match found, updates that contact
 *    - If no match, creates new contact
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const contactData = ContactSchema.parse(req.body);
    const contact = await contactService.upsertContact(contactData);
    res.status(200).json({ success: true, data: contact });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    } else {
      console.error('Error upserting contact:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

/**
 * GET /api/contacts/:contact_id
 * Get contact by internal UUID or external contact_id
 */
router.get('/:contact_id', async (req: Request, res: Response) => {
  try {
    const { contact_id } = req.params;
    
    // Try as external ID first
    let contact = await contactService.getContactByExternalId(contact_id);
    
    // If not found, try as internal UUID
    if (!contact) {
      contact = await contactService.getContactById(contact_id);
    }
    
    if (!contact) {
      res.status(404).json({ success: false, error: 'Contact not found' });
    } else {
      res.status(200).json({ success: true, data: contact });
    }
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
