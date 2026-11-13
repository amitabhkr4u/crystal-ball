import type { EventSeverity } from "../models/IoTEvent";

// An alert as it travels through the AI queue. Sensor payloads vary per device, so unknown extra
// fields are allowed, but the fields the pipeline relies on are typed.
export interface AlertInput {
  tenantId?: string;
  siteId?: string;
  sensorId?: string;
  severity?: EventSeverity;
  [field: string]: unknown;
}

// The data of a "classify-alert" job. The ids are required here because the worker uses them to
// scope every database query to one tenant.
export interface AlertJobData extends AlertInput {
  tenantId: string;
  alertId: string;
  siteId: string;
  sensorId: string;
}
