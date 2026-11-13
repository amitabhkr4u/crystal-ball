import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { getRedis } from "../db/redis";
import { withTenantTransaction } from "../db/tenantTransaction";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/authorize";
import { redisRateLimit } from "../middleware/redisRateLimit";
import { requireTenant } from "../middleware/tenantScope";
import { EVENT_SEVERITIES, IoTEvent } from "../models/IoTEvent";
import { getAiQueue } from "../queues/aiQueue";
import { getRoutingQueue } from "../queues/routingQueue";
import { routeClassification } from "../services/decisionRouter.service";
import type { HumanOverride } from "../types/routing";
import { hashId } from "../utils/hash";
import { sendError } from "../utils/httpResponse";
import { getAuth, getTenantId } from "../utils/requestContext";

export const alertRoutes: Router = Router();

const alertSchema = z.object({
  alertId: z.string().min(1).max(100),
  siteId: z.string().min(1).max(100),
  sensorId: z.string().min(1).max(100),
  severity: z.enum(EVENT_SEVERITIES),
  occurredAt: z.string().datetime(),
  payload: z.record(z.unknown())
});
const overrideSchema = z.object({
  severity: z.enum(EVENT_SEVERITIES),
  reason: z.string().trim().min(10).max(1000)
});

// True for MongoDB's duplicate-key error, which means the alert was already stored.
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

// Reads the operator summary from a stored classification; empty when it has none.
function operatorSummaryOf(classification: Record<string, unknown>): string {
  const summary = classification.operatorSummary;
  return typeof summary === "string" ? summary : "";
}

// Saves the alert and queues it for AI classification.
alertRoutes.post(
  "/classify",
  authenticate,
  requireTenant,
  requireRole("admin", "operator", "safety_lead"),
  redisRateLimit({ max: 60, windowMs: 60000, prefix: "rate:alert-classify" }),
  async (req, res, next) => {
    const parsed = alertSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid alert payload", parsed.error.issues);
    }
    if (!env.MONGODB_URI) {
      return sendError(res, 503, "MONGODB_NOT_CONFIGURED", "IoT event storage is unavailable");
    }
    const tenantId = getTenantId(req);
    const { alertId, siteId, sensorId, severity, occurredAt, payload } = parsed.data;
    try {
      try {
        await IoTEvent.create({
          tenantId,
          siteId,
          sensorId,
          severity,
          occurredAt: new Date(occurredAt),
          payload,
          dedupeKey: `${tenantId}:${alertId}`
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      const job = await getAiQueue().add(
        "classify-alert",
        { ...parsed.data, tenantId, history: [], retrievedDocs: [] },
        { jobId: hashId(tenantId, alertId) }
      );
      return res.status(202).json({ data: { jobId: job.id, status: "queued" } });
    } catch (error) {
      return next(error);
    }
  }
);

// Records that an operator has acknowledged an alert.
alertRoutes.post(
  "/:alertId/acknowledge",
  authenticate,
  requireTenant,
  requireRole("admin", "operator", "safety_lead"),
  redisRateLimit({ max: 60, windowMs: 60000, prefix: "rate:alert-acknowledge" }),
  async (req, res, next) => {
    const { alertId } = req.params;
    if (!alertId || alertId.length > 100) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid alert ID");
    }
    const tenantId = getTenantId(req);
    const actorUserId = getAuth(req).sub;
    try {
      const event = await IoTEvent.findOne({ tenantId, dedupeKey: `${tenantId}:${alertId}` });
      if (!event) return sendError(res, 404, "ALERT_NOT_FOUND", "Alert was not found for this tenant");
      if (!event.classification) {
        return sendError(res, 409, "CLASSIFICATION_PENDING", "Wait for the initial classification before acknowledging it");
      }

      const existing = event.classification as Record<string, unknown>;
      const acknowledgedAt = new Date().toISOString();
      const classification = {
        ...existing,
        acknowledgement: { by: actorUserId, at: acknowledgedAt }
      };
      event.classification = classification;
      await event.save();

      await withTenantTransaction(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            actorUserId,
            action: "ALERT_ACKNOWLEDGED",
            resourceType: "IoTEvent",
            resourceId: alertId,
            metadata: { acknowledgedAt }
          }
        })
      );

      await getRedis().publish(
        "ai:classification:completed",
        JSON.stringify({ ...classification, alertId, siteId: event.siteId, tenantId, processedAt: acknowledgedAt })
      );
      return res.json({ data: { alertId, classification } });
    } catch (error) {
      return next(error);
    }
  }
);

// Lets a human change an alert severity and re-routes it.
alertRoutes.post(
  "/:alertId/override",
  authenticate,
  requireTenant,
  requireRole("admin", "safety_lead"),
  redisRateLimit({ max: 20, windowMs: 60000, prefix: "rate:alert-override" }),
  async (req, res, next) => {
    const { alertId } = req.params;
    if (!alertId || alertId.length > 100) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid alert ID");
    }
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "A severity and a reason of at least 10 characters are required",
        parsed.error.issues
      );
    }
    const tenantId = getTenantId(req);
    const actorUserId = getAuth(req).sub;
    const { severity, reason } = parsed.data;
    try {
      const event = await IoTEvent.findOne({ tenantId, dedupeKey: `${tenantId}:${alertId}` });
      if (!event) return sendError(res, 404, "ALERT_NOT_FOUND", "Alert was not found for this tenant");
      if (!event.classification) {
        return sendError(
          res,
          409,
          "CLASSIFICATION_PENDING",
          "Wait for the initial classification before overriding it"
        );
      }

      const routing = routeClassification({ severity });
      const humanOverride: HumanOverride = { by: actorUserId, reason, at: new Date().toISOString() };
      const classification = {
        ...event.classification,
        severity,
        urgency: routing.targetWindow,
        routing,
        humanOverride
      };
      event.classification = classification;
      await event.save();

      await withTenantTransaction(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            actorUserId,
            action: "ALERT_CLASSIFICATION_OVERRIDDEN",
            resourceType: "IoTEvent",
            resourceId: alertId,
            metadata: { severity, reason }
          }
        })
      );

      await getRoutingQueue().add(
        "operator-routing",
        {
          tenantId,
          alertId,
          siteId: event.siteId,
          severity,
          routing,
          operatorSummary: operatorSummaryOf(classification),
          humanOverride
        },
        { jobId: hashId(tenantId, alertId, "override", Date.now()), priority: routing.priority }
      );
      await getRedis().publish(
        "ai:classification:completed",
        JSON.stringify({
          ...classification,
          alertId,
          siteId: event.siteId,
          tenantId,
          processedAt: new Date().toISOString()
        })
      );
      return res.json({ data: { alertId, classification } });
    } catch (error) {
      return next(error);
    }
  }
);
