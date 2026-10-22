import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { Tenant, TenantStatus } from '../types/index.js';

export class TenantRepository {
  constructor(private db: Database) {}

  findById(id: string): Tenant | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    return (row as Tenant) || null;
  }

  findByStripeCustomerId(customerId: string): Tenant | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?').get(customerId);
    return (row as Tenant) || null;
  }

  findByStripeSubscriptionId(subscriptionId: string): Tenant | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE stripe_subscription_id = ?').get(subscriptionId);
    return (row as Tenant) || null;
  }

  create(tenant: {
    id?: string;
    name: string;
    email: string;
    plan_id?: string;
    status?: TenantStatus;
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
  }): Tenant {
    const id = tenant.id || crypto.randomUUID();
    const plan_id = tenant.plan_id || 'free';
    const status = tenant.status || 'active';
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tenants (id, name, email, plan_id, status, stripe_customer_id, stripe_subscription_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      tenant.name,
      tenant.email,
      plan_id,
      status,
      tenant.stripe_customer_id || null,
      tenant.stripe_subscription_id || null,
      now,
      now
    );

    return this.findById(id)!;
  }

  updatePlanAndSubscription(
    tenantId: string,
    planId: string,
    status: TenantStatus,
    customerId?: string | null,
    subscriptionId?: string | null
  ): void {
    const now = new Date().toISOString();
    let query = 'UPDATE tenants SET plan_id = ?, status = ?, updated_at = ?';
    const params: any[] = [planId, status, now];

    if (customerId !== undefined) {
      query += ', stripe_customer_id = ?';
      params.push(customerId);
    }
    if (subscriptionId !== undefined) {
      query += ', stripe_subscription_id = ?';
      params.push(subscriptionId);
    }

    query += ' WHERE id = ?';
    params.push(tenantId);

    this.db.prepare(query).run(...params);
  }

  updateStatus(tenantId: string, status: TenantStatus): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?').run(status, now, tenantId);
  }

  listAll(): Tenant[] {
    return this.db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as Tenant[];
  }
}
