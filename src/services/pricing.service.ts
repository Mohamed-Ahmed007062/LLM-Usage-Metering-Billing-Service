import { CONFIG } from '../config/index.js';
import { TokenBreakdown, TokenCostResult } from '../types/index.js';

export class PricingService {
  /**
   * Calculates the exact integer cost (in micro-units: 1 USD = 1,000,000 micro-units)
   * for a billable action containing API call and simulated tokens.
   *
   * Pricing rules:
   * 1. Cached input tokens are discounted (75% cheaper, effectively 25% of input token price).
   * 2. Reasoning tokens count as output tokens.
   * 3. Token categories cannot simply be added together before pricing.
   * 4. Zero floating point drift — strictly integer arithmetic.
   */
  static calculateCost(
    tokens: Partial<TokenBreakdown> = {},
    includeApiCall = true
  ): TokenCostResult {
    const inputTokens = Math.max(0, Math.floor(tokens.input_tokens || 0));
    const cachedInputTokens = Math.max(0, Math.floor(tokens.cached_input_tokens || 0));
    const outputTokens = Math.max(0, Math.floor(tokens.output_tokens || 0));
    const reasoningTokens = Math.max(0, Math.floor(tokens.reasoning_tokens || 0));

    // Base API call cost (integer micro-units)
    const apiCallMicroUnits = includeApiCall ? CONFIG.pricing.pricePerApiCallMicroUnits : 0;

    // Standard fresh input token cost (1 micro-unit per token)
    const inputTokenMicroUnits = inputTokens * CONFIG.pricing.pricePerInputTokenMicroUnits;

    // Cached input token cost (25% of fresh input price)
    // Using integer math: floor((tokens * 25) / 100)
    const cachedInputTokenMicroUnits = Math.floor(
      (cachedInputTokens * (100 - CONFIG.pricing.pricePerCachedInputTokenDiscountRate)) / 100
    );

    // Output token cost (4 micro-units per token)
    const outputTokenMicroUnits = outputTokens * CONFIG.pricing.pricePerOutputTokenMicroUnits;

    // Reasoning tokens count as output tokens (4 micro-units per token)
    const reasoningTokenMicroUnits = reasoningTokens * CONFIG.pricing.pricePerReasoningTokenMicroUnits;

    // Total cost in micro-units (integer sum)
    const totalCostMicroUnits =
      apiCallMicroUnits +
      inputTokenMicroUnits +
      cachedInputTokenMicroUnits +
      outputTokenMicroUnits +
      reasoningTokenMicroUnits;

    const totalCostCents = Math.floor(totalCostMicroUnits / 10000);
    const totalCostFormatted = `$${(totalCostMicroUnits / 1000000).toFixed(4)}`;

    return {
      api_call_micro_units: apiCallMicroUnits,
      input_token_micro_units: inputTokenMicroUnits,
      cached_input_token_micro_units: cachedInputTokenMicroUnits,
      output_token_micro_units: outputTokenMicroUnits,
      reasoning_token_micro_units: reasoningTokenMicroUnits,
      total_cost_micro_units: totalCostMicroUnits,
      total_cost_cents: totalCostCents,
      total_cost_formatted: totalCostFormatted,
      breakdown: {
        api_calls: {
          micro_units: apiCallMicroUnits,
          formatted: `$${(apiCallMicroUnits / 1000000).toFixed(4)}`,
        },
        input_tokens: {
          micro_units: inputTokenMicroUnits,
          formatted: `$${(inputTokenMicroUnits / 1000000).toFixed(4)}`,
        },
        cached_input_tokens: {
          micro_units: cachedInputTokenMicroUnits,
          formatted: `$${(cachedInputTokenMicroUnits / 1000000).toFixed(4)}`,
        },
        output_tokens: {
          micro_units: outputTokenMicroUnits,
          formatted: `$${(outputTokenMicroUnits / 1000000).toFixed(4)}`,
        },
        reasoning_tokens: {
          micro_units: reasoningTokenMicroUnits,
          formatted: `$${(reasoningTokenMicroUnits / 1000000).toFixed(4)}`,
        },
      },
    };
  }
}
