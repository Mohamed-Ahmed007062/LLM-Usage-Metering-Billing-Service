export type TenantStatus = 'active' | 'past_due' | 'canceled';
export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface Plan {
  id: string;
  name: string;
  max_api_calls: number;
  max_tokens: number;
  price_cents: number;
  created_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  email: string;
  plan_id: string;
  status: TenantStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsageEvent {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  event_type: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_micro_units: number;
  created_at: string;
}

export interface IdempotencyRecord {
  id: string;
  tenant_id: string;
  key: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_code: number | null;
  response_headers: string | null;
  response_body: string | null;
  created_at: string;
  expires_at: string;
}

export interface TokenBreakdown {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

export interface TokenCostResult {
  api_call_micro_units: number;
  input_token_micro_units: number;
  cached_input_token_micro_units: number;
  output_token_micro_units: number;
  reasoning_token_micro_units: number;
  total_cost_micro_units: number;
  total_cost_cents: number;
  total_cost_formatted: string;
  breakdown: {
    api_calls: { micro_units: number; formatted: string };
    input_tokens: { micro_units: number; formatted: string };
    cached_input_tokens: { micro_units: number; formatted: string };
    output_tokens: { micro_units: number; formatted: string };
    reasoning_tokens: { micro_units: number; formatted: string };
  };
}

export interface MonthlyUsageRollup {
  tenant_id: string;
  plan: string;
  status: TenantStatus;
  billing_period: {
    year_month: string;
    start: string;
    end: string;
  };
  usage: {
    api_calls: {
      used: number;
      limit: number;
      remaining: number;
      percent_used: number;
    };
    tokens: {
      used: number;
      limit: number;
      remaining: number;
      percent_used: number;
      breakdown: TokenBreakdown;
    };
  };
  cost: TokenCostResult;
}
