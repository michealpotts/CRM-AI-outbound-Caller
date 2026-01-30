import { Router, Request, Response } from 'express';
import { ProjectService } from '../services/ProjectService';
import { z } from 'zod';

const router = Router();
const projectService = new ProjectService();

/**
 * Request validation schemas
 */
const ProjectSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  address: z.string().optional(),
  suburb: z.string().optional(),
  postcode: z.string().optional(),
  state: z.string().optional(),
  category: z.string().optional(),
  awarded_date: z.string().optional(),
  distance: z.number().optional(),
  budget: z.string().optional(),
  quotes_due_date: z.string().optional(),
  country: z.string().optional(),
  last_contacted_at: z.string().optional(),
  next_call_eligible_at: z.string().optional(),
  call_suppressed: z.boolean().optional(),
});

/**
 * POST /api/projects
 * Ingest normalized project data (idempotent)
 * 
 * Idempotency: Uses project_id as unique key
 * - If project_id exists, updates the project
 * - If project_id doesn't exist, creates new project
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const projectData = ProjectSchema.parse(req.body);
    const project = await projectService.upsertProject(projectData);
    res.status(200).json({ success: true, data: project });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    } else {
      console.error('Error ingesting project:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
});

/**
 * GET /api/projects/:project_id
 * Get project by external project_id
 */
router.get('/:project_id', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.params;
    const project = await projectService.getProjectByExternalId(project_id);
    
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(200).json({ success: true, data: project });
    }
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PATCH /api/projects/:project_id/suppression
 * Update call suppression status
 */
router.patch('/:project_id/suppression', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.params;
    const { suppressed } = req.body;
    
    if (typeof suppressed !== 'boolean') {
      res.status(400).json({ success: false, error: 'suppressed must be a boolean' });
      return;
    }
    
    await projectService.updateCallSuppression(project_id, suppressed);
    res.status(200).json({ success: true, message: 'Suppression status updated' });
  } catch (error) {
    console.error('Error updating suppression:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
