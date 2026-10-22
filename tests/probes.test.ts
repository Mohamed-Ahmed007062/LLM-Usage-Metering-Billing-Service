import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import Stripe from 'stripe';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/app.js';
import { StripeService } from '../src/services/stripe.service.js';
import { BackgroundWorkerService } from '../src/services/background.service.js';
import { TenantRepository } from '../src/repositories/tenant.repository.js';
import { UsageRepository } from '../src/repositories/usage.repository.js';
import { CONFIG } from '../src/config/index.js';

describe('Submission Acceptance Probes & Requirements Test Suite', () => {
  let db: Database.Database;
  let tenantRepo: TenantRepository;
  let usageRepo: UsageRepository;
  let stripeService: StripeService;
  let backgroundWorker: BackgroundWorkerService;
  let app: any;

  const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_verification_12345';

  function generateValidStripeSignature(rawBody: string, secret: string = TEST_WEBHOOK_SECRET): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${rawBody}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  beforeEach(() => {
    // In-memory database isolated for every test run
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    tenantRepo = new TenantRepository(db);
    usageRepo = new UsageRepository(db);

    // Override webhook secret for tests
    (CONFIG as any).stripeWebhookSecret = TEST_WEBHOOK_SECRET;

    stripeService = new StripeService(db);
    backgroundWorker = new BackgroundWorkerService(db, stripeService);
    app = createApp({ db, stripeService, backgroundWorker });
  });

  afterEach(() => {
    backgroundWorker.stop();
    db.close();
  });

  // =========================================================================
  // PROBE 1: Exactly-Once Metering via Idempotency Key
  // =========================================================================
  describe('PROBE 1: Idempotency & Exactly-Once Metering', () => {
    it('creates exactly one usage event when retried with the same idempotency key, and second response mirrors first', async () => {
      const tenant = tenantRepo.create({
        id: 'probe1_tenant',
        name: 'Idempotency Tester',
        email: 'idemp@example.com',
        plan_id: 'free',
      });

      const idempotencyKey = 'req_idemp_key_probe_1';
      const requestPayload = {
        prompt: 'Calculate quantum gravity equations',
        simulate_tokens: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_tokens: 30,
        },
      };

      // 1. Send first billable request
      const res1 = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', idempotencyKey)
        .send(requestPayload);

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.headers['idempotent-replay']).toBeUndefined();
      const firstEventId = res1.body.event_id;
      expect(firstEventId).toBeDefined();

      // Verify exactly 1 usage event recorded in database
      const countAfterFirst = usageRepo.countByTenant(tenant.id);
      expect(countAfterFirst).toBe(1);

      // 2. Retry the EXACT SAME request with the SAME idempotency key
      const res2 = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', idempotencyKey)
        .send(requestPayload);

      // Second response MUST mirror the first exactly
      expect(res2.status).toBe(res1.status);
      expect(res2.body.event_id).toBe(firstEventId);
      expect(res2.body.cost).toEqual(res1.body.cost);
      expect(res2.body.usage_recorded).toEqual(res1.body.usage_recorded);
      expect(res2.headers['idempotent-replay']).toBe('true');

      // Crucial assertion: Absolutely NO new usage event created (remains exactly 1)
      const countAfterRetry = usageRepo.countByTenant(tenant.id);
      expect(countAfterRetry).toBe(1);
    });
  });

  // =========================================================================
  // PROBE 2: Quota Enforcement & Boundary Honesty
  // =========================================================================
  describe('PROBE 2: Quota Boundary Honesty', () => {
    it('allows the boundary call at exactly limit (1,000) and rejects call 1,001 with HTTP 429', async () => {
      const tenant = tenantRepo.create({
        id: 'probe2_tenant',
        name: 'Boundary Tester',
        email: 'boundary@example.com',
        plan_id: 'free', // 1,000 API calls limit, 100,000 tokens limit
      });

      // Drive tenant to 999 calls
      const insertStmt = db.prepare(`
        INSERT INTO usage_events (
          id, tenant_id, idempotency_key, event_type,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
          total_tokens, cost_micro_units, created_at
        ) VALUES (?, ?, ?, 'ai_generate', 1, 0, 1, 0, 2, 1005, ?)
      `);

      const now = new Date().toISOString();
      for (let i = 1; i <= 999; i++) {
        insertStmt.run(`evt_prefill_${i}`, tenant.id, `key_prefill_${i}`, now);
      }

      // Verify current usage is exactly 999
      const usageBefore = usageRepo.getMonthlyAggregation(
        tenant.id,
        '2000-01-01T00:00:00.000Z',
        '2099-12-31T23:59:59.999Z'
      );
      expect(usageBefore.api_calls).toBe(999);

      // Call 1,000: At exactly boundary -> MUST BE ALLOWED (honest boundary)
      const resBoundary = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', 'key_boundary_call_1000')
        .send({ prompt: 'Boundary call 1000' });

      expect(resBoundary.status).toBe(200);
      expect(resBoundary.body.success).toBe(true);
      expect(resBoundary.body.quota_remaining.api_calls).toBe(0);

      // Call 1,001: Exceeds quota -> MUST BE REJECTED WITH HTTP 429
      const resOverLimit = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', 'key_over_limit_call_1001')
        .send({ prompt: 'Over limit call 1001' });

      expect(resOverLimit.status).toBe(429);
      expect(resOverLimit.headers['retry-after']).toBeDefined();
      expect(resOverLimit.body.error).toBe('QuotaExceeded');
      expect(resOverLimit.body.message).toContain('Monthly API call limit reached');
      expect(resOverLimit.body.resource).toBe('api_calls');
    });

    it('rejects with HTTP 402 Payment Required if tenant subscription is past_due or canceled', async () => {
      const pastDueTenant = tenantRepo.create({
        id: 'probe2_past_due',
        name: 'Past Due Customer',
        email: 'overdue@example.com',
        plan_id: 'free',
        status: 'past_due',
      });

      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', pastDueTenant.id)
        .set('Idempotency-Key', 'key_past_due_req')
        .send({ prompt: 'This will require payment' });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('PaymentRequired');
      expect(res.body.message).toContain('past_due');
    });
  });

  // =========================================================================
  // PROBE 3: Stripe Checkout & Webhook Plan Sync (Free -> Pro)
  // =========================================================================
  describe('PROBE 3: Stripe Subscription Webhook Sync', () => {
    it('flips tenant from Free to Pro via checkout.session.completed webhook and GET /usage reflects new limits', async () => {
      const tenant = tenantRepo.create({
        id: 'probe3_tenant',
        name: 'Upgrading Customer',
        email: 'upgrade@example.com',
        plan_id: 'free',
        status: 'active',
      });

      // 1. Verify initially on Free plan (1,000 API calls, 100k tokens)
      const usageResBefore = await request(app)
        .get('/usage')
        .set('X-Tenant-ID', tenant.id);

      expect(usageResBefore.status).toBe(200);
      expect(usageResBefore.body.plan).toBe('free');
      expect(usageResBefore.body.usage.api_calls.limit).toBe(1000);
      expect(usageResBefore.body.usage.tokens.limit).toBe(100000);

      // 2. Simulate Stripe checkout.session.completed event
      const checkoutSessionEvent = {
        id: 'evt_stripe_checkout_test_3',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session_123',
            client_reference_id: tenant.id,
            customer: 'cus_stripe_probe_3',
            subscription: 'sub_stripe_probe_3',
            metadata: { tenant_id: tenant.id },
          },
        },
      };

      const rawPayload = JSON.stringify(checkoutSessionEvent);
      const signature = generateValidStripeSignature(rawPayload);

      // Send webhook
      const webhookRes = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.status).toBe('processed');
      expect(webhookRes.body.plan).toBe('pro');

      // 3. Verify tenant in database flipped to Pro
      const updatedTenant = tenantRepo.findById(tenant.id);
      expect(updatedTenant?.plan_id).toBe('pro');
      expect(updatedTenant?.stripe_subscription_id).toBe('sub_stripe_probe_3');

      // 4. Verify GET /usage shows the new Pro limits (50,000 calls, 5M tokens)
      const usageResAfter = await request(app)
        .get('/usage')
        .set('X-Tenant-ID', tenant.id);

      expect(usageResAfter.status).toBe(200);
      expect(usageResAfter.body.plan).toBe('pro');
      expect(usageResAfter.body.usage.api_calls.limit).toBe(50000);
      expect(usageResAfter.body.usage.tokens.limit).toBe(5000000);
    });
  });

  // =========================================================================
  // PROBE 4: Webhook Signature Verification & Deduplication
  // =========================================================================
  describe('PROBE 4: Webhook Security & Idempotent Replay', () => {
    it('rejects forged webhook with HTTP 400 and processes a valid replayed webhook exactly once', async () => {
      const tenant = tenantRepo.create({
        id: 'probe4_tenant',
        name: 'Webhook Security Tester',
        email: 'security@example.com',
        plan_id: 'free',
      });

      const eventPayload = {
        id: 'evt_stripe_security_4',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_security_4',
            client_reference_id: tenant.id,
            customer: 'cus_sec_4',
            subscription: 'sub_sec_4',
          },
        },
      };

      const rawPayload = JSON.stringify(eventPayload);

      // 1. Send forged webhook (bad signature) -> MUST return 400
      const forgedSig = 't=1234567,v1=bad_forged_hex_signature';
      const forgedRes = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', forgedSig)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(forgedRes.status).toBe(400);
      expect(forgedRes.body.error).toBe('WebhookError');

      // Confirm tenant was NOT changed by the forged webhook
      expect(tenantRepo.findById(tenant.id)?.plan_id).toBe('free');

      // 2. Send genuine signed webhook -> MUST succeed (status: processed)
      const validSig = generateValidStripeSignature(rawPayload);
      const res1 = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', validSig)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('processed');
      expect(tenantRepo.findById(tenant.id)?.plan_id).toBe('pro');

      // 3. Replay the EXACT SAME webhook event -> MUST return ignored_duplicate (processed once)
      const res2 = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', validSig)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('ignored_duplicate');
    });
  });

  // =========================================================================
  // PROBE 5: Multi-Category AI Token Pricing & Rollup Verification
  // =========================================================================
  describe('PROBE 5: AI Token Pricing Rules & GET /usage Rollup', () => {
    it('applies cached discount and counts reasoning tokens as output, matching pinned constants in /usage', async () => {
      const tenant = tenantRepo.create({
        id: 'probe5_tenant',
        name: 'Token Pricing Tester',
        email: 'tokens@example.com',
        plan_id: 'free',
      });

      // Token scenario:
      // Fresh Input: 1,000 tokens  @ 1 micro-unit/token      = 1,000 micro-units
      // Cached Input: 400 tokens  @ 0.25 micro-unit/token   = 100 micro-units (75% cheaper)
      // Output: 500 tokens        @ 4 micro-units/token     = 2,000 micro-units
      // Reasoning: 200 tokens     @ 4 micro-units/token     = 800 micro-units (counted as output)
      // API call: 1 call          @ 1,000 micro-units       = 1,000 micro-units
      // Expected Total = 1,000 + 100 + 2,000 + 800 + 1,000 = 4,900 micro-units ($0.0049)

      const generateRes = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', 'req_probe_5_pricing')
        .send({
          prompt: 'Solve theorem with thinking process',
          simulate_tokens: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 500,
            reasoning_tokens: 200,
          },
        });

      expect(generateRes.status).toBe(200);
      expect(generateRes.body.cost.input_token_micro_units).toBe(1000);
      expect(generateRes.body.cost.cached_input_token_micro_units).toBe(100);
      expect(generateRes.body.cost.output_token_micro_units).toBe(2000);
      expect(generateRes.body.cost.reasoning_token_micro_units).toBe(800);
      expect(generateRes.body.cost.api_call_micro_units).toBe(1000);
      expect(generateRes.body.cost.total_cost_micro_units).toBe(4900);
      expect(generateRes.body.cost.total_cost_formatted).toBe('$0.0049');

      // Now query GET /usage and ensure rolled up totals match pinned constants exactly
      const usageRes = await request(app)
        .get('/usage')
        .set('X-Tenant-ID', tenant.id);

      expect(usageRes.status).toBe(200);
      expect(usageRes.body.usage.api_calls.used).toBe(1);
      expect(usageRes.body.usage.tokens.used).toBe(2100); // 1000 + 400 + 500 + 200
      expect(usageRes.body.usage.tokens.breakdown.input_tokens).toBe(1000);
      expect(usageRes.body.usage.tokens.breakdown.cached_input_tokens).toBe(400);
      expect(usageRes.body.usage.tokens.breakdown.output_tokens).toBe(500);
      expect(usageRes.body.usage.tokens.breakdown.reasoning_tokens).toBe(200);

      expect(usageRes.body.cost.total_cost_micro_units).toBe(4900);
      expect(usageRes.body.cost.total_cost_formatted).toBe('$0.0049');
      expect(usageRes.body.cost.breakdown.cached_input_tokens.micro_units).toBe(100);
      expect(usageRes.body.cost.breakdown.reasoning_tokens.micro_units).toBe(800);
    });
  });

  // =========================================================================
  // Shared Requirement 2: Validation at Boundary (clean 4xx, never a 500)
  // =========================================================================
  describe('Boundary Input Validation', () => {
    it('returns clean HTTP 400 with structured issues on negative tokens, never a 500', async () => {
      const tenant = tenantRepo.create({
        id: 'valid_tenant',
        name: 'Validator',
        email: 'val@example.com',
      });

      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', 'req_bad_tokens')
        .send({
          simulate_tokens: {
            input_tokens: -50, // Negative number invalid
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
      expect(res.body.issues).toBeDefined();
    });

    it('returns clean HTTP 400 when missing tenant or idempotency key', async () => {
      const res = await request(app)
        .post('/generate')
        .send({ prompt: 'Missing headers' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BadRequest');
    });
  });

  // =========================================================================
  // Background Job: Quota Alert & Retries
  // =========================================================================
  describe('Background Jobs & Quota Alerts', () => {
    it('enqueues a background alert job when usage reaches >= 80% and successfully processes it', async () => {
      const tenant = tenantRepo.create({
        id: 'alert_tenant',
        name: 'Alert Corp',
        email: 'alert@example.com',
        plan_id: 'free', // 100k token limit
      });

      // Send request using 85,000 tokens (85% of 100,000 quota)
      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenant.id)
        .set('Idempotency-Key', 'req_alert_85k')
        .send({
          simulate_tokens: {
            output_tokens: 85000,
          },
        });

      expect(res.status).toBe(200);

      // Process pending background jobs
      const jobsProcessed = await backgroundWorker.processPendingJobsOnce();
      expect(jobsProcessed).toBeGreaterThanOrEqual(1);

      // Verify alert was marked as sent for 80% threshold in this billing period
      const currentPeriod = '2026-10'; // or current period
      const has80Alert = usageRepo.hasAlertBeenSent(tenant.id, 80, res.body.plan ? currentPeriod : currentPeriod);
      // Let's verify via DB directly
      const alertRow = db.prepare('SELECT * FROM usage_alerts WHERE tenant_id = ?').get(tenant.id) as any;
      expect(alertRow).toBeDefined();
      expect(alertRow.threshold_percent).toBe(80);
    });
  });
});
