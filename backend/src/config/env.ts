import "dotenv/config";
import { z } from "zod";

// Turns an empty string into undefined so optional values validate.
const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().optional(),
  MONGODB_URI: z.string().optional(),
  MYSQL_HOST: z.string().optional(),
  MYSQL_READ_HOST: z.string().optional(),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().optional(),
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_DATABASE: z.string().optional(),
  MYSQL_POOL_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  ERP_WORK_ORDERS_TABLE: z.string().optional(),
  ERP_WORK_ORDER_ID_COLUMN: z.string().optional(),
  ERP_ASSET_CODE_COLUMN: z.string().optional(),
  ERP_STATUS_COLUMN: z.string().optional(),
  ERP_DESCRIPTION_COLUMN: z.string().optional(),
  ERP_SCHEDULED_AT_COLUMN: z.string().optional(),
  ERP_COMPLETED_AT_COLUMN: z.string().optional(),
  ERP_READONLY_PROCEDURES: z.string().default(""),
  REDIS_URL: z.string().optional(),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  // jsonwebtoken accepts "15m", "2h", "7d" and similar; checking the shape here keeps a
  // typo from reaching the signing call.
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+(ms|s|m|h|d|w|y)$/, "must look like 15m, 2h or 7d")
    .default("15m"),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().default(2592000),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_API_URL: z.string().url().default("https://api.openai.com/v1/embeddings"),
  EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDINGS_INPUT_USD_PER_MILLION: z.coerce.number().min(0).default(0.02),
  ONCALL_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ONCALL_WEBHOOK_TOKEN: z.string().optional(),
  ONCALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ROUTING_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  LLM_TIMEOUT_MS: z.coerce.number().default(8000),
  LLM_INPUT_USD_PER_MILLION: z.coerce.number().min(0).default(3),
  LLM_OUTPUT_USD_PER_MILLION: z.coerce.number().min(0).default(15),
  LLM_DAILY_BUDGET_USD: z.coerce.number().min(0).default(0),
  LLM_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  LLM_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  LLM_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000),
  AI_QUEUE_NAME: z.string().default("ai-decisions"),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  METRICS_TOKEN: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

// Validates a set of environment variables and returns the typed config.
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.message}`);
  return parsed.data;
}

export const env: Env = parseEnv(process.env);
