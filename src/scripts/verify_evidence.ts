import Database from 'better-sqlite3';
import http from 'http';
import crypto from 'crypto';
import { runMigrations } from '../db/migrations.js';
import { createApp } from '../app.js';
import { StripeService } from '../services/stripe.service.js';
import { BackgroundWorkerService } from '../services/background.service.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { CONFIG } from '../config/index.js';

async function main() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const tenantRepo = new TenantRepository(db);
  const usageRepo = new UsageRepository(db);

  const TEST_SECRET = 'whsec_verification_secret_98765';
  (CONFIG as any).stripeWebhookSecret = TEST_SECRET;

  const stripeService = new StripeService(db);
  const backgroundWorker = new BackgroundWorkerService(db, stripeService);
  const app = createApp({ db, stripeService, backgroundWorker });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(3099, resolve));
  console.log('Verification server running on http://localhost:3099\n');

  try {
    // -------------------------------------------------------------
    // PROBE 1: Idempotency Verification
    // -------------------------------------------------------------
    console.log('=== PROBE 1: IDEMPOTENCY EXACTLY-ONCE TEST ===');
    const tenant1 = tenantRepo.create({
      id: 'tenant_probe_1',
      name: 'Idempotency Test Tenant',
      email: 'p1@example.com',
      plan_id: 'free',
    });

    const payload1 = JSON.stringify({
      prompt: 'Summarize financial reports',
      simulate_tokens: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 300, reasoning_tokens: 150 },
    });

    const headers1 = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenant1.id,
      'Idempotency-Key': 'idemp_key_live_test_001',
    };

    console.log('--- Request 1 (Initial Call) ---');
    const res1 = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: headers1,
      body: payload1,
    });
    const body1 = await res1.json();
    console.log(`Status: ${res1.status}`);
    console.log(`Headers: Idempotent-Replay = ${res1.headers.get('idempotent-replay')}`);
    console.log('Body:', JSON.stringify(body1, null, 2));

    console.log('\n--- Request 2 (Identical Retry with same Idempotency-Key) ---');
    const res2 = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: headers1,
      body: payload1,
    });
    const body2 = await res2.json();
    console.log(`Status: ${res2.status}`);
    console.log(`Headers: Idempotent-Replay = ${res2.headers.get('idempotent-replay')}`);
    console.log('Body:', JSON.stringify(body2, null, 2));

    const dbUsageCount1 = usageRepo.countByTenant(tenant1.id);
    console.log(`Total DB Usage Events for Tenant: ${dbUsageCount1} (MUST BE EXACTLY 1)\n`);

    // -------------------------------------------------------------
    // PROBE 2: Quota Boundary Honesty
    // -------------------------------------------------------------
    console.log('=== PROBE 2: QUOTA BOUNDARY HONESTY ===');
    const tenant2 = tenantRepo.create({
      id: 'tenant_probe_2',
      name: 'Quota Boundary Tenant',
      email: 'p2@example.com',
      plan_id: 'free', // 1,000 call limit
    });

    // Fast-forward to 999 calls
    const insertStmt = db.prepare(`
      INSERT INTO usage_events (
        id, tenant_id, idempotency_key, event_type,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        total_tokens, cost_micro_units, created_at
      ) VALUES (?, ?, ?, 'ai_generate', 1, 0, 1, 0, 2, 1005, ?)
    `);
    const now = new Date().toISOString();
    for (let i = 1; i <= 999; i++) {
      insertStmt.run(`evt_p2_${i}`, tenant2.id, `p2_key_${i}`, now);
    }

    console.log('--- Call at Boundary (Call #1,000 of 1,000 Limit) ---');
    const resBoundary = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenant2.id,
        'Idempotency-Key': 'key_call_1000',
      },
      body: JSON.stringify({ prompt: 'Boundary call 1000' }),
    });
    const bodyBoundary = await resBoundary.json();
    console.log(`Status: ${resBoundary.status}`);
    console.log('Body:', JSON.stringify(bodyBoundary, null, 2));

    console.log('\n--- Call Exceeding Quota (Call #1,001 of 1,000 Limit) ---');
    const resOver = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenant2.id,
        'Idempotency-Key': 'key_call_1001',
      },
      body: JSON.stringify({ prompt: 'Over limit call 1001' }),
    });
    const bodyOver = await resOver.json();
    console.log(`Status: ${resOver.status}`);
    console.log(`Headers: Retry-After = ${resOver.headers.get('retry-after')}`);
    console.log('Body:', JSON.stringify(bodyOver, null, 2));

    // Past Due Check (HTTP 402)
    console.log('\n--- Past Due Tenant Call (HTTP 402 Payment Required) ---');
    const pastDueTenant = tenantRepo.create({
      id: 'tenant_probe_2_pastdue',
      name: 'Past Due Corp',
      email: 'pd@example.com',
      plan_id: 'pro',
      status: 'past_due',
    });
    const resPastDue = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': pastDueTenant.id,
        'Idempotency-Key': 'key_past_due_test',
      },
      body: JSON.stringify({ prompt: 'Blocked past due call' }),
    });
    const bodyPastDue = await resPastDue.json();
    console.log(`Status: ${resPastDue.status}`);
    console.log('Body:', JSON.stringify(bodyPastDue, null, 2));

    // -------------------------------------------------------------
    // PROBE 3 & 4: Stripe Checkout, Webhooks & Security
    // -------------------------------------------------------------
    console.log('\n=== PROBE 3 & 4: STRIPE CHECKOUT & WEBHOOK SYNC ===');
    const tenant3 = tenantRepo.create({
      id: 'tenant_probe_3',
      name: 'Stripe Sync Tenant',
      email: 'stripe_sync@example.com',
      plan_id: 'free',
    });

    console.log('--- GET /usage Before Upgrade ---');
    const resUsageBefore = await fetch(`http://localhost:3099/usage?tenant_id=${tenant3.id}`);
    const bodyUsageBefore = await resUsageBefore.json();
    console.log(`Plan: ${bodyUsageBefore.plan}, API Calls Limit: ${bodyUsageBefore.usage.api_calls.limit}, Token Limit: ${bodyUsageBefore.usage.tokens.limit}`);

    // Create Checkout Session
    console.log('\n--- POST /checkout/session ---');
    const resCheckout = await fetch('http://localhost:3099/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenant3.id }),
    });
    const bodyCheckout = await resCheckout.json();
    console.log(`Status: ${resCheckout.status}`);
    console.log('Body:', JSON.stringify(bodyCheckout, null, 2));

    // Forged Webhook (Probe 4)
    console.log('\n--- Forged Webhook Attack (Bad Signature -> HTTP 400) ---');
    const webhookEvent = {
      id: 'evt_probe_3_checkout_completed',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_live_sim_123',
          client_reference_id: tenant3.id,
          customer: 'cus_probe_3',
          subscription: 'sub_probe_3',
        },
      },
    };
    const rawWebhookPayload = JSON.stringify(webhookEvent);

    const resForged = await fetch('http://localhost:3099/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=bad_forged_hash',
      },
      body: rawWebhookPayload,
    });
    const bodyForged = await resForged.json();
    console.log(`Status: ${resForged.status}`);
    console.log('Body:', JSON.stringify(bodyForged, null, 2));

    // Genuine Signed Webhook (Probe 3)
    console.log('\n--- Valid Signed Webhook Execution ---');
    const timestamp = Math.floor(Date.now() / 1000);
    const validSig = `t=${timestamp},v1=${crypto
      .createHmac('sha256', TEST_SECRET)
      .update(`${timestamp}.${rawWebhookPayload}`)
      .digest('hex')}`;

    const resValidWebhook = await fetch('http://localhost:3099/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': validSig,
      },
      body: rawWebhookPayload,
    });
    const bodyValidWebhook = await resValidWebhook.json();
    console.log(`Status: ${resValidWebhook.status}`);
    console.log('Body:', JSON.stringify(bodyValidWebhook, null, 2));

    // Replay Webhook (Probe 4 deduplication)
    console.log('\n--- Replay Webhook Event (Must Ignore Duplicate) ---');
    const resReplay = await fetch('http://localhost:3099/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': validSig,
      },
      body: rawWebhookPayload,
    });
    const bodyReplay = await resReplay.json();
    console.log(`Status: ${resReplay.status}`);
    console.log('Body:', JSON.stringify(bodyReplay, null, 2));

    // Verify GET /usage reflects new limits (Probe 3)
    console.log('\n--- GET /usage After Webhook Upgrade ---');
    const resUsageAfter = await fetch(`http://localhost:3099/usage?tenant_id=${tenant3.id}`);
    const bodyUsageAfter = await resUsageAfter.json();
    console.log(`Plan: ${bodyUsageAfter.plan}, API Calls Limit: ${bodyUsageAfter.usage.api_calls.limit}, Token Limit: ${bodyUsageAfter.usage.tokens.limit}`);

    // -------------------------------------------------------------
    // PROBE 5: Multi-Category AI Token Pricing & Rollup Verification
    // -------------------------------------------------------------
    console.log('\n=== PROBE 5: AI TOKEN PRICING MATH & ROLLUP ===');
    const tenant5 = tenantRepo.create({
      id: 'tenant_probe_5',
      name: 'Pricing Rules Tenant',
      email: 'p5@example.com',
      plan_id: 'free',
    });

    const resPricing = await fetch('http://localhost:3099/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenant5.id,
        'Idempotency-Key': 'pricing_key_probe_5',
      },
      body: JSON.stringify({
        prompt: 'Calculate quantum physics problem with chain-of-thought',
        simulate_tokens: {
          input_tokens: 1000,       // 1,000 * 1 = 1,000 micro-units
          cached_input_tokens: 400, // 400 * 0.25 = 100 micro-units (75% discount)
          output_tokens: 500,       // 500 * 4 = 2,000 micro-units
          reasoning_tokens: 200,    // 200 * 4 = 800 micro-units (counted as output)
        },
      }),
    });
    const bodyPricing = await resPricing.json();
    console.log(`Status: ${resPricing.status}`);
    console.log('Pricing Breakdown:', JSON.stringify(bodyPricing.cost, null, 2));

    const resPricingRollup = await fetch(`http://localhost:3099/usage?tenant_id=${tenant5.id}`);
    const bodyPricingRollup = await resPricingRollup.json();
    console.log('\nGET /usage Rollup:');
    console.log(JSON.stringify(bodyPricingRollup, null, 2));

  } finally {
    server.close();
  }
}

main().catch(console.error);
