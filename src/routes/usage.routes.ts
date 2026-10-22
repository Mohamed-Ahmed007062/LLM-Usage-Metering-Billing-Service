import { Router, Request, Response } from 'express';
import { Database } from 'better-sqlite3';
import { UsageService } from '../services/usage.service.js';

export function createUsageRouter(db: Database): Router {
  const router = Router();
  const usageService = new UsageService(db);

  router.get('/usage', (req: Request, res: Response): void => {
    const tenantId = (
      req.header('x-tenant-id') ||
      (req.query.tenant_id as string)
    )?.trim();

    if (!tenantId) {
      res.status(400).json({
        error: 'BadRequest',
        message: "Missing required 'X-Tenant-ID' header or 'tenant_id' query parameter.",
      });
      return;
    }

    try {
      const rollup = usageService.getTenantUsageRollup(tenantId);
      res.json(rollup);
    } catch (err: any) {
      if (err.message && err.message.includes('not found')) {
        res.status(404).json({
          error: 'TenantNotFound',
          message: err.message,
        });
        return;
      }
      res.status(500).json({
        error: 'InternalError',
        message: err.message,
      });
    }
  });

  return router;
}
