import { Router, Request, Response } from 'express';
import { CallEligibilityService } from '../services/CallEligibilityService';

const router = Router();
const eligibilityService = new CallEligibilityService();

/**
 * GET /api/eligible-calls
 * Fetch eligible calls for outbound calling
 * 
 * Returns project-contact pairs that are eligible for calling based on:
 * - Suppression flags
 * - Cooldown periods
 * - Terminal sessions
 * - Call frequency limits (fatigue)
 * 
 * Query params:
 * - limit: Maximum number of results (default: 100)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const eligibleCalls = await eligibilityService.getEligibleCalls(limit);
    res.status(200).json({ success: true, data: eligibleCalls, count: eligibleCalls.length });
  } catch (error) {
    console.error('Error fetching eligible calls:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/eligible-calls/check/project/:project_id
 * Check if a project is eligible for calling
 */
router.get('/check/project/:project_id', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.params;
    const result = await eligibilityService.isProjectEligible(project_id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error checking project eligibility:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/eligible-calls/check/contact/:contact_id
 * Check if a contact is eligible for calling
 */
router.get('/check/contact/:contact_id', async (req: Request, res: Response) => {
  try {
    const { contact_id } = req.params;
    const project_id = req.query.project_id as string | undefined;
    const result = await eligibilityService.isContactEligible(contact_id, project_id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error checking contact eligibility:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/eligible-calls/check/project/:project_id/contact/:contact_id
 * Check if a project-contact combination is eligible for calling
 */
router.get('/check/project/:project_id/contact/:contact_id', async (req: Request, res: Response) => {
  try {
    const { project_id, contact_id } = req.params;
    const result = await eligibilityService.isProjectContactEligible(project_id, contact_id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error checking project-contact eligibility:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
