import { Database } from 'better-sqlite3';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { QuotaService } from './quota.service.js';
import { PricingService } from './pricing.service.js';
import { MonthlyUsageRollup, Plan } from '../types/index.js';

export class UsageService {
  private tenantRepo: TenantRepository;
  private usageRepo: UsageRepository;

  constructor(private db: Database) {
    this.tenantRepo = new TenantRepository(db);
    this.usageRepo = new UsageRepository(db);
  }

  getTenantUsageRollup(tenantId: string, customDate?: Date): MonthlyUsageRollup {
    const tenant = this.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const plan = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(tenant.plan_id) as Plan;
    if (!plan) {
      throw new Error(`Plan '${tenant.plan_id}' not found`);
    }

    const billingPeriod = QuotaService.getCurrentBillingPeriod(customDate || new Date());
    const aggregation = this.usageRepo.getMonthlyAggregation(
      tenantId,
      billingPeriod.startIso,
      billingPeriod.endIso
    );

    // Compute costs using the pinned pricing rules on the aggregated token counts
    const costResult = PricingService.calculateCost(
      {
        input_tokens: aggregation.input_tokens,
        cached_input_tokens: aggregation.cached_input_tokens,
        output_tokens: aggregation.output_tokens,
        reasoning_tokens: aggregation.reasoning_tokens,
      },
      false // Token pricing breakdown
    );

    // Add API calls cost
    const apiCallsCostMicroUnits = aggregation.api_calls * 1000;
    const totalWithApiCallsMicroUnits = costResult.total_cost_micro_units + apiCallsCostMicroUnits;
    const totalCents = Math.floor(totalWithApiCallsMicroUnits / 10000);
    const totalFormatted = `$${(totalWithApiCallsMicroUnits / 1000000).toFixed(4)}`;

    const apiCallsPercentUsed = Number(((aggregation.api_calls / plan.max_api_calls) * 100).toFixed(2));
    const tokensPercentUsed = Number(((aggregation.total_tokens / plan.max_tokens) * 100).toFixed(2));

    return {
      tenant_id: tenant.id,
      plan: tenant.plan_id,
      status: tenant.status,
      billing_period: {
        year_month: billingPeriod.yearMonth,
        start: billingPeriod.startIso,
        end: billingPeriod.endIso,
      },
      usage: {
        api_calls: {
          used: aggregation.api_calls,
          limit: plan.max_api_calls,
          remaining: Math.max(0, plan.max_api_calls - aggregation.api_calls),
          percent_used: apiCallsPercentUsed,
        },
        tokens: {
          used: aggregation.total_tokens,
          limit: plan.max_tokens,
          remaining: Math.max(0, plan.max_tokens - aggregation.total_tokens),
          percent_used: tokensPercentUsed,
          breakdown: {
            input_tokens: aggregation.input_tokens,
            cached_input_tokens: aggregation.cached_input_tokens,
            output_tokens: aggregation.output_tokens,
            reasoning_tokens: aggregation.reasoning_tokens,
          },
        },
      },
      cost: {
        api_call_micro_units: apiCallsCostMicroUnits,
        input_token_micro_units: costResult.input_token_micro_units,
        cached_input_token_micro_units: costResult.cached_input_token_micro_units,
        output_token_micro_units: costResult.output_token_micro_units,
        reasoning_token_micro_units: costResult.reasoning_token_micro_units,
        total_cost_micro_units: totalWithApiCallsMicroUnits,
        total_cost_cents: totalCents,
        total_cost_formatted: totalFormatted,
        breakdown: {
          api_calls: {
            micro_units: apiCallsCostMicroUnits,
            formatted: `$${(apiCallsCostMicroUnits / 1000000).toFixed(4)}`,
          },
          input_tokens: costResult.breakdown.input_tokens,
          cached_input_tokens: costResult.breakdown.cached_input_tokens,
          output_tokens: costResult.breakdown.output_tokens,
          reasoning_tokens: costResult.breakdown.reasoning_tokens,
        },
      },
    };
  }
}
