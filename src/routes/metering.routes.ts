import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Database } from 'better-sqlite3';
import { MeteringService } from '../services/metering.service.js';
import { validateBody } from '../middleware/validation.middleware.js';

const generateSchema = z.object({
  tenant_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
  prompt: z.string().optional(),
  simulate_tokens: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      cached_input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      reasoning_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  event_type: z.string().optional(),
});

export function createMeteringRouter(db: Database): Router {
  const router = Router();
  const meteringService = new MeteringService(db);

  router.post(
    '/generate',
    validateBody(generateSchema),
    (req: Request, res: Response): void => {
      // Header takes precedence, with fallback to body
      const tenantId = (req.header('x-tenant-id') || req.body.tenant_id)?.trim();
      const idempotencyKey = (
        req.header('idempotency-key') ||
        req.header('x-idempotency-key') ||
        req.body.idempotency_key
      )?.trim();

      if (!tenantId) {
        res.status(400).json({
          error: 'BadRequest',
          message: "Missing required 'X-Tenant-ID' header or 'tenant_id' body field.",
        });
        return;
      }

      if (!idempotencyKey) {
        res.status(400).json({
          error: 'BadRequest',
          message: "Missing required 'Idempotency-Key' header or 'idempotency_key' body field.",
        });
        return;
      }

      const result = meteringService.recordBillableAction({
        tenantId,
        idempotencyKey,
        prompt: req.body.prompt,
        simulateTokens: req.body.simulate_tokens,
        eventType: req.body.event_type,
      });

      // Apply headers returned by service (e.g. Idempotent-Replay, Retry-After)
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }

      res.status(result.statusCode).json(result.body);
    }
  );

  return router;
}
