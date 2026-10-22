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
    // If opened in a web browser, render a clean interactive dashboard
    if (req.accepts('html') && !req.xhr && !req.headers['accept']?.includes('application/json')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Usage Metering & Billing Engine</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --code-bg: #0b1120;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2rem 1rem;
      line-height: 1.5;
    }
    .container { max-width: 900px; margin: 0 auto; }
    header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; }
    h1 { font-size: 1.8rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(34, 197, 94, 0.15);
      color: var(--green);
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 0.8rem;
    }
    .badge-dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    h2 { font-size: 1.2rem; color: var(--accent); margin-bottom: 1rem; }
    p { color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1rem; }
    .link-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .api-link {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 0.75rem 1rem;
      border-radius: 8px;
      color: #fff;
      text-decoration: none;
      transition: all 0.2s;
    }
    .api-link:hover {
      background: rgba(56, 189, 248, 0.1);
      border-color: var(--accent);
      transform: translateX(4px);
    }
    .method {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      margin-right: 0.5rem;
    }
    .method-get { background: #0284c7; color: #fff; }
    .method-post { background: #16a34a; color: #fff; }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge"><div class="badge-dot"></div> System Operational & Ready</div>
      <h1>Usage Metering & Billing Engine</h1>
      <p>Idempotent metering, honest quota boundaries, integer AI token money math, and Stripe sync.</p>
    </header>

    <div class="card">
      <h2>Interactive Browser Endpoints (Click to inspect live)</h2>
      <div class="link-list">
        <a class="api-link" href="/health" target="_blank">
          <span><span class="method method-get">GET</span> /health</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">System health & uptime &rarr;</span>
        </a>
        <a class="api-link" href="/usage?tenant_id=tenant_free_demo" target="_blank">
          <span><span class="method method-get">GET</span> /usage?tenant_id=tenant_free_demo</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">Free Tenant limits & rollups &rarr;</span>
        </a>
        <a class="api-link" href="/usage?tenant_id=tenant_pro_demo" target="_blank">
          <span><span class="method method-get">GET</span> /usage?tenant_id=tenant_pro_demo</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">Pro Tenant (50k calls, 5M tokens) &rarr;</span>
        </a>
        <a class="api-link" href="/usage?tenant_id=tenant_quota_boundary" target="_blank">
          <span><span class="method method-get">GET</span> /usage?tenant_id=tenant_quota_boundary</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">Boundary Tenant (999 of 1,000 used) &rarr;</span>
        </a>
        <a class="api-link" href="/admin/jobs" target="_blank">
          <span><span class="method method-get">GET</span> /admin/jobs</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">View background worker job queue &rarr;</span>
        </a>
      </div>
    </div>

    <div class="card">
      <h2>Billable Metering Action (POST /generate)</h2>
      <p>Send billable requests via cURL, PowerShell, or Postman:</p>
      <pre>curl -X POST http://localhost:3000/generate \\
  -H "Content-Type: application/json" \\
  -H "X-Tenant-ID: tenant_free_demo" \\
  -H "Idempotency-Key: my_unique_key_123" \\
  -d '{
    "prompt": "Analyze market trends",
    "simulate_tokens": {
      "input_tokens": 1000,
      "cached_input_tokens": 400,
      "output_tokens": 500,
      "reasoning_tokens": 200
    }
  }'</pre>
    </div>
  </div>
</body>
</html>`);
      return;
    }

    // JSON response for API clients
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
