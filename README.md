# Crystal Ball Command Centre

## Project overview

Crystal Ball is a multi-tenant operations command centre built with Next.js, React, Node.js, Express and TypeScript. It brings operational approvals, IoT alert handling, AI-assisted classification, maintenance knowledge retrieval and live operator updates into one application.

The project is organised around clear ownership of the frontend, API, background processing and data stores. The implementation includes authentication and role-based access control, tenant-scoped operations, API documentation, automated tests, Docker deployment, monitoring configuration and operational documentation.

## Why Docker is used

Docker is the standard way to run this project locally. The application and its supporting services run in containers, so a developer or interviewer does not need to install Node.js, npm, MongoDB, PostgreSQL, Redis, MinIO, ClamAV or the frontend/backend packages directly on the host machine.

Docker builds the frontend and backend images and installs the Node.js packages inside the image build process using the committed lockfiles. Docker Compose starts the application and its supporting services together. The host machine only needs:

- Docker Desktop with Docker Compose v2 on Windows or macOS, or Docker Engine with the Compose plugin on Linux.
- Git, if the project is being cloned from a repository.
- A modern browser.

The first image build requires an internet connection to download base images and package dependencies. After the images have been built, containers can be started again without reinstalling project packages on the host. Docker does not remove the need for Docker itself or for valid service/API credentials where an external integration is enabled.

## Quick start for an interview or local review

The commands below are run from the directory containing `docker-compose.yml`.

### 1. Check Docker

```bash
docker --version
docker compose version
```

Start Docker Desktop first on Windows or macOS. Wait until its engine is running.

### 2. Create the environment files

Copy the root environment template and the backend template.

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
```

**macOS / Linux:**

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Open both `.env` files and replace the example secrets with strong local values. Do not commit either file.

In the root `.env`, set at least:

- `POSTGRES_PASSWORD` — password for the PostgreSQL owner account.
- `APP_DB_PASSWORD` — a different password for the restricted application database account.
- `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` — local MinIO administrator credentials.
- `S3_ACCESS_KEY` and `S3_SECRET_KEY` — credentials for the application bucket user.
- `GRAFANA_ADMIN_PASSWORD` — local Grafana administrator password.
- `S3_BUCKET` — keep the supplied bucket name unless you have a reason to change it.

In `backend/.env`, configure:

- `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` with an RSA key pair. Generate one inside a temporary Node container or on a machine that already has OpenSSL:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out jwt-private.pem
openssl rsa -pubout -in jwt-private.pem -out jwt-public.pem
```

  Copy each PEM value into the matching environment variable as one line, replacing line breaks with the literal `\n` sequence. Keep the private key secret.
- `CORS_ORIGIN=http://localhost:3000` for local browser access.
- `METRICS_TOKEN` with a long random value. Use the same value in `ops/metrics_token` if you intend to scrape the protected metrics endpoint.
- `ONCALL_WEBHOOK_URL` with an HTTPS webhook receiver URL. The current production-mode API startup check requires this setting. Use a test webhook endpoint for an interview environment; do not use a fake URL if you plan to test delivery.
- `SEED_ADMIN_PASSWORD` with a strong password if you want the migration container to create the demo tenant administrator.
- `ANTHROPIC_API_KEY` only if you want to demonstrate live Anthropic-powered responses. The application includes non-LLM fallback behaviour for supported assistant paths.

The Compose file runs the API with `NODE_ENV=production`, so its production configuration checks apply even for a local Docker demonstration. Keep credentials private and use test accounts and test data only.

### 3. Build and start the application

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

The first build can take several minutes because Docker downloads the base images and installs frontend/backend packages inside the build containers. PostgreSQL, MongoDB, Redis, MinIO and ClamAV are also started by Compose. The migration job prepares the PostgreSQL schema and application role before the API starts.

### 4. Open the application

| Service | Local URL | Purpose |
|---|---|---|
| Frontend | http://localhost:3000 | Next.js operator interface |
| API | http://localhost:4000 | Express API |
| Swagger UI | http://localhost:4000/api/docs | Interactive API documentation |
| OpenAPI JSON | http://localhost:4000/api/openapi.json | API contract |
| API health | http://localhost:4000/api/health | Liveness check |
| API readiness | http://localhost:4000/api/ready | Dependency readiness check |
| Prometheus | http://localhost:9090 | Metrics and targets; bound to localhost |
| Grafana | http://localhost:3001 | Dashboards; sign in with the root `.env` credentials |

The database services and MinIO are on the private Compose network and are not published as public host ports by the supplied Compose file.

### 5. Check logs and stop the stack

```bash
docker compose ps
docker compose logs --tail=150 api worker frontend migrate
docker compose down
```

`docker compose down` stops and removes the containers but retains named data volumes. To permanently remove the local database, object storage and monitoring data, `docker compose down -v` can be used; this is destructive and should not be used when data needs to be retained.

## Running automated checks in Docker

The build stages contain the source code and development dependencies. The final runtime images are intentionally smaller and do not include the complete test source tree. Build the test images from the existing Dockerfiles and run the test commands inside those images. No Node.js or npm installation is needed on the host.

Run from the repository root:

### Backend unit and integration tests

```bash
docker build --target build -t crystal-ball-backend-check ./backend
docker run --rm crystal-ball-backend-check npm test
```

Run backend type checking and Prisma validation:

```bash
docker run --rm crystal-ball-backend-check npm run typecheck
docker run --rm -e DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build crystal-ball-backend-check npm run prisma:validate
```

The backend build stage already runs Prisma Client generation and the configured TypeScript build. The Jest integration tests may require the Docker daemon to have enough memory and may download the MongoDB test binary the first time they run.

### Frontend checks

```bash
docker build --target build -t crystal-ball-frontend-check ./frontend
docker run --rm crystal-ball-frontend-check npm run lint
docker run --rm crystal-ball-frontend-check npm run typecheck
docker run --rm crystal-ball-frontend-check npm test
```

The frontend image build stage also runs the production Next.js build. Playwright browser tests and Pact contract tests are separate checks and may require browser binaries or a running provider, depending on the test configuration.

### Live API smoke test

Start the Compose stack and seed a demo administrator by setting `SEED_ADMIN_PASSWORD` before the first migration. Then run the smoke script from a backend test/build image with the API reachable from the container. For a container on the same Compose network, use the API service name and port:

```bash
docker run --rm --network crystal-ball_internal \
  -e API_BASE_URL=http://api:4000 \
  -e SMOKE_EMAIL=admin@example.test \
  -e SMOKE_PASSWORD='your-seed-password' \
  -e SMOKE_TENANT_SLUG=crystal-ball-demo \
  crystal-ball-backend-check npm run smoke:api
```

If Compose generated a different network name, find it with `docker network ls` and use the actual project network. The smoke test requires a seeded user with the required operator/admin permissions.

## Architecture and technology stack

### Frontend

- **Next.js 14 and React 18:** App Router-based operator interface.
- **TypeScript:** typed application code and API contracts.
- **Zustand:** shared client state.
- **Zod:** runtime validation of structured data.
- **Socket.IO client and Server-Sent Events:** live updates and streamed assistant responses.
- **Vitest, Testing Library, Playwright and Pact:** component, browser and contract testing tools.

### Backend

- **Node.js 20 and Express 4:** REST API and HTTP server.
- **TypeScript:** typed services, middleware and API implementation.
- **Mongoose:** MongoDB document models and IoT event access.
- **Prisma:** PostgreSQL schema, migrations and typed data access.
- **mysql2:** integration with externally managed ERP/CMMS MySQL schemas.
- **JWT and Redis:** access/refresh token handling, rate limits and shared runtime state.
- **BullMQ:** asynchronous AI and routing jobs.
- **Socket.IO:** tenant-scoped real-time event delivery.
- **Multer, AWS SDK and MinIO:** object upload and storage workflow.
- **ClamAV:** upload malware scanning.
- **Zod and Swagger/OpenAPI:** request validation and API documentation.

### AI and decision layer

- LLM-backed alert classification with structured output validation.
- Operator-facing assistant responses streamed to the frontend.
- Rule-based decision routing with human override support.
- Maintenance-document retrieval using embeddings and pgvector where configured.
- Anomaly detection assistance for sensor history.
- Timeout, retry, circuit-breaker and fallback handling around model calls.
- Token usage and configured cost tracking with daily budget notification support.

The application is designed to use deterministic rules when they are sufficient. LLM calls are reserved for tasks where language understanding or summarisation adds value. AI output is validated before it is used by application workflows, and human override remains available for operational decisions.

### Database and infrastructure responsibilities

| Technology | Responsibility |
|---|---|
| MongoDB | IoT events, event history, document-oriented records and change streams |
| PostgreSQL + pgvector | Tenant identity, users, memberships, RBAC, billing/audit records and vector retrieval |
| MySQL | Optional read-only integration with an external ERP/CMMS schema |
| Redis | Queue backing store, refresh-token state, rate-limit counters, Socket.IO pub/sub and short-lived cache |
| MinIO / S3 | Object storage for uploaded files |
| ClamAV | Malware scanning for uploaded files |
| Prometheus | Metrics collection and alert rules |
| Grafana | Operational dashboards |
| Docker Compose | Local orchestration of application and infrastructure containers |

## Request flow and code organisation

A typical frontend request follows this path:

1. A page or component calls the shared API client in `frontend/lib/api.ts`.
2. The Express route applies authentication, tenant scoping, validation and permission middleware as appropriate.
3. A controller coordinates the HTTP request and response.
4. A service applies business rules and calls the relevant database, queue or external provider.
5. The response is returned as JSON or streamed through SSE; live events are delivered through Socket.IO where applicable.

Important folders:

```text
backend/
  index.ts                 API server entry point
  src/config/              Environment and OpenAPI configuration
  src/controllers/         HTTP request and response handlers
  src/db/                  MongoDB, PostgreSQL, MySQL and Redis connections
  src/integrations/        External ERP integration
  src/middleware/          Authentication, tenant scope, permissions and errors
  src/models/              MongoDB models
  src/queues/              BullMQ queue definitions
  src/routes/              API route definitions and route registry
  src/services/            Business logic and provider integrations
  src/sockets/             Socket.IO gateway
  src/workers/             Background job processors
  prisma/                  PostgreSQL schema and migrations
  tests/                   Jest tests

frontend/
  app/                     Next.js App Router pages and styles
  components/              Reusable UI components
  lib/                     API client and runtime schemas
  store/                   Zustand state stores
  tests/                   Vitest and contract tests

docs/                      Deployment and operational documentation
ops/                       Prometheus and Grafana configuration
```

## API reference

The live Swagger UI at `/api/docs` is the authoritative interactive reference. Main routes include:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | API liveness and capability information |
| GET | `/api/ready` | Readiness of configured dependencies |
| GET | `/api/approvals` | Paginated approvals data |
| POST | `/api/v1/auth/login` | Tenant login and token issue |
| POST | `/api/v1/auth/refresh` | Refresh-token rotation |
| POST | `/api/v1/auth/logout` | Revoke the refresh session |
| POST | `/api/v1/alerts/classify` | Queue tenant-scoped alert classification |
| POST | `/api/v1/alerts/:alertId/acknowledge` | Record operator acknowledgement |
| POST | `/api/v1/alerts/:alertId/override` | Record a human classification override |
| GET | `/api/v1/usage/llm/daily` | Tenant-scoped daily LLM usage and cost summary |
| POST | `/api/v1/uploads/presign` | Create a tenant-scoped upload URL |
| POST | `/api/v1/uploads/complete` | Validate and scan an uploaded object |
| POST | `/api/v1/maintenance-documents/index` | Index maintenance document content |
| GET | `/api/v1/erp/work-orders/:assetCode` | Read work orders from configured ERP integration |
| POST | `/api/ai/summary` | Stream an approval summary using SSE |
| POST | `/api/ai/talk` | Stream an assistant conversation using SSE |
| GET | `/metrics` | Prometheus metrics endpoint; token-protected when configured |

## Environment and integration notes

- Keep `.env`, `backend/.env`, `frontend/.env.local`, private keys, webhook tokens and metrics credentials out of version control.
- Live Anthropic responses require a valid `ANTHROPIC_API_KEY`. Without it, only the implemented fallback paths are available.
- Embedding-based retrieval requires a configured embeddings provider and API key.
- MySQL ERP reads remain inactive until the external schema/table/column mapping and read-only credentials are supplied by the ERP owner.
- The current Compose deployment uses a single-node MongoDB replica set for change streams. It is suitable for local evaluation, not a high-availability production topology.
- For production, use a TLS reverse proxy, explicit CORS origins, managed secrets, backups, restricted network access and a non-superuser PostgreSQL application role with RLS enabled.

## Troubleshooting

**Docker command cannot connect to the daemon**

Start Docker Desktop or the Docker Engine service, wait for it to become ready, and retry `docker compose ps`.

**A container is still starting or unhealthy**

```bash
docker compose ps
docker compose logs --tail=200 postgres mongo redis minio clamav migrate api worker frontend
```

PostgreSQL and MongoDB perform initial setup on first launch. ClamAV downloads its signature database on first launch and can take additional time to become healthy.

**The API does not start**

Check that the root and backend environment files exist, required secrets are set, the webhook URL uses HTTPS, and the dependency services are healthy. Review `docker compose logs api migrate` for the exact startup error.

**The frontend cannot reach the API**

Check that the API health endpoint responds, the frontend container is running, and the Compose network is intact. Browser requests should use the configured same-origin/reverse-proxy path or the expected API URL.

**A port is already in use**

Change `WEB_PORT` or `API_PORT` in the root `.env` and recreate the affected containers with `docker compose up -d`.

**Resetting a local evaluation environment**

Use `docker compose down -v` only when you intentionally want to delete all named volumes and local database/object-store data. This cannot be undone.

## Interview walkthrough

A practical review can follow this sequence:

1. Start the stack using the Docker quick-start steps.
2. Open the frontend and explain the operator-facing dashboard and shared API client.
3. Open Swagger UI and walk through authentication, alert classification, acknowledgement and override endpoints.
4. Trace one request from the frontend API client through route middleware, controller and service to its data store or queue.
5. Explain why MongoDB, PostgreSQL, MySQL and Redis have separate responsibilities.
6. Review the AI decision flow: structured output, validation, queue processing, timeout/fallback behaviour and human override.
7. Show the Jest and Vitest test suites, then run the Docker-based checks above.
8. Explain the Docker Compose services, health checks, migration job, monitoring and operational safeguards.

Be clear about which integrations are configured in the demonstration environment. External ERP credentials, live LLM credentials, embeddings credentials and a real on-call webhook are environment-specific and should not be represented as active unless they have been configured and tested.

## Verification status

The source archive includes automated test suites, TypeScript configurations, Dockerfiles, Compose orchestration and deployment/monitoring configuration. The presence of a test or configuration file does not by itself mean that the test has passed. Run the Docker-based checks in this README and retain their actual output when presenting the project. Database-dependent, browser E2E, external provider and webhook checks require their corresponding services or credentials to be available.

## License and usage

This archive does not declare a separate open-source license. Confirm ownership and usage permissions before redistributing or deploying it outside the intended review or project environment.
