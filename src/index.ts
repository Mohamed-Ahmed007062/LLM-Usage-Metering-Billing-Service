import { CONFIG } from './config/index.js';
import { getDatabase, closeDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { createApp } from './app.js';
import { BackgroundWorkerService } from './services/background.service.js';
import { StripeService } from './services/stripe.service.js';
import { seedDatabase } from './scripts/seed.js';

async function bootstrap() {
  console.log(`Starting Usage Metering & Billing Engine on port ${CONFIG.port}...`);
  console.log(`Environment: ${CONFIG.nodeEnv}`);
  console.log(`Database Path: ${CONFIG.databasePath}`);

  // 1. Initialize Database & Run Migrations
  const db = getDatabase();
  runMigrations(db);

  // 2. Check if database has tenants, if not run seed
  const tenantCount = (db.prepare('SELECT COUNT(*) as count FROM tenants').get() as any)?.count || 0;
  if (tenantCount === 0) {
    console.log('Database empty. Running seed automatically...');
    seedDatabase();
  }

  // 3. Initialize Services
  const stripeService = new StripeService(db);
  const backgroundWorker = new BackgroundWorkerService(db, stripeService);
  backgroundWorker.start(5000); // Poll every 5s for pending alerts/reconciliations

  // 4. Create Express App
  const app = createApp({ db, stripeService, backgroundWorker });

  // 5. Start HTTP Server
  const server = app.listen(CONFIG.port, () => {
    console.log(`\n========================================================`);
    console.log(` Billing & Metering Engine running at http://localhost:${CONFIG.port}`);
    console.log(` Base URL: http://localhost:${CONFIG.port}`);
    console.log(` Billable Endpoint: POST http://localhost:${CONFIG.port}/generate`);
    console.log(` Usage Rollup:      GET  http://localhost:${CONFIG.port}/usage`);
    console.log(` Stripe Checkout:   POST http://localhost:${CONFIG.port}/checkout/session`);
    console.log(` Stripe Webhook:    POST http://localhost:${CONFIG.port}/webhooks/stripe`);
    console.log(` Health Check:      GET  http://localhost:${CONFIG.port}/health`);
    console.log(`========================================================\n`);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('\nGracefully shutting down server...');
    backgroundWorker.stop();
    server.close(() => {
      closeDatabase();
      console.log('Database and server closed safely.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
