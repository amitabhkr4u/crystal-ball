import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { getRedis } from "../db/redis";
import { getDeadLetterQueue } from "../queues/deadLetterQueue";
import { ROUTING_QUEUE_NAME } from "../queues/routingQueue";
import type { RoutingJobData } from "../types/routing";
import { errorMessage } from "../utils/errors";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 5;

export type DeliveryResult =
  | { delivered: true; status: number }
  | { delivered: false; reason: "not_configured" };

// The part of a BullMQ job the delivery reads (a full Job is assignable to it).
export type RoutingJob = Pick<Job<RoutingJobData, DeliveryResult>, "id" | "data">;

type SettingName = "ONCALL_WEBHOOK_URL" | "ONCALL_WEBHOOK_TOKEN" | "ONCALL_TIMEOUT_MS" | "NODE_ENV";

// Reads a setting from process.env first, then the parsed env.
function setting(name: SettingName): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const fromEnv = env[name];
  return fromEnv === undefined ? undefined : String(fromEnv);
}

// Sends the routed alert to the on-call webhook.
export async function deliverOnCall(job: RoutingJob): Promise<DeliveryResult> {
  const url = setting("ONCALL_WEBHOOK_URL");
  const nodeEnv = setting("NODE_ENV");
  if (!url) {
    if (nodeEnv === "production") throw new Error("ONCALL_WEBHOOK_URL is required in production");
    console.warn("[routing-worker] ONCALL_WEBHOOK_URL not configured; notification is not delivered");
    return { delivered: false, reason: "not_configured" };
  }

  const target = new URL(url);
  if (nodeEnv === "production" && target.protocol !== "https:") {
    throw new Error("On-call webhook must use HTTPS in production");
  }

  const token = setting("ONCALL_WEBHOOK_TOKEN");
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": String(job.id),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      event: "crystal-ball.alert.routed",
      alertId: job.data.alertId,
      tenantId: job.data.tenantId,
      siteId: job.data.siteId,
      severity: job.data.severity,
      summary: job.data.operatorSummary,
      routing: job.data.routing,
      humanOverride: job.data.humanOverride || null,
      requiresHumanConfirmation: true,
      physicalActionTriggered: false
    }),
    signal: AbortSignal.timeout(Number(setting("ONCALL_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`On-call provider returned HTTP ${response.status}`);
  return { delivered: true, status: response.status };
}

// Moves a job to the dead-letter queue after its last failed attempt.
export async function moveToDeadLetter(job: Job<RoutingJobData, DeliveryResult> | undefined, error: Error): Promise<void> {
  if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;
  try {
    await getDeadLetterQueue().add(
      "routing-delivery-failed",
      { originalJobId: job.id, payload: job.data, failure: error.message, failedAt: new Date().toISOString() },
      { jobId: `dead-${job.id}` }
    );
  } catch (deadLetterError) {
    console.error("[routing-worker] failed to persist dead-letter job:", errorMessage(deadLetterError));
  }
}

// Starts the BullMQ worker that delivers on-call notifications.
export function startRoutingWorker(): Worker<RoutingJobData, DeliveryResult> {
  const worker = new Worker<RoutingJobData, DeliveryResult>(ROUTING_QUEUE_NAME, deliverOnCall, {
    connection: getRedis(),
    concurrency: Number(env.ROUTING_WORKER_CONCURRENCY) || DEFAULT_CONCURRENCY
  });
  worker.on("failed", (job, error) => {
    void moveToDeadLetter(job, error);
  });
  return worker;
}
