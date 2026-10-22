import { Database } from 'better-sqlite3';

export class WebhookRepository {
  constructor(private db: Database) {}

  isEventProcessed(eventId: string): boolean {
    const row = this.db.prepare('SELECT id FROM processed_webhook_events WHERE id = ?').get(eventId);
    return !!row;
  }

  markEventProcessed(eventId: string, eventType: string): boolean {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO processed_webhook_events (id, event_type, processed_at)
        VALUES (?, ?, ?)
      `).run(eventId, eventType, now);
      return true;
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw err;
    }
  }
}
