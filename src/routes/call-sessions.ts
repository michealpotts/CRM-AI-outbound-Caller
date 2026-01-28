import { Router, Request, Response } from 'express';
import { CallSessionService } from '../services/CallSessionService';
import { z } from 'zod';

const router = Router();
const callSessionService = new CallSessionService();

/**
 * Request validation schemas
 */
const CallSessionSchema = z.object({
  call_session_id: z.string().optional(),
  project_id: z.string(), // External project_id
  contact_id: z.string().optional(), // Internal UUID
  call_type: z.enum(['ai', 'human']),
  call_status: z.string(),
  detected_role: z.string().optional(),
  role_confidence: z.number().min(0).max(1).optional(),
  outcome: z.string().optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  escalated: z.boolean().optional(),
  escalation_reason: z.string().optional(),
  transcript: z.string().optional(),
  recording_url: z.string().url().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});

/**
 * POST /api/call-sessions
 * Create call session (idempotent)
 * 
 * Idempotency: Uses call_session_id as unique key
 * - If call_session_id provided and exists, returns existing session
 * - Otherwise, creates new session
 * - All sessions are append-only (never deleted)
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const sessionData = CallSessionSchema.parse(req.body);
    const session = await callSessionService.createCallSession(sessionData);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    } else {
      console.error('Error creating call session:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

/**
 * PATCH /api/call-sessions/:session_id
 * Update call session (for ongoing calls)
 */
router.patch('/:session_id', async (req: Request, res: Response) => {
  try {
    const { session_id } = req.params;
    const updates = CallSessionSchema.partial().parse(req.body);
    const session = await callSessionService.updateCallSession(session_id, updates);
    res.status(200).json({ success: true, data: session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    } else {
      console.error('Error updating call session:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

/**
 * GET /api/call-sessions/:session_id
 * Get call session by ID
 */
router.get('/:session_id', async (req: Request, res: Response) => {
  try {
    const { session_id } = req.params;
    const session = await callSessionService.getCallSessionById(session_id);
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Call session not found' });
    } else {
      res.status(200).json({ success: true, data: session });
    }
  } catch (error) {
    console.error('Error fetching call session:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/call-sessions/project/:project_id
 * Get all call sessions for a project
 */
router.get('/project/:project_id', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.params;
    const sessions = await callSessionService.getCallSessionsByProject(project_id);
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    console.error('Error fetching call sessions:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
