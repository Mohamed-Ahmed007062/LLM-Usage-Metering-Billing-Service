import { Database } from 'better-sqlite3';
import { JobRepository, BackgroundJob } from '../repositories/job.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { StripeService } from './stripe.service.js';

export class BackgroundWorkerService {
  private jobRepo: JobRepository;
  private usageRepo: UsageRepository;
  private stripeService: StripeService;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private db: Database, stripeService?: StripeService) {
    this.jobRepo = new JobRepository(db);
    this.usageRepo = new UsageRepository(db);
    this.stripeService = stripeService || new StripeService(db);
  }

  async processJob(job: BackgroundJob): Promise<boolean> {
    this.jobRepo.markProcessing(job.id);
    const payload = JSON.parse(job.payload);

    try {
      switch (job.job_type) {
        case 'usage_alert': {
          const { tenantId, thresholdPercent, billingPeriod, usage, limits } = payload;
          // Deliver alert notification off the HTTP request path
          console.log(
            `[BACKGROUND JOB: ALERT] Tenant ${tenantId} exceeded ${thresholdPercent}% quota in ${billingPeriod}. Usage:`,
            usage,
            'Limits:',
            limits
          );

          // Record alert in database to guarantee deduplication per billing period
          this.usageRepo.recordAlertSent(tenantId, thresholdPercent, billingPeriod);
          this.jobRepo.markCompleted(job.id);
          return true;
        }

        case 'stripe_reconcile': {
          console.log('[BACKGROUND JOB: RECONCILIATION] Starting subscription reconciliation against Stripe...');
          const result = await this.stripeService.reconcileTenantSubscriptions();
          console.log(
            `[BACKGROUND JOB: RECONCILIATION] Finished: ${result.checked} checked, ${result.updated} updated, ${result.errors.length} errors.`
          );
          this.jobRepo.markCompleted(job.id);
          return true;
        }

        default:
          throw new Error(`Unknown job type: ${job.job_type}`);
      }
    } catch (err: any) {
      console.error(`[BACKGROUND JOB FAILED] Job ID: ${job.id}, Type: ${job.job_type}, Error: ${err.message}`);
      this.jobRepo.markFailed(job.id, err.message);

      if (job.retry_count + 1 >= job.max_retries) {
        console.error(`[CRITICAL FAILURE ALERT] Job ID ${job.id} exhausted all ${job.max_retries} retries! Manual intervention required.`);
      }
      return false;
    }
  }

  async processPendingJobsOnce(): Promise<number> {
    const jobs = this.jobRepo.fetchNextPendingJobs(10);
    let processed = 0;
    for (const job of jobs) {
      await this.processJob(job);
      processed++;
    }
    return processed;
  }

  start(intervalMs = 3000): void {
    if (this.intervalTimer) return;

    this.intervalTimer = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.processPendingJobsOnce();
      } catch (err) {
        console.error('[BACKGROUND WORKER ERROR]', err);
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);

    // Prevent blocking process exit in tests
    if (this.intervalTimer.unref) {
      this.intervalTimer.unref();
    }
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}
