import { describe, it, expect } from 'vitest';
import { PricingService } from '../src/services/pricing.service.js';
import { CONFIG } from '../src/config/index.js';

describe('PricingService — Exact Integer Money Math', () => {
  it('correctly prices standard fresh input tokens at 1 micro-unit per token', () => {
    const result = PricingService.calculateCost({ input_tokens: 1_000_000 }, false);
    // 1M tokens * $1.00/1M = $1.00 = 1,000,000 micro-units
    expect(result.input_token_micro_units).toBe(1_000_000);
    expect(result.total_cost_micro_units).toBe(1_000_000);
    expect(result.total_cost_formatted).toBe('$1.0000');
  });

  it('prices cached input tokens at 75% discount (0.25 micro-units per token)', () => {
    const result = PricingService.calculateCost({ cached_input_tokens: 1_000_000 }, false);
    // 1M cached tokens * $0.25/1M = $0.25 = 250,000 micro-units
    expect(result.cached_input_token_micro_units).toBe(250_000);
    expect(result.total_cost_micro_units).toBe(250_000);
    expect(result.total_cost_formatted).toBe('$0.2500');
  });

  it('prices reasoning tokens exactly identical to output tokens', () => {
    const outputOnly = PricingService.calculateCost({ output_tokens: 500 }, false);
    const reasoningOnly = PricingService.calculateCost({ reasoning_tokens: 500 }, false);

    expect(outputOnly.output_token_micro_units).toBe(2000); // 500 * 4
    expect(reasoningOnly.reasoning_token_micro_units).toBe(2000); // 500 * 4
    expect(outputOnly.total_cost_micro_units).toBe(reasoningOnly.total_cost_micro_units);
  });

  it('handles multi-category combination without floating point drift', () => {
    const result = PricingService.calculateCost({
      input_tokens: 12345,
      cached_input_tokens: 6789,
      output_tokens: 2345,
      reasoning_tokens: 1111,
    }, true);

    // Verify each integer subcomponent
    const expectedApi = 1000;
    const expectedInput = 12345 * 1;
    const expectedCached = Math.floor((6789 * 25) / 100); // 1697
    const expectedOutput = 2345 * 4; // 9380
    const expectedReasoning = 1111 * 4; // 4444
    const expectedTotal = expectedApi + expectedInput + expectedCached + expectedOutput + expectedReasoning;

    expect(result.api_call_micro_units).toBe(expectedApi);
    expect(result.input_token_micro_units).toBe(expectedInput);
    expect(result.cached_input_token_micro_units).toBe(expectedCached);
    expect(result.output_token_micro_units).toBe(expectedOutput);
    expect(result.reasoning_token_micro_units).toBe(expectedReasoning);
    expect(result.total_cost_micro_units).toBe(expectedTotal);
    expect(Number.isInteger(result.total_cost_micro_units)).toBe(true);
  });
});
