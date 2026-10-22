import { Router, Request, Response } from 'express';
import express from 'express';
import { Database } from 'better-sqlite3';
import { StripeService } from '../services/stripe.service.js';

export function createWebhookRouter(db: Database, stripeService?: StripeService): Router {
  const router = Router();
  const service = stripeService || new StripeService(db);

  // We need raw body buffer for signature verification
  router.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    (req: Request, res: Response): void => {
      const sig = req.header('stripe-signature');

      if (!sig) {
        res.status(400).json({
          error: 'BadRequest',
          message: "Missing 'stripe-signature' header in webhook request.",
        });
        return;
      }

      const rawBody = req.body;
      if (!rawBody || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) {
        res.status(400).json({
          error: 'BadRequest',
          message: 'Webhook payload body is missing or invalid.',
        });
        return;
      }

      try {
        const result = service.handleWebhookPayload(rawBody, sig);
        res.status(200).json({
          received: true,
          status: result.status,
          event_id: result.eventId,
          event_type: result.eventType,
          tenant_id: result.tenantId,
          plan: result.updatedPlan,
        });
      } catch (err: any) {
        const statusCode = err.statusCode || 400;
        res.status(statusCode).json({
          error: 'WebhookError',
          message: err.message,
        });
      }
    }
  );

  return router;
}
