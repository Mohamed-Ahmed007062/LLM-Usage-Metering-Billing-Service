import dotenv from 'dotenv';
dotenv.config();

export interface PricingConfig {
  pricePerApiCallMicroUnits: number; // e.g. 1000 = $0.001
  pricePerInputTokenMicroUnits: number; // e.g. 1 = $1.00 / 1M tokens
  pricePerCachedInputTokenDiscountRate: number; // 75% discount -> 0.25 effective rate
  pricePerOutputTokenMicroUnits: number; // e.g. 4 = $4.00 / 1M tokens
  pricePerReasoningTokenMicroUnits: number; // e.g. 4 = $4.00 / 1M tokens (same as output)
}

export interface PlanConfig {
  id: string;
  name: string;
  maxApiCalls: number;
  maxTokens: number;
  priceCents: number;
}

export const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databasePath: process.env.DATABASE_PATH || './data/billing.db',
  
  // Stripe configuration
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key_for_testing',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy_secret_for_testing',
  stripeProPriceId: process.env.STRIPE_PRO_PRICE_ID || 'price_pro_monthly_test',

  // Pinned pricing constants (all in integer micro-units: 1 USD = 1,000,000 micro-units, 1 cent = 10,000 micro-units)
  pricing: {
    pricePerApiCallMicroUnits: 1000, // $0.001 per API call
    pricePerInputTokenMicroUnits: 1, // $1.00 per 1M tokens
    pricePerCachedInputTokenDiscountRate: 75, // 75% discount: effective cost = input * 25 / 100
    pricePerOutputTokenMicroUnits: 4, // $4.00 per 1M tokens
    pricePerReasoningTokenMicroUnits: 4, // Reasoning tokens priced as output tokens
  } as const,

  // Plan tiers and quotas
  plans: {
    free: {
      id: 'free',
      name: 'Free Plan',
      maxApiCalls: parseInt(process.env.PLAN_FREE_API_CALLS_LIMIT || '1000', 10),
      maxTokens: parseInt(process.env.PLAN_FREE_TOKENS_LIMIT || '100000', 10),
      priceCents: 0,
    },
    pro: {
      id: 'pro',
      name: 'Pro Plan',
      maxApiCalls: parseInt(process.env.PLAN_PRO_API_CALLS_LIMIT || '50000', 10),
      maxTokens: parseInt(process.env.PLAN_PRO_TOKENS_LIMIT || '5000000', 10),
      priceCents: 2900, // $29.00 / month
    },
  } as Record<string, PlanConfig>,
};
