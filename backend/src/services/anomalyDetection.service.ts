export interface DetectedAnomaly {
  feature: string;
  observed: number;
  baselineMedian: number;
  robustZScore: number;
  direction: "high" | "low";
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

function numericPayload(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

// Flags numeric sensor fields that diverge materially from at least five prior readings.
export function detectSensorAnomalies(
  currentPayload: unknown,
  history: readonly unknown[],
  threshold = 3.5
): DetectedAnomaly[] {
  const current = numericPayload(currentPayload);
  const prior = history.map((event) => {
    if (!event || typeof event !== "object") return {};
    return numericPayload((event as { payload?: unknown }).payload);
  });
  const detected: DetectedAnomaly[] = [];

  for (const [feature, observed] of Object.entries(current)) {
    const baseline = prior
      .map((reading) => reading[feature])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (baseline.length < 5) continue;

    const center = median(baseline);
    const deviations = baseline.map((value) => Math.abs(value - center));
    const mad = median(deviations);
    const scale = mad > 0 ? 1.4826 * mad : Math.sqrt(
      baseline.reduce((sum, value) => sum + (value - center) ** 2, 0) / baseline.length
    );
    if (scale === 0) continue;
    const score = (observed - center) / scale;
    if (Math.abs(score) >= threshold) {
      detected.push({
        feature,
        observed,
        baselineMedian: center,
        robustZScore: Math.round(score * 100) / 100,
        direction: score > 0 ? "high" : "low"
      });
    }
  }
  return detected;
}
