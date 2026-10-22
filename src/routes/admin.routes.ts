import { Router, Request, Response } from 'express';
import { Database } from 'better-sqlite3';
import { JobRepository } from '../repositories/job.repository.js';
import { BackgroundWorkerService } from '../services/background.service.js';

export function createAdminRouter(
  db: Database,
  backgroundWorker?: BackgroundWorkerService
): Router {
  const router = Router();
  const jobRepo = new JobRepository(db);

  router.get('/health', (req: Request, res: Response): void => {
    res.status(200).json({
      status: 'healthy',
      service: 'llm-usage-metering-and-billing-engine',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/admin/reconcile', async (req: Request, res: Response): Promise<void> => {
    const job = jobRepo.createJob('stripe_reconcile', { triggeredBy: 'manual_admin_request' });
    if (backgroundWorker) {
      await backgroundWorker.processPendingJobsOnce();
    }
    res.status(202).json({
      success: true,
      message: 'Subscription reconciliation job scheduled and processed.',
      job_id: job.id,
    });
  });

  router.get('/admin/jobs', (req: Request, res: Response): void => {
    const jobs = jobRepo.listJobs();
    res.json({ jobs });
  });

  return router;
}
