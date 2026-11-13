export const openApi = {
  openapi: "3.0.3",
  info: { title: "Crystal Ball Command Centre API", version: "1.0.0" },
  servers: [{ url: "http://localhost:4000" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string" }, message: { type: "string" } }
          }
        }
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password", "tenantSlug"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, maxLength: 128 },
          tenantSlug: { type: "string", minLength: 2, maxLength: 80 }
        }
      },
      RefreshRequest: { type: "object", properties: { refreshToken: { type: "string", description: "Optional when the cb_refresh HttpOnly cookie is present" } } },
      AlertClassificationRequest: {
        type: "object",
        required: ["alertId", "siteId", "sensorId", "severity", "occurredAt", "payload"],
        properties: {
          alertId: { type: "string" },
          siteId: { type: "string" },
          sensorId: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          occurredAt: { type: "string", format: "date-time" },
          payload: { type: "object", additionalProperties: true }
        }
      },
      UploadPresignRequest: {
        type: "object",
        required: ["fileName", "contentType", "sizeBytes"],
        properties: {
          fileName: { type: "string" },
          contentType: { type: "string", enum: ["image/jpeg", "image/png", "application/pdf", "video/mp4"] },
          sizeBytes: { type: "integer", maximum: 104857600 }
        }
      },
      UploadCompleteRequest: { type: "object", required: ["objectKey"], properties: { objectKey: { type: "string" } } },
      MaintenanceIndexRequest: {
        type: "object",
        required: ["documentId", "text"],
        properties: {
          documentId: { type: "string", maxLength: 180 },
          text: { type: "string", minLength: 20, maxLength: 240000 },
          metadata: { type: "object", additionalProperties: true }
        }
      },
      AlertOverrideRequest: {
        type: "object",
        required: ["severity", "reason"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          reason: { type: "string", minLength: 10, maxLength: 1000 }
        }
      }
    }
  },
  paths: {
    "/api/v1/auth/login": {
      post: {
        summary: "Authenticate a tenant user and issue RS256 tokens",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } }
        },
        responses: {
          200: { description: "Token pair" },
          400: { description: "Invalid request" },
          401: { description: "Invalid credentials" }
        }
      }
    },
    "/api/v1/auth/logout": {
      post: {
        summary: "Revoke the refresh token and clear its HttpOnly cookie",
        responses: { 204: { description: "Logged out" } }
      }
    },
    "/api/v1/auth/refresh": {
      post: {
        summary: "Rotate a single-use refresh token",
        description: "Uses the cb_refresh HttpOnly cookie; an optional refreshToken body is supported for non-browser clients.",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RefreshRequest" } } }
        },
        responses: { 200: { description: "Rotated token pair; refresh cookie is rotated" }, 401: { description: "Invalid refresh token" } }
      }
    },
    "/api/v1/usage/llm/daily": {
      get: {
        summary: "Return the authenticated tenant's current UTC-day LLM token and spend totals",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Tenant daily usage and budget state" },
          401: { description: "Bearer token required" },
          403: { description: "Tenant context required" }
        }
      }
    },
    "/api/v1/alerts/{alertId}/acknowledge": {
      post: {
        summary: "Acknowledge an alert as the signed-in operator",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "alertId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Alert acknowledged and audit record created" },
          403: { description: "Role is not allowed" },
          404: { description: "Alert not found" },
          409: { description: "Initial classification is pending" }
        }
      }
    },
    "/api/v1/alerts/{alertId}/override": {
      post: {
        summary: "Apply an audited human override to an AI alert classification",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "alertId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AlertOverrideRequest" } } }
        },
        responses: {
          200: { description: "Override applied and routing handoff queued" },
          403: { description: "Role is not allowed" },
          404: { description: "Alert not found" },
          409: { description: "Initial classification is pending" }
        }
      }
    },
    "/api/v1/alerts/classify": {
      post: {
        summary: "Queue a tenant-scoped AI alert classification",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AlertClassificationRequest" } } }
        },
        responses: {
          202: { description: "Classification queued" },
          400: { description: "Invalid alert payload" },
          401: { description: "Bearer token required" }
        }
      }
    },
    "/api/v1/maintenance-documents/index": {
      post: {
        summary: "Chunk, embed and tenant-scope a maintenance document in pgvector",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceIndexRequest" } } }
        },
        responses: {
          201: { description: "Document indexed" },
          400: { description: "Invalid document payload" },
          503: { description: "Embedding provider unavailable" }
        }
      }
    },
    "/api/v1/erp/work-orders/{assetCode}": {
      get: {
        summary: "Read maintenance work orders from the external ERP/CMMS read replica",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "assetCode", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } }
        ],
        responses: {
          200: { description: "ERP work orders" },
          503: { description: "ERP schema mapping is not configured" }
        }
      }
    },
    "/api/v1/uploads/complete": {
      post: {
        summary: "Verify a quarantined upload with ClamAV and MIME signature checks before promotion",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UploadCompleteRequest" } } }
        },
        responses: {
          200: { description: "Object passed malware and MIME checks and was promoted to clean storage" },
          422: { description: "Malware or invalid file signature" },
          503: { description: "Scanner unavailable; object remains quarantined" }
        }
      }
    },
    "/api/v1/uploads/presign": {
      post: {
        summary: "Create a tenant-scoped S3 upload URL in quarantine",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UploadPresignRequest" } } }
        },
        responses: { 201: { description: "Upload URL created" }, 400: { description: "Invalid file metadata" } }
      }
    },
    "/api/health": { get: { summary: "Liveness check", responses: { 200: { description: "API process is alive" } } } },
    "/api/ready": { get: { summary: "Readiness check", responses: { 200: { description: "Configured dependencies are ready" }, 503: { description: "One or more configured dependencies are unavailable" } } } },
    "/api/approvals": { get: { summary: "List pending approvals", responses: { 200: { description: "Approvals" } } } },
    "/api/ai/summary": {
      post: { summary: "Stream approval summary", responses: { 200: { description: "Server-sent events" } } }
    },
    "/api/ai/talk": {
      post: { summary: "Talk to assistant", responses: { 200: { description: "Server-sent events" } } }
    },
    "/api/ai/help": {
      post: { summary: "Ask policy questions", responses: { 200: { description: "Server-sent events" } } }
    },
    "/api/ai/teach": {
      post: { summary: "Learn approval workflow", responses: { 200: { description: "Server-sent events" } } }
    },
    "/api/ai/greeting": {
      post: { summary: "Replay greeting", responses: { 200: { description: "Server-sent events" } } }
    }
  }
};
