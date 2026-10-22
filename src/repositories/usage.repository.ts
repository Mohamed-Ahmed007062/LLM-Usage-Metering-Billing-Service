import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { UsageEvent, TokenBreakdown } from '../types/index.js';

export interface UsageAggregationResult {
  api_calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  total_cost_micro_units: number;
}

export class UsageRepository {
  constructor(private db: Database) {}

  recordEvent(event: {
    tenant_id: string;
    idempotency_key: string;
    event_type?: string;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
    cost_micro_units: number;
    created_at?: string;
  }): UsageEvent {
    const id = crypto.randomUUID();
    const event_type = event.event_type || 'ai_generate';
    const input_tokens = event.input_tokens || 0;
    const cached_input_tokens = event.cached_input_tokens || 0;
    const output_tokens = event.output_tokens || 0;
    const reasoning_tokens = event.reasoning_tokens || 0;
    const total_tokens = event.total_tokens !== undefined
      ? event.total_tokens
      : (input_tokens + cached_input_tokens + output_tokens + reasoning_tokens);
    const created_at = event.created_at || new Date().toISOString();

    this.db.prepare(`
      INSERT INTO usage_events (
        id, tenant_id, idempotency_key, event_type,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        total_tokens, cost_micro_units, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.tenant_id,
      event.idempotency_key,
      event_type,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      event.cost_micro_units,
      created_at
    );

    return {
      id,
      tenant_id: event.tenant_id,
      idempotency_key: event.idempotency_key,
      event_type,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_tokens,
      total_tokens,
      cost_micro_units: event.cost_micro_units,
      created_at,
    };
  }

  findByTenantAndKey(tenantId: string, idempotencyKey: string): UsageEvent | null {
    const row = this.db.prepare(`
      SELECT * FROM usage_events WHERE tenant_id = ? AND idempotency_key = ?
    `).get(tenantId, idempotencyKey);
    return (row as UsageEvent) || null;
  }

  getMonthlyAggregation(tenantId: string, startDateIso: string, endDateIso: string): UsageAggregationResult {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as api_calls,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) as cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cost_micro_units), 0) as total_cost_micro_units
      FROM usage_events
      WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
    `).get(tenantId, startDateIso, endDateIso) as any;

    return {
      api_calls: row ? Number(row.api_calls) : 0,
      input_tokens: row ? Number(row.input_tokens) : 0,
      cached_input_tokens: row ? Number(row.cached_input_tokens) : 0,
      output_tokens: row ? Number(row.output_tokens) : 0,
      reasoning_tokens: row ? Number(row.reasoning_tokens) : 0,
      total_tokens: row ? Number(row.total_tokens) : 0,
      total_cost_micro_units: row ? Number(row.total_cost_micro_units) : 0,
    };
  }

  hasAlertBeenSent(tenantId: string, thresholdPercent: number, billingPeriod: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM usage_alerts
      WHERE tenant_id = ? AND threshold_percent = ? AND billing_period = ?
    `).get(tenantId, thresholdPercent, billingPeriod);
    return !!row;
  }

  recordAlertSent(tenantId: string, thresholdPercent: number, billingPeriod: string): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO usage_alerts (id, tenant_id, threshold_percent, billing_period, sent_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, threshold_percent, billing_period) DO NOTHING
    `).run(id, tenantId, thresholdPercent, billingPeriod, now);
  }

  countByTenant(tenantId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ?').get(tenantId) as any;
    return row ? Number(row.count) : 0;
  }
}
