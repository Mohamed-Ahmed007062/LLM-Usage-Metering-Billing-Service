import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { JobStatus } from '../types/index.js';

export interface BackgroundJob {
  id: string;
  job_type: string;
  payload: string;
  status: JobStatus;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class JobRepository {
  constructor(private db: Database) {}

  createJob(jobType: string, payload: any, maxRetries = 3): BackgroundJob {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const payloadStr = JSON.stringify(payload);

    this.db.prepare(`
      INSERT INTO background_jobs (id, job_type, payload, status, retry_count, max_retries, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)
    `).run(id, jobType, payloadStr, maxRetries, now, now);

    return {
      id,
      job_type: jobType,
      payload: payloadStr,
      status: 'PENDING',
      retry_count: 0,
      max_retries: maxRetries,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
  }

  fetchNextPendingJobs(limit = 10): BackgroundJob[] {
    return this.db.prepare(`
      SELECT * FROM background_jobs
      WHERE status = 'PENDING' OR (status = 'FAILED' AND retry_count < max_retries)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as BackgroundJob[];
  }

  markProcessing(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE background_jobs
      SET status = 'PROCESSING', updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  markCompleted(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE background_jobs
      SET status = 'COMPLETED', updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  markFailed(id: string, errorMsg: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE background_jobs
      SET status = 'FAILED',
          retry_count = retry_count + 1,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(errorMsg, now, id);
  }

  listJobs(): BackgroundJob[] {
    return this.db.prepare('SELECT * FROM background_jobs ORDER BY created_at DESC').all() as BackgroundJob[];
  }
}
