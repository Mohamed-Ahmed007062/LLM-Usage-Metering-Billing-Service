import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Database } from 'better-sqlite3';
import { StripeService } from '../services/stripe.service.js';
import { validateBody } from '../middleware/validation.middleware.js';

const checkoutSchema = z.object({
  tenant_id: z.string().min(1, 'tenant_id is required'),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

export function createCheckoutRouter(db: Database, stripeService?: StripeService): Router {
  const router = Router();
  const service = stripeService || new StripeService(db);

  router.post(
    '/checkout/session',
    validateBody(checkoutSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { tenant_id, success_url, cancel_url } = req.body;
        const session = await service.createCheckoutSession(tenant_id, success_url, cancel_url);

        res.status(200).json({
          success: true,
          tenant_id,
          session_id: session.sessionId,
          checkout_url: session.checkoutUrl,
        });
      } catch (err: any) {
        if (err.message && err.message.includes('not found')) {
          res.status(404).json({ error: 'NotFound', message: err.message });
          return;
        }
        next(err);
      }
    }
  );

  return router;
}
