import { Database } from 'better-sqlite3';
import { CONFIG } from '../config/index.js';

export function runMigrations(db: Database): void {
  db.exec(`
    -- Plans definition
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_api_calls INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Tenants table (isolated customer accounts)
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL DEFAULT 'active', -- 'active', 'past_due', 'canceled'
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Usage events recorded per billable action
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'ai_generate',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micro_units INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Idempotency key tracking to guarantee exactly-once execution
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL, -- 'IN_PROGRESS', 'COMPLETED', 'FAILED'
      response_code INTEGER,
      response_headers TEXT,
      response_body TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(tenant_id, key)
    );

    -- Stripe processed webhook events to guarantee idempotent webhook handling
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    -- Usage quota alerts tracking (80% and 100% threshold notifications)
    CREATE TABLE IF NOT EXISTS usage_alerts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      threshold_percent INTEGER NOT NULL,
      billing_period TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      UNIQUE(tenant_id, threshold_percent, billing_period)
    );

    -- Background job queue for async processing with retries and failure alerting
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Performance and isolation indexes
    CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created ON usage_events(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_key ON usage_events(tenant_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_idempotency_tenant_key ON idempotency_keys(tenant_id, key);
    CREATE INDEX IF NOT EXISTS idx_tenants_stripe_cust ON tenants(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_tenants_stripe_sub ON tenants(stripe_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status);
  `);

  // Insert or update plans from pinned config
  const insertPlan = db.prepare(`
    INSERT INTO plans (id, name, max_api_calls, max_tokens, price_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      max_api_calls = excluded.max_api_calls,
      max_tokens = excluded.max_tokens,
      price_cents = excluded.price_cents
  `);

  const now = new Date().toISOString();
  for (const plan of Object.values(CONFIG.plans)) {
    insertPlan.run(plan.id, plan.name, plan.maxApiCalls, plan.maxTokens, plan.priceCents, now);
  }
}
