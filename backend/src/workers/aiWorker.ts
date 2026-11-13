import { UnrecoverableError, Worker, type Job } from "bullmq";
import { z } from "zod";
import { env } from "../config/env";
import { getRedis } from "../db/redis";
import { IoTEvent } from "../models/IoTEvent";
import { getRoutingQueue } from "../queues/routingQueue";
import { searchMaintenanceChunks, type MaintenanceChunkMatch } from "../rag/maintenanceSearch.service";
import { classifyAlert, type ClassificationResponse } from "../services/aiDecision.service";
import { detectSensorAnomalies } from "../services/anomalyDetection.service";
import { sensorAnomalies } from "../observability/metrics";
import { routeClassification, type RoutedDecision } from "../services/decisionRouter.service";
import { createEmbedding } from "../services/embedding.service";
import type { AlertJobData } from "../types/alert";
import { errorMessage } from "../utils/errors";
import { hashId } from "../utils/hash";

const CLASSIFY_JOB = "classify-alert";
const HISTORY_LIMIT = 12;
const RELATED_DOC_LIMIT = 5;
const CONCURRENCY = 5;

// The ids every query below is scoped by; the rest of the payload is sensor-specific.
const alertJobSchema = z
  .object({
    tenantId: z.string().min(1),
    alertId: z.string().min(1),
    siteId: z.string().min(1),
    sensorId: z.string().min(1)
  })
  .passthrough();

export type AlertJobResult = ClassificationResponse & {
  routing: RoutedDecision;
  anomalyDetection: ReturnType<typeof detectSensorAnomalies>;
  alertId: string;
  siteId: string;
  tenantId: string;
  processedAt: string;
};

// The part of a BullMQ job this worker reads (a full Job is assignable to it).
export type AlertJob = Pick<Job<AlertJobData, AlertJobResult>, "name" | "data">;

// Finds maintenance document chunks related to the alert.
export async function findRelatedDocs(
  alert: AlertJobData,
  history: readonly unknown[]
): Promise<MaintenanceChunkMatch[]> {
  try {
    const embedding = await createEmbedding(JSON.stringify({ alert, recentHistory: history }), alert.tenantId);
    if (!embedding) return [];
    return await searchMaintenanceChunks({ tenantId: alert.tenantId, embedding, limit: RELATED_DOC_LIMIT });
  } catch (error) {
    console.warn("[worker] RAG retrieval skipped:", errorMessage(error));
    return [];
  }
}

// Reads the job data, failing without retries when the tenant scope is missing.
function readJobData(job: AlertJob): AlertJobData {
  if (job.name !== CLASSIFY_JOB) throw new UnrecoverableError(`Unsupported AI job: ${job.name}`);
  const parsed = alertJobSchema.safeParse(job.data);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new UnrecoverableError(`Invalid AI job data: ${fields}`);
  }
  return parsed.data;
}

// Classifies one alert, routes it and tells connected operators.
export async function processAlertJob(job: AlertJob): Promise<AlertJobResult> {
  const alert = readJobData(job);
  const { tenantId, alertId, siteId, sensorId } = alert;

  const history = await IoTEvent.find({ tenantId, siteId, sensorId, dedupeKey: { $ne: `${tenantId}:${alertId}` } })
    .sort({ occurredAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  const retrievedDocs = await findRelatedDocs(alert, history);
  const result = await classifyAlert({ alert, history, retrievedDocs });
  const anomalyDetection = detectSensorAnomalies(alert.payload, history);
  for (const anomaly of anomalyDetection) sensorAnomalies.inc({ direction: anomaly.direction });
  const routing = routeClassification(result);
  const payload: AlertJobResult = {
    ...result,
    routing,
    anomalyDetection,
    alertId,
    siteId,
    tenantId,
    processedAt: new Date().toISOString()
  };

  await getRoutingQueue().add(
    "operator-routing",
    { tenantId, alertId, siteId, severity: result.severity, routing, operatorSummary: result.operatorSummary },
    { jobId: hashId(tenantId, alertId, "route"), priority: routing.priority }
  );
  await IoTEvent.updateOne({ tenantId, dedupeKey: `${tenantId}:${alertId}` }, { $set: { classification: { ...payload } } });
  await getRedis().publish("ai:classification:completed", JSON.stringify(payload));
  return payload;
}

// Starts the BullMQ worker that classifies alerts.
export function startAiWorker(): Worker<AlertJobData, AlertJobResult> {
  return new Worker<AlertJobData, AlertJobResult>(env.AI_QUEUE_NAME, processAlertJob, {
    connection: getRedis(),
    concurrency: CONCURRENCY
  });
}
