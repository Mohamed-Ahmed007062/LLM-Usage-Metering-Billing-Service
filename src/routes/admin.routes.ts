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

  router.get('/', (req: Request, res: Response): void => {
    res.status(200).json({
      service: 'LLM Usage Metering & Billing Engine API',
      status: 'running',
      version: '1.0.0',
      description: 'Production-ready billing service with idempotent metering, quota enforcement, and Stripe sync.',
      documentation: 'See README.md for full endpoint contracts and curl examples.',
      quick_browser_links: {
        health_check: '/health',
        free_tenant_usage: '/usage?tenant_id=tenant_free_demo',
        pro_tenant_usage: '/usage?tenant_id=tenant_pro_demo',
        boundary_tenant_usage: '/usage?tenant_id=tenant_quota_boundary',
        past_due_tenant_usage: '/usage?tenant_id=tenant_past_due',
      },
      api_endpoints: {
        billable_generate: {
          method: 'POST',
          path: '/generate',
          description: 'Record a billable action with idempotency and token simulation',
          required_headers: ['X-Tenant-ID', 'Idempotency-Key'],
          sample_body: {
            prompt: 'Explain general relativity',
            simulate_tokens: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 250,
              reasoning_tokens: 80,
            },
          },
        },
        read_usage: {
          method: 'GET',
          path: '/usage?tenant_id=<id>',
          description: 'Aggregated monthly usage, quota limits, and integer micro-unit costs',
        },
        stripe_checkout: {
          method: 'POST',
          path: '/checkout/session',
          description: 'Create a Stripe Checkout Session to upgrade Free to Pro',
          sample_body: { tenant_id: 'tenant_free_demo' },
        },
        stripe_webhook: {
          method: 'POST',
          path: '/webhooks/stripe',
          description: 'HMAC signature-verified webhook handler for Stripe events',
        },
      },
    });
  });

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
