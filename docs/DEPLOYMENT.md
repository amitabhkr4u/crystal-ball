# Crystal Ball production deployment

This Compose deployment provisions PostgreSQL + pgvector, MongoDB replica set, Redis, MinIO, ClamAV, API, AI/routing worker, Next.js frontend, Prometheus and Grafana.

## Prerequisites

- Docker Engine 25+ and Docker Compose v2
- A Linux host with persistent storage and backups
- A DNS name and TLS reverse proxy (Nginx/Caddy) in front of the frontend
- An HTTPS on-call webhook endpoint (required by the current production startup guard)
- Anthropic API key if live LLM responses are required; rule-based fallback remains available without it

## 1. Configure secrets

From the repository root:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Generate independent random values (hex avoids URL and shell quoting issues):

```bash
openssl rand -hex 32
```

Set the generated values in root `.env` for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `MINIO_ROOT_PASSWORD` and `GRAFANA_ADMIN_PASSWORD`. Set `MINIO_ROOT_USER`, `GRAFANA_ADMIN_USER`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` as well. The API uses the dedicated MinIO identity; the MinIO root credentials are only used by the one-shot bucket/user bootstrap.

In `backend/.env`, set at least:

- `NODE_ENV=production`
- `CORS_ORIGIN=https://your-domain.example`
- `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` as PEM values with line breaks represented by `\n`
- `ONCALL_WEBHOOK_URL` to an HTTPS endpoint and optionally `ONCALL_WEBHOOK_TOKEN`
- `METRICS_TOKEN` to a long random value
- `ANTHROPIC_API_KEY` if using Anthropic
- `LLM_INPUT_USD_PER_MILLION` and `LLM_OUTPUT_USD_PER_MILLION` to the current price for the configured `ANTHROPIC_MODEL`
- `LLM_DAILY_BUDGET_USD` to the daily per-tenant threshold
- `SEED_ADMIN_PASSWORD` for first-time demo/admin seeding
- `S3_BUCKET` should match root `.env`; Compose injects the root value into API runtime
- `AWS_REGION=ap-south-1`

Create an RSA key pair and copy each PEM into backend `.env` as one line with literal `\n` between lines:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out jwt-private.pem
openssl rsa -pubout -in jwt-private.pem -out jwt-public.pem
```

Do not commit either `.env` file, private keys, `ops/metrics_token`, or database credentials. Keep a protected backup of the keys: replacing them invalidates existing access/refresh tokens.

Create the Prometheus token file using the exact same value as `METRICS_TOKEN`:

```bash
cp ops/metrics_token.example ops/metrics_token
# Edit ops/metrics_token and replace its example value with backend/.env's METRICS_TOKEN.
```

The API requires all production settings listed in `backend/index.ts`. Do not put placeholder webhook URLs or weak example passwords into production.

## 2. Start the stack

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

The one-shot `migrate` service runs Prisma migrations, creates/updates a non-superuser `cb_app` database role, applies PostgreSQL RLS policies and pgvector tables, then runs the seed if `SEED_ADMIN_PASSWORD` is present. API and worker wait for that job to finish.

MongoDB starts as a single-node replica set because change streams require replica-set mode. MinIO creates the configured upload bucket before API startup. ClamAV downloads its signature database on first boot; allow extra time before the service becomes healthy.

## 3. Verify

```bash
docker compose ps
docker compose logs --tail=200 migrate api worker frontend
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS http://127.0.0.1:4000/api/ready
curl -fsS http://127.0.0.1:4000/api/openapi.json
```

Run the live smoke checks:

```bash
cd backend
API_BASE_URL=http://127.0.0.1:4000 \
SMOKE_EMAIL=admin@example.test \
SMOKE_PASSWORD='your-seed-password' \
SMOKE_TENANT_SLUG=crystal-ball-demo \
npm run smoke:api
```

The authenticated smoke journey logs in, reads tenant LLM usage, queues a sensor alert and retries acknowledgement until the worker has classified it. It requires a seeded account with `admin`, `operator` or `safety_lead` permissions.

Open Grafana through the host reverse proxy or SSH tunnel to `http://127.0.0.1:3001`. Prometheus is bound to localhost on port 9090. The provisioned dashboard is **Crystal Ball - Operations & LLM Cost**.

## 4. Reverse proxy and TLS

The Compose frontend binds to localhost port 3000; the API binds to localhost port 4000. Put Nginx/Caddy on the host and expose only HTTPS (443) publicly. Do not publish PostgreSQL, MongoDB, Redis, MinIO console, Prometheus or Grafana directly to the internet. Restrict Grafana access to VPN/admin IPs.

Example Nginx site:

```nginx
server {
    listen 80;
    server_name your-domain.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.example;

    ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    client_max_body_size 110m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

Update DNS and certificate paths. Keep `CORS_ORIGIN` aligned with the public HTTPS origin.

## 5. Daily LLM cost governance

Successful non-cached classification calls and completed assistant streams persist usage in MongoDB collection `llm_usage`, including tenant, feature, model, input/output tokens, configured price-derived USD costs and UTC day. `GET /api/v1/usage/llm/daily` returns today's tenant-scoped totals and budget state and requires a bearer token.

When `LLM_DAILY_BUDGET_USD` is greater than zero, each usage write aggregates that tenant's current UTC-day spend. The first crossing sends one HTTPS webhook event per tenant/day; Redis provides the deduplication key. If delivery fails, the key is released so a later usage write can retry. Set `ONCALL_WEBHOOK_URL` and optional `ONCALL_WEBHOOK_TOKEN` to enable delivery.

Pricing is configuration, not fetched dynamically. Update both per-million-token rates whenever the selected model or provider pricing changes. The USD estimate does not include taxes, discounts, cache pricing differences or non-token provider fees. The threshold is per tenant; assistant requests without a verified tenant context are accounted under the `system` tenant.

Prometheus exports aggregate cost counters (feature/model, not tenant) for trend dashboards. MongoDB is the source of truth for tenant-level spend. Budget alerts are webhook notifications; configure paging/escalation at the receiving on-call system.

## 6. Operations and backups

- Back up PostgreSQL, MongoDB, Redis persistence (if required), MinIO objects and the RSA keys.
- Test restores in a separate environment.
- Monitor `docker compose ps`, `/api/ready`, Prometheus targets and Grafana alerts.
- Review ClamAV database freshness and storage capacity.
- Rotate JWT keys, database passwords, MinIO credentials, webhook tokens and metrics tokens using a planned maintenance window.
- Set a controlled image update policy; avoid unreviewed `latest` tags.
- Scale API/worker only after checking queue concurrency, Redis and database connection limits. A single-node Mongo replica set is not a high-availability topology.

## 7. Shutdown and updates

```bash
docker compose down
# Persistent volumes are retained.
docker compose pull
docker compose build
docker compose up -d
```

Do not run `docker compose down -v` unless intentionally deleting all persistent application data.
