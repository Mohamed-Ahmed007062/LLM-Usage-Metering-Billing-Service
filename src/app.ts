import express, { Express, Request, Response, NextFunction } from 'express';
import { Database } from 'better-sqlite3';
import { createWebhookRouter } from './routes/webhook.routes.js';
import { createMeteringRouter } from './routes/metering.routes.js';
import { createUsageRouter } from './routes/usage.routes.js';
import { createCheckoutRouter } from './routes/checkout.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { errorHandler } from './middleware/error.middleware.js';
import { BackgroundWorkerService } from './services/background.service.js';
import { StripeService } from './services/stripe.service.js';

export interface AppDependencies {
  db: Database;
  stripeService?: StripeService;
  backgroundWorker?: BackgroundWorkerService;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  const { db, stripeService, backgroundWorker } = deps;

  // Mount Stripe webhook route with raw body buffer parsing BEFORE json parser
  app.use(createWebhookRouter(db, stripeService));

  // JSON and URL-encoded parsers for all standard API endpoints
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Mount Application Routers
  app.use(createMeteringRouter(db));
  app.use(createUsageRouter(db));
  app.use(createCheckoutRouter(db, stripeService));
  app.use(createAdminRouter(db, backgroundWorker));

  // Catch-all 404 handler
  app.use((req: Request, res: Response): void => {
    res.status(404).json({
      error: 'NotFound',
      message: `Endpoint ${req.method} ${req.originalUrl} not found.`,
    });
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}
