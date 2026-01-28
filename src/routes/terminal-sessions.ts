import { Router, Request, Response } from 'express';
import { TerminalService } from '../services/TerminalService';
import { z } from 'zod';

const router = Router();
const terminalService = new TerminalService();

/**
 * Request validation schemas
 */
const TerminalSessionSchema = z.object({
  terminal_id: z.string().optional(),
  scope: z.enum(['project', 'contact', 'global']),
  project_id: z.string().optional(), // External project_id for project scope
  contact_id: z.string().optional(), // Internal UUID for contact scope
  reason: z.string(),
  created_by: z.string().optional(),
  expires_at: z.string().optional(),
  override_allowed: z.boolean().optional(),
}).refine(
  (data) => {
    if (data.scope === 'project' && !data.project_id) return false;
    if (data.scope === 'contact' && !data.contact_id) return false;
    if (data.scope === 'global' && (data.project_id || data.contact_id)) return false;
    return true;
  },
  { message: 'Scope must match provided IDs' }
);

/**
 * POST /api/terminal-sessions
 * Create terminal session (idempotent)
 * 
 * Idempotency: Uses terminal_id as unique key
 * - If terminal_id provided and exists, returns existing session
 * - Otherwise, creates new terminal session
 * 
 * Terminal sessions prevent calling when active (not expired)
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const sessionData = TerminalSessionSchema.parse(req.body);
    const session = await terminalService.createTerminalSession(sessionData);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    } else {
      console.error('Error creating terminal session:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

/**
 * GET /api/terminal-sessions/:session_id
 * Get terminal session by ID
 */
router.get('/:session_id', async (req: Request, res: Response) => {
  try {
    const { session_id } = req.params;
    const session = await terminalService.getTerminalSessionById(session_id);
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Terminal session not found' });
    } else {
      res.status(200).json({ success: true, data: session });
    }
  } catch (error) {
    console.error('Error fetching terminal session:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /api/terminal-sessions/:session_id
 * Remove terminal session (only if override_allowed is true)
 */
router.delete('/:session_id', async (req: Request, res: Response) => {
  try {
    const { session_id } = req.params;
    const removed = await terminalService.removeTerminalSession(session_id);
    
    if (removed) {
      res.status(200).json({ success: true, message: 'Terminal session removed' });
    } else {
      res.status(404).json({ success: false, error: 'Terminal session not found' });
    }
  } catch (error: any) {
    if (error.message.includes('cannot be removed')) {
      res.status(403).json({ success: false, error: error.message });
    } else {
      console.error('Error removing terminal session:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

export default router;
