import type { EventSeverity } from "../../src/models/IoTEvent";
import { routeClassification } from "../../src/services/decisionRouter.service";

describe("deterministic alert decision routing", () => {
  it("routes P0 alerts to on-call with human confirmation retained", () => {
    expect(routeClassification({ severity: "P0" })).toMatchObject({
      destination: "on_call",
      targetWindow: "immediate",
      requiresHumanConfirmation: true,
      humanOverrideAvailable: true,
      physicalActionTriggered: false
    });
  });

  it("routes P2 alerts to morning triage", () => {
    expect(routeClassification({ severity: "P2" }).destination).toBe("morning_triage");
  });

  it("routes every severity with a distinct priority", () => {
    const severities: EventSeverity[] = ["P0", "P1", "P2", "P3"];
    const priorities = severities.map((severity) => routeClassification({ severity }).priority);
    expect(new Set(priorities).size).toBe(4);
  });

  it("rejects unknown severities, including inherited object members", () => {
    for (const severity of ["P9", "toString", "constructor", ""]) {
      expect(() => routeClassification({ severity: severity as unknown as EventSeverity })).toThrow(
        "Unsupported classification severity"
      );
    }
  });
});
