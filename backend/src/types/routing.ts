import type { EventSeverity } from "../models/IoTEvent";
import type { RoutedDecision } from "../services/decisionRouter.service";

// Who changed a classification by hand, and why.
export interface HumanOverride {
  by: string;
  reason: string;
  at: string;
}

// The data of an "operator-routing" job: what the on-call webhook needs to know about one alert.
export interface RoutingJobData {
  tenantId: string;
  alertId: string;
  siteId: string;
  severity: EventSeverity;
  routing: RoutedDecision;
  operatorSummary: string;
  humanOverride?: HumanOverride;
}

// A routing job that ran out of attempts, kept for manual follow-up.
export interface DeadLetterJobData {
  originalJobId: string | undefined;
  payload: RoutingJobData;
  failure: string;
  failedAt: string;
}
