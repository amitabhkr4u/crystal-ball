import type { EventSeverity } from "../models/IoTEvent";

export interface Route {
  destination: string;
  priority: number;
  targetWindow: string;
}

export interface RoutedDecision extends Route {
  requiresHumanConfirmation: true;
  humanOverrideAvailable: true;
  physicalActionTriggered: false;
}

const ROUTES: Readonly<Record<EventSeverity, Route>> = Object.freeze({
  P0: { destination: "on_call", priority: 1, targetWindow: "immediate" },
  P1: { destination: "same_shift_triage", priority: 2, targetWindow: "same_shift" },
  P2: { destination: "morning_triage", priority: 5, targetWindow: "next_shift" },
  P3: { destination: "routine_triage", priority: 8, targetWindow: "routine" }
});

// Maps an alert severity to its routing destination and priority.
export function routeClassification(classification: { severity: EventSeverity }): RoutedDecision {
  // Own-property check: a severity like "toString" must not resolve to an inherited member.
  const route: Route | undefined = Object.hasOwn(ROUTES, classification.severity)
    ? ROUTES[classification.severity]
    : undefined;
  if (!route) throw new TypeError("Unsupported classification severity");
  return {
    ...route,
    requiresHumanConfirmation: true,
    humanOverrideAvailable: true,
    physicalActionTriggered: false
  };
}
