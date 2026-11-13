import { calculateLlmCost } from "../../src/services/llmCost.service";

describe("LLM cost calculation", () => {
  it("calculates input and output charges per million tokens", () => {
    expect(calculateLlmCost(1_000_000, 500_000, 3, 15)).toEqual({
      inputCostUsd: 3,
      outputCostUsd: 7.5,
      totalCostUsd: 10.5
    });
  });

  it("clamps negative token counts to zero", () => {
    expect(calculateLlmCost(-5, 0, 3, 15).totalCostUsd).toBe(0);
  });

  it("rounds fractional costs to six decimal places", () => {
    expect(calculateLlmCost(1, 1, 3, 15).totalCostUsd).toBe(0.000018);
  });
});
