import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { IdempotencyRecord, IdempotencyStatus } from '../types/index.js';

export class IdempotencyRepository {
  constructor(private db: Database) {}

  findByTenantAndKey(tenantId: string, key: string): IdempotencyRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM idempotency_keys WHERE tenant_id = ? AND key = ?
    `).get(tenantId, key);
    return (row as IdempotencyRecord) || null;
  }

  createInProgress(
    tenantId: string,
    key: string,
    requestHash: string,
    ttlSeconds = 86400
  ): { success: boolean; record?: IdempotencyRecord } {
    const id = crypto.randomUUID();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    try {
      this.db.prepare(`
        INSERT INTO idempotency_keys (id, tenant_id, key, request_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?)
      `).run(id, tenantId, key, requestHash, createdAt, expiresAt);

      return {
        success: true,
        record: {
          id,
          tenant_id: tenantId,
          key,
          request_hash: requestHash,
          status: 'IN_PROGRESS',
          response_code: null,
          response_headers: null,
          response_body: null,
          created_at: createdAt,
          expires_at: expiresAt,
        },
      };
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        return { success: false };
      }
      throw err;
    }
  }

  updateRecord(
    tenantId: string,
    key: string,
    status: IdempotencyStatus,
    responseCode: number,
    responseHeaders: Record<string, any>,
    responseBody: any
  ): void {
    this.db.prepare(`
      UPDATE idempotency_keys
      SET status = ?,
          response_code = ?,
          response_headers = ?,
          response_body = ?
      WHERE tenant_id = ? AND key = ?
    `).run(
      status,
      responseCode,
      JSON.stringify(responseHeaders),
      JSON.stringify(responseBody),
      tenantId,
      key
    );
  }
}
