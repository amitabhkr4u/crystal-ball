import {
  ApprovalsResponseSchema,
  DoneEventSchema,
  ErrorBodySchema,
  ErrorEventSchema,
  HealthResponseSchema,
  MetaEventSchema,
  TokenEventSchema,
  type Approval,
  type MetaEvent
} from "./schemas";

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
const JSON_HEADERS = { "Content-Type": "application/json" };

export type AiPath = "summary" | "talk" | "help" | "teach" | "greeting";

export type StreamEvent =
  | { type: "meta"; data: MetaEvent }
  | { type: "token"; text: string }
  | { type: "done"; fallback: boolean }
  | { type: "error"; code: string; message: string };

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  tenantId: string;
  role: string;
}

export interface AuthPayload {
  accessToken: string;
  user: AuthUser;
}

export interface AlertClassification {
  severity: string;
  urgency: string;
  operatorSummary: string;
  fallback: boolean;
  routing?: { destination: string; targetWindow: string };
  acknowledgement?: { by: string; at: string };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Builds the full URL for an API path.
const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

// Builds JSON headers that carry the access token.
const authHeaders = (accessToken: string) => ({ ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` });

// Returns an error message from any thrown value.
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// Calls the API and returns the parsed JSON body.
async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), options);
  } catch {
    throw new ApiError("NETWORK", "The API service could not be reached.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { error?: { message?: string } }).error?.message || "The request could not be completed.";
    throw new ApiError("HTTP_ERROR", message);
  }
  return body as T;
}

// Posts JSON with the access token and returns the data field.
async function postAuthed<T>(path: string, accessToken: string, payload: unknown): Promise<T> {
  const body = await requestJson<{ data: T }>(path, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload)
  });
  return body.data;
}

// Restores the session from the refresh cookie.
export async function refreshSession(): Promise<AuthPayload> {
  const body = await requestJson<{ data: AuthPayload }>("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "same-origin"
  });
  return body.data;
}

// Signs the user in and returns the access token and user.
export async function loginUser(input: { email: string; password: string; tenantSlug: string }): Promise<AuthPayload> {
  const body = await requestJson<{ data: AuthPayload }>("/api/v1/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input)
  });
  return body.data;
}

// Signs the user out and clears the refresh cookie.
export async function logoutUser(): Promise<void> {
  await requestJson<void>("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
}

// Queues an alert for AI classification.
export function classifyAlert(accessToken: string, payload: unknown): Promise<{ jobId: string; status: string }> {
  return postAuthed("/api/v1/alerts/classify", accessToken, payload);
}

// Applies a human override to an alert classification.
export function overrideAlert(
  accessToken: string,
  alertId: string,
  payload: { severity: string; reason: string }
): Promise<{ classification: AlertClassification }> {
  return postAuthed(`/api/v1/alerts/${encodeURIComponent(alertId)}/override`, accessToken, payload);
}

// Marks an alert as acknowledged by the signed-in operator.
export function acknowledgeAlert(
  accessToken: string,
  alertId: string
): Promise<{ alertId: string; classification: AlertClassification }> {
  return postAuthed(`/api/v1/alerts/${encodeURIComponent(alertId)}/acknowledge`, accessToken, {});
}

// Creates the error used for a bad streaming frame.
const badFrame = (detail: string) =>
  new ApiError("BAD_FRAME", `The assistant sent an unexpected response (${detail}).`);

// Parses and validates one SSE frame, ignoring unknown events.
export function parseFrame(frame: string): StreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(dataLines.join("\n"));
  } catch {
    throw badFrame("invalid JSON");
  }

  switch (event) {
    case "meta": {
      const result = MetaEventSchema.safeParse(json);
      if (!result.success) throw badFrame("meta failed validation");
      return { type: "meta", data: result.data };
    }
    case "token": {
      const result = TokenEventSchema.safeParse(json);
      if (!result.success) throw badFrame("token failed validation");
      return { type: "token", text: result.data.text };
    }
    case "done": {
      const result = DoneEventSchema.safeParse(json);
      if (!result.success) throw badFrame("done failed validation");
      return { type: "done", fallback: result.data.fallback };
    }
    case "error": {
      const result = ErrorEventSchema.safeParse(json);
      if (!result.success) throw badFrame("error failed validation");
      return { type: "error", code: result.data.code, message: result.data.message };
    }
    default:
      return null;
  }
}

// Loads the pending approvals list.
export async function fetchApprovals(): Promise<Approval[]> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/approvals"));
  } catch {
    throw new ApiError("NETWORK", "Could not load approvals.");
  }
  if (!response.ok) throw new ApiError("HTTP_ERROR", "Could not load approvals.");
  return ApprovalsResponseSchema.parse(await response.json()).approvals;
}

// Checks if the API is up, and returns false on any failure.
export async function fetchHealth(): Promise<boolean> {
  try {
    const response = await fetch(apiUrl("/api/health"));
    return response.ok && HealthResponseSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

// Turns a failed response into an ApiError with the server message.
async function errorFromResponse(response: Response): Promise<ApiError> {
  const generic = () => new ApiError("HTTP_ERROR", "The assistant is unavailable right now. Please try again.");
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) return new ApiError(parsed.data.error.code, parsed.data.error.message);
  } catch {
    return generic();
  }
  return generic();
}

// Converts Windows line endings to plain newlines.
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

// Posts to an AI endpoint and yields validated events as they arrive.
export async function* streamAi(
  path: AiPath,
  body: unknown,
  opts: { sessionId: string; signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/ai/${path}`), {
      method: "POST",
      headers: { ...JSON_HEADERS, Accept: "text/event-stream", "X-Session-Id": opts.sessionId },
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new ApiError("NETWORK", "Cannot reach the assistant service. Check your connection and retry.");
  }

  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ApiError("NO_STREAM", "The assistant did not return a stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += normalize(decoder.decode(value, { stream: true }));
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) yield event;
    }
  }

  buffer += normalize(decoder.decode());
  if (buffer.trim()) {
    const event = parseFrame(buffer);
    if (event) yield event;
  }
}
