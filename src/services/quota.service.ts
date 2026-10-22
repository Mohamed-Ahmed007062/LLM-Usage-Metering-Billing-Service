import { Database } from 'better-sqlite3';
import { CONFIG } from '../config/index.js';
import { Tenant, Plan } from '../types/index.js';
import { UsageRepository, UsageAggregationResult } from '../repositories/usage.repository.js';

export interface BillingPeriod {
  yearMonth: string;
  startIso: string;
  endIso: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  resource?: 'api_calls' | 'tokens' | 'subscription';
  currentUsage?: UsageAggregationResult;
  limits?: {
    maxApiCalls: number;
    maxTokens: number;
  };
}

export class QuotaService {
  private usageRepo: UsageRepository;

  constructor(private db: Database) {
    this.usageRepo = new UsageRepository(db);
  }

  static getCurrentBillingPeriod(date: Date = new Date()): BillingPeriod {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0-indexed

    const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
    const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

    return {
      yearMonth,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  checkQuota(
    tenant: Tenant,
    plan: Plan,
    requestedTokens: number,
    billingPeriod: BillingPeriod = QuotaService.getCurrentBillingPeriod()
  ): QuotaCheckResult {
    // 1. Subscription status check
    if (tenant.status === 'past_due' || tenant.status === 'canceled') {
      return {
        allowed: false,
        statusCode: 402,
        errorCode: 'PaymentRequired',
        errorMessage: `Tenant subscription is '${tenant.status}'. Active payment required to use this service.`,
        resource: 'subscription',
      };
    }

    // 2. Query current usage aggregation for current billing cycle
    const current = this.usageRepo.getMonthlyAggregation(
      tenant.id,
      billingPeriod.startIso,
      billingPeriod.endIso
    );

    // 3. API Calls quota boundary evaluation:
    // A tenant at 999 of 1000 making 1 call -> allowed (reaches 1000).
    // A tenant at 1000 making 1 call -> rejected (1001 > 1000).
    if (current.api_calls + 1 > plan.max_api_calls) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QuotaExceeded',
        errorMessage: `Monthly API call limit reached for plan '${plan.name}'. Used: ${current.api_calls}, Requested: 1, Limit: ${plan.max_api_calls}. Upgrade your plan for higher capacity.`,
        resource: 'api_calls',
        currentUsage: current,
        limits: {
          maxApiCalls: plan.max_api_calls,
          maxTokens: plan.max_tokens,
        },
      };
    }

    // 4. Token quota boundary evaluation:
    if (current.total_tokens + requestedTokens > plan.max_tokens) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QuotaExceeded',
        errorMessage: `Monthly AI token quota exceeded for plan '${plan.name}'. Used: ${current.total_tokens}, Requested: ${requestedTokens}, Limit: ${plan.max_tokens}. Upgrade to Pro for higher limits.`,
        resource: 'tokens',
        currentUsage: current,
        limits: {
          maxApiCalls: plan.max_api_calls,
          maxTokens: plan.max_tokens,
        },
      };
    }

    return {
      allowed: true,
      currentUsage: current,
      limits: {
        maxApiCalls: plan.max_api_calls,
        maxTokens: plan.max_tokens,
      },
    };
  }
}
