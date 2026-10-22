import { getDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { QuotaService } from '../services/quota.service.js';

export function seedDatabase(customPath?: string): void {
  const db = getDatabase(customPath);
  runMigrations(db);

  const tenantRepo = new TenantRepository(db);
  const usageRepo = new UsageRepository(db);

  console.log('--- Seeding Database with Demo Tenants ---');

  // 1. Standard Free Plan Tenant
  const freeTenant = tenantRepo.create({
    id: 'tenant_free_demo',
    name: 'Acme Free Corp',
    email: 'acme@example.com',
    plan_id: 'free',
    status: 'active',
  });
  console.log(`[+] Seeded Free Tenant: ${freeTenant.id} (${freeTenant.name})`);

  // 2. Standard Pro Plan Tenant
  const proTenant = tenantRepo.create({
    id: 'tenant_pro_demo',
    name: 'Globex Pro AI',
    email: 'globex@example.com',
    plan_id: 'pro',
    status: 'active',
    stripe_customer_id: 'cus_demo_globex',
    stripe_subscription_id: 'sub_demo_globex',
  });
  console.log(`[+] Seeded Pro Tenant: ${proTenant.id} (${proTenant.name})`);

  // 3. Past Due Tenant (for 402 Payment Required verification)
  const pastDueTenant = tenantRepo.create({
    id: 'tenant_past_due',
    name: 'Initech Overdue',
    email: 'billing@initech.local',
    plan_id: 'pro',
    status: 'past_due',
    stripe_customer_id: 'cus_demo_initech',
    stripe_subscription_id: 'sub_demo_initech',
  });
  console.log(`[+] Seeded Past Due Tenant: ${pastDueTenant.id} (Status: ${pastDueTenant.status})`);

  // 4. Boundary Demo Tenant (999 calls used out of 1000 limit)
  const boundaryTenant = tenantRepo.create({
    id: 'tenant_quota_boundary',
    name: 'Soylent Boundary Labs',
    email: 'boundary@soylent.com',
    plan_id: 'free',
    status: 'active',
  });

  const now = new Date();
  const billingPeriod = QuotaService.getCurrentBillingPeriod(now);
  const seedTimestamp = new Date(Date.now() - 3600 * 1000).toISOString();

  // Seed 999 events
  const insertUsage = db.prepare(`
    INSERT INTO usage_events (
      id, tenant_id, idempotency_key, event_type,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      total_tokens, cost_micro_units, created_at
    ) VALUES (?, ?, ?, 'ai_generate', 10, 0, 10, 0, 20, 1080, ?)
  `);

  const seedEventsTx = db.transaction(() => {
    for (let i = 1; i <= 999; i++) {
      insertUsage.run(
        `evt_seed_boundary_${i}`,
        boundaryTenant.id,
        `seed_key_${i}`,
        seedTimestamp
      );
    }
  });
  seedEventsTx();

  console.log(
    `[+] Seeded Boundary Tenant: ${boundaryTenant.id} with 999 prior calls (Limit: 1,000 calls). Next call will hit exactly 1,000, subsequent call will be blocked with 429.`
  );

  console.log('--- Seeding Completed Successfully ---');
}

// Execute if run directly via tsx/node
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seedDatabase();
  process.exit(0);
}
