import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { IdempotencyRepository } from '../repositories/idempotency.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { QuotaService } from './quota.service.js';
import { PricingService } from './pricing.service.js';
import { TokenBreakdown, Plan, Tenant } from '../types/index.js';

export interface MeteringRequestInput {
  tenantId: string;
  idempotencyKey: string;
  prompt?: string;
  simulateTokens?: Partial<TokenBreakdown>;
  eventType?: string;
}

export interface MeteringExecutionResult {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  isIdempotentReplay: boolean;
}

export class MeteringService {
  private tenantRepo: TenantRepository;
  private usageRepo: UsageRepository;
  private idempotencyRepo: IdempotencyRepository;
  private jobRepo: JobRepository;
  private quotaService: QuotaService;

  constructor(private db: Database) {
    this.tenantRepo = new TenantRepository(db);
    this.usageRepo = new UsageRepository(db);
    this.idempotencyRepo = new IdempotencyRepository(db);
    this.jobRepo = new JobRepository(db);
    this.quotaService = new QuotaService(db);
  }

  recordBillableAction(input: MeteringRequestInput): MeteringExecutionResult {
    const { tenantId, idempotencyKey, prompt, simulateTokens, eventType = 'ai_generate' } = input;

    // 1. Tenant & Plan validation
    const tenant = this.tenantRepo.findById(tenantId);
    if (!tenant) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'TenantNotFound', message: `Tenant with ID '${tenantId}' does not exist.` },
        isIdempotentReplay: false,
      };
    }

    const planRow = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(tenant.plan_id) as Plan | undefined;
    if (!planRow) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'InternalError', message: `Plan '${tenant.plan_id}' configuration missing.` },
        isIdempotentReplay: false,
      };
    }

    // 2. Token normalization
    const tokens: TokenBreakdown = {
      input_tokens: Math.max(0, Math.floor(simulateTokens?.input_tokens || 0)),
      cached_input_tokens: Math.max(0, Math.floor(simulateTokens?.cached_input_tokens || 0)),
      output_tokens: Math.max(0, Math.floor(simulateTokens?.output_tokens || 0)),
      reasoning_tokens: Math.max(0, Math.floor(simulateTokens?.reasoning_tokens || 0)),
    };
    const requestedTotalTokens =
      tokens.input_tokens + tokens.cached_input_tokens + tokens.output_tokens + tokens.reasoning_tokens;

    // 3. Request fingerprint hash
    const requestPayloadString = JSON.stringify({
      tenantId,
      prompt: prompt || '',
      tokens,
      eventType,
    });
    const requestHash = crypto.createHash('sha256').update(requestPayloadString).digest('hex');

    // 4. Idempotency check: Have we seen this key for this tenant before?
    const existingKey = this.idempotencyRepo.findByTenantAndKey(tenantId, idempotencyKey);
    if (existingKey) {
      if (existingKey.status === 'COMPLETED') {
        const cachedBody = existingKey.response_body ? JSON.parse(existingKey.response_body) : {};
        const cachedHeaders = existingKey.response_headers ? JSON.parse(existingKey.response_headers) : {};

        return {
          statusCode: existingKey.response_code || 200,
          headers: {
            ...cachedHeaders,
            'Idempotent-Replay': 'true',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: cachedBody,
          isIdempotentReplay: true,
        };
      }

      if (existingKey.status === 'IN_PROGRESS') {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: {
            error: 'Conflict',
            message: 'A request with this idempotency key is currently in progress. Please retry shortly.',
          },
          isIdempotentReplay: false,
        };
      }
    }

    // 5. Atomic execution transaction
    const executeTx = this.db.transaction(() => {
      // Create IN_PROGRESS idempotency reservation
      const reservation = this.idempotencyRepo.createInProgress(tenantId, idempotencyKey, requestHash);
      if (!reservation.success) {
        // Concurrently inserted between lookup and now
        const racedKey = this.idempotencyRepo.findByTenantAndKey(tenantId, idempotencyKey);
        if (racedKey && racedKey.status === 'COMPLETED') {
          return {
            statusCode: racedKey.response_code || 200,
            headers: {
              ...JSON.parse(racedKey.response_headers || '{}'),
              'Idempotent-Replay': 'true',
              'X-Idempotency-Key': idempotencyKey,
            },
            body: JSON.parse(racedKey.response_body || '{}'),
            isIdempotentReplay: true,
          };
        }
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Conflict', message: 'Concurrent request conflict detected.' },
          isIdempotentReplay: false,
        };
      }

      const billingPeriod = QuotaService.getCurrentBillingPeriod();

      // Check Quota boundaries
      const quotaCheck = this.quotaService.checkQuota(tenant, planRow, requestedTotalTokens, billingPeriod);
      if (!quotaCheck.allowed) {
        const statusCode = quotaCheck.statusCode || 429;
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Plan': tenant.plan_id,
        };

        if (statusCode === 429) {
          responseHeaders['Retry-After'] = '3600'; // Seconds until period refresh or safe retry
        }

        const responseBody = {
          error: quotaCheck.errorCode || 'QuotaExceeded',
          message: quotaCheck.errorMessage,
          resource: quotaCheck.resource,
          plan: tenant.plan_id,
          current_usage: quotaCheck.currentUsage
            ? {
                api_calls: quotaCheck.currentUsage.api_calls,
                tokens: quotaCheck.currentUsage.total_tokens,
              }
            : undefined,
          limits: quotaCheck.limits,
          upgrade_available: tenant.plan_id === 'free',
          checkout_endpoint: tenant.plan_id === 'free' ? '/checkout/session' : undefined,
        };

        // Cache rejected response under idempotency key so retries match
        this.idempotencyRepo.updateRecord(
          tenantId,
          idempotencyKey,
          'COMPLETED',
          statusCode,
          responseHeaders,
          responseBody
        );

        return {
          statusCode,
          headers: responseHeaders,
          body: responseBody,
          isIdempotentReplay: false,
        };
      }

      // Calculate exact integer cost
      const costResult = PricingService.calculateCost(tokens, true);

      // Record billable usage event
      const event = this.usageRepo.recordEvent({
        tenant_id: tenantId,
        idempotency_key: idempotencyKey,
        event_type: eventType,
        input_tokens: tokens.input_tokens,
        cached_input_tokens: tokens.cached_input_tokens,
        output_tokens: tokens.output_tokens,
        reasoning_tokens: tokens.reasoning_tokens,
        total_tokens: requestedTotalTokens,
        cost_micro_units: costResult.total_cost_micro_units,
      });

      // Compute new totals after this billable event
      const newApiCallCount = (quotaCheck.currentUsage?.api_calls || 0) + 1;
      const newTotalTokens = (quotaCheck.currentUsage?.total_tokens || 0) + requestedTotalTokens;

      const successHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Usage-Event-ID': event.id,
      };

      const successBody = {
        success: true,
        event_id: event.id,
        tenant_id: tenantId,
        plan: tenant.plan_id,
        usage_recorded: {
          api_calls: 1,
          tokens: {
            input_tokens: tokens.input_tokens,
            cached_input_tokens: tokens.cached_input_tokens,
            output_tokens: tokens.output_tokens,
            reasoning_tokens: tokens.reasoning_tokens,
            total_tokens: requestedTotalTokens,
          },
        },
        cost: costResult,
        quota_remaining: {
          api_calls: Math.max(0, planRow.max_api_calls - newApiCallCount),
          tokens: Math.max(0, planRow.max_tokens - newTotalTokens),
        },
        simulated_response: `[Simulation] Model response processed successfully for prompt: '${(prompt || '').slice(0, 50)}...' with ${tokens.output_tokens} output tokens and ${tokens.reasoning_tokens} reasoning tokens.`,
      };

      // Mark idempotency key as COMPLETED with the success response
      this.idempotencyRepo.updateRecord(
        tenantId,
        idempotencyKey,
        'COMPLETED',
        200,
        successHeaders,
        successBody
      );

      // Check for 80% / 100% threshold alert enqueue
      const tokenPercent = (newTotalTokens / planRow.max_tokens) * 100;
      const apiCallPercent = (newApiCallCount / planRow.max_api_calls) * 100;
      const maxPercent = Math.max(tokenPercent, apiCallPercent);

      if (maxPercent >= 100 && !this.usageRepo.hasAlertBeenSent(tenantId, 100, billingPeriod.yearMonth)) {
        this.jobRepo.createJob('usage_alert', {
          tenantId,
          thresholdPercent: 100,
          billingPeriod: billingPeriod.yearMonth,
          usage: { api_calls: newApiCallCount, tokens: newTotalTokens },
          limits: { max_api_calls: planRow.max_api_calls, max_tokens: planRow.max_tokens },
        });
      } else if (maxPercent >= 80 && !this.usageRepo.hasAlertBeenSent(tenantId, 80, billingPeriod.yearMonth)) {
        this.jobRepo.createJob('usage_alert', {
          tenantId,
          thresholdPercent: 80,
          billingPeriod: billingPeriod.yearMonth,
          usage: { api_calls: newApiCallCount, tokens: newTotalTokens },
          limits: { max_api_calls: planRow.max_api_calls, max_tokens: planRow.max_tokens },
        });
      }

      return {
        statusCode: 200,
        headers: successHeaders,
        body: successBody,
        isIdempotentReplay: false,
      };
    });

    return executeTx();
  }
}
