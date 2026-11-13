import { detectSensorAnomalies } from "../../src/services/anomalyDetection.service";

describe("sensor anomaly detection", () => {
  it("detects an extreme value against a stable baseline", () => {
    const history = [10, 10, 11, 10, 9, 10].map((temperature) => ({ payload: { temperature } }));
    expect(detectSensorAnomalies({ temperature: 100 }, history)).toEqual([
      expect.objectContaining({ feature: "temperature", observed: 100, direction: "high" })
    ]);
  });

  it("does not flag normal values or insufficient history", () => {
    expect(detectSensorAnomalies({ temperature: 11 }, [{ payload: { temperature: 10 } }])).toEqual([]);
    expect(detectSensorAnomalies({ temperature: 10.01 }, Array.from({ length: 6 }, () => ({ payload: { temperature: 10 } })))).toEqual([]);
  });

  it("ignores non-numeric and non-finite values", () => {
    expect(detectSensorAnomalies({ status: "hot", temperature: Number.NaN }, [])).toEqual([]);
  });
});
