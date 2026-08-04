# Local Deployment (Podman)

## Architecture

```
cselearning-web (Next.js)  ──┬──► PostgreSQL (pgvector)
cselearning-worker (Node.js) ┘
```

The application consists of two containers:
- **cselearning-web**: Next.js application with API routes
- **cselearning-worker**: Background worker for transcript/knowledge processing

## Prerequisites

- Podman installed (macOS needs Podman VM): `podman machine start`
- Enter project directory: `cd /Users/zhonghuang/Documents/CSETrainingSystem`

## 1) Prepare AWS S3 (Required)

1. Create an S3 bucket in AWS (e.g., `cse-training-bucket`), confirm Region (e.g., `ap-southeast-1`)
2. Give your IAM user/credentials at least these permissions (bucket + prefix scope):
   - `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`
3. Configure S3 CORS (required for browser presigned PUT uploads):
   - AllowedOrigins: `http://127.0.0.1:3000`, `http://localhost:3000`
   - AllowedMethods: `GET`, `PUT`, `HEAD`
   - AllowedHeaders: at least `content-type`, `x-amz-server-side-encryption` (or use `*`)

## 2) Start Local Postgres (with pgvector)

```bash
podman network create cselearning || true
podman volume create cselearning-pgdata || true

podman rm -f cselearning-postgres || true
podman run -d --name cselearning-postgres --network cselearning \
  -e POSTGRES_DB='cselearning-database' \
  -e POSTGRES_USER='postgres' \
  -e POSTGRES_PASSWORD='postgres' \
  -v cselearning-pgdata:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg16
```

## 3) Prepare Local Environment File

Create `tmp/podman/local.env` (not committed to git):

```bash
mkdir -p tmp/podman
cat > tmp/podman/local.env <<'EOF'
NODE_ENV=production
JWT_SECRET=local-dev-secret-change-me

DATABASE_URL=postgresql://postgres:postgres@cselearning-postgres:5432/cselearning-database?schema=public

AWS_REGION=ap-southeast-1
AWS_S3_BUCKET_NAME=<YOUR_BUCKET>
AWS_S3_ASSET_PREFIX=assets
CSE_ASSET_DELIVERY_MODE=s3_presigned
CSE_ASSET_URL_TTL_SECONDS=43200

AWS_ACCESS_KEY_ID=<YOUR_KEY>
AWS_SECRET_ACCESS_KEY=<YOUR_SECRET>

OPENAI_API_KEY=<YOUR_OPENAI_KEY>
OPENAI_MODEL=gpt-4o-mini
LLM_DEFAULT_PROVIDER=openai
VEXKE_API_KEY=<YOUR_VEXKE_KEY>
VEXKE_BASE_URL=https://v2.vexke.com/openai/v1
VEXKE_CHAT_COMPLETIONS_PATH=/chat/completions
VEXKE_MODEL_IDS=gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-5.5,gpt-5.5-mini,gpt-5.4,gpt-5.4-mini

NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
EOF
```

Notes:
- Local dev recommends `CSE_ASSET_DELIVERY_MODE=s3_presigned` (no CloudFront key needed)
- `AWS_S3_ASSET_PREFIX` should be `assets` to match production `/assets/*` structure

### Optional: CloudFront Signed Cookies

If you want to test CloudFront signed cookies for course materials:

```bash
# Add to tmp/podman/local.env
CLOUDFRONT_DOMAIN=<your-cloudfront-domain>
CLOUDFRONT_KEY_PAIR_ID=<your-key-pair-id>
CLOUDFRONT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
CLOUDFRONT_SIGNED_COOKIE_TTL_HOURS=12
# COOKIE_DOMAIN= (optional)
```

## 4) Build Images

```bash
podman build -t cselearning-web:latest -f Containerfile .
podman build --target migrator -t cselearning-migrator:latest -f Containerfile .
podman build --target worker -t cselearning-worker:latest -f Containerfile .
```

## 5) Run Migrations + Seed

Migration:
```bash
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  cselearning-migrator:latest
```

Seed (choose one):

- Create a specific admin (recommended):
```bash
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  -e CSE_SEED_ADMIN_EMAIL='admin@agora.io' \
  -e CSE_SEED_ADMIN_PASSWORD='password123' \
  cselearning-migrator:latest npx prisma db seed
```

- Create default test users (local dev only):
```bash
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  -e CSE_SEED_DEFAULT_USERS=1 \
  cselearning-migrator:latest npx prisma db seed
```

## 6) Start Web Container

```bash
podman rm -f cselearning-web || true
podman run -d --name cselearning-web --network cselearning -p 3000:3000 \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  localhost/cselearning-web:latest
```

Access: http://127.0.0.1:3000/login

### 6.1) Hot Reload Dev Mode (`cselearning-web-dev`)

Use this when iterating on frontend/backend code without rebuilding `cselearning-web:latest` every time.

1) Install deps into a persistent volume (run once, or after `package-lock.json` changes):

```bash
podman volume create cselearning-web-node_modules || true

podman run --rm --network cselearning \
  --env-file tmp/podman/local.env \
  -v "$PWD:/app" \
  -v cselearning-web-node_modules:/app/node_modules \
  -w /app \
  cselearning-migrator:latest \
  npm ci --no-audit --no-fund
```

2) Start dev server with hot reload:

```bash
podman rm -f cselearning-web-dev || true
podman run -d --name cselearning-web-dev --network cselearning -p 3000:3000 \
  --env-file tmp/podman/local.env \
  -v "$PWD:/app" \
  -v cselearning-web-node_modules:/app/node_modules \
  -w /app \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_WECOM_LOG_CONTENT=1 \
  cselearning-migrator:latest \
  npm run dev
```

3) Useful commands:

```bash
# watch logs
podman logs -f cselearning-web-dev

# stop / remove
podman rm -f cselearning-web-dev

# verify container env flags
podman exec cselearning-web-dev sh -lc 'echo "$CSE_LOG"; echo "$CSE_WECOM_LOG_CONTENT"'
```

If you hit `proxy already running` on macOS Podman:

```bash
podman machine stop
podman machine start
# then retry podman run
```

## 7) Start Worker Container (Optional)

Required for VTT-to-knowledge-context processing:

```bash
podman rm -f cselearning-worker 2>/dev/null || true
podman run -d --name cselearning-worker --network cselearning \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_OPENAI_LOG_CONTENT=1 \
  localhost/cselearning-worker:latest
```

## 8) Database Operations

Delete local test data (requires `local.cleanup.env` with AWS credentials):
```bash
ENV_FILE=tmp/podman/local.cleanup.env npm run cleanup:test-data:apply
```

Database migration (if schema changed):
```bash
podman exec -it <web-container-name> sh -lc 'cd /app && npx prisma migrate deploy'
```

Enter PSQL:
```bash
podman exec -it cselearning-postgres psql -U postgres -d cselearning-database
```

Common PSQL commands:
| Command | Purpose |
|---------|---------|
| `\l` | List all databases |
| `\c <dbname>` | Switch database |
| `\dt` | List tables |
| `\d <table>` | Describe table |
| `\x` | Toggle expanded display |
| `\q` | Quit |

## Quick Reference

### Build all images:
```bash
podman build -t cselearning-web:latest -f Containerfile .
podman build --target migrator -t cselearning-migrator:latest -f Containerfile .
podman build --target worker -t cselearning-worker:latest -f Containerfile .
```

### Stop all containers:
```bash
podman rm -f cselearning-worker
podman rm -f cselearning-postgres || true
podman rm -f cselearning-web || true
```

### Start fresh environment:
```bash
# Start postgres
podman run -d --name cselearning-postgres --network cselearning \
  -e POSTGRES_DB='cselearning-database' \
  -e POSTGRES_USER='postgres' \
  -e POSTGRES_PASSWORD='postgres' \
  -v cselearning-pgdata:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg16

# Run migration
podman run --rm --network cselearning --env-file tmp/podman/local.env cselearning-migrator:latest

# Start web
podman run -d --name cselearning-web --network cselearning -p 3000:3000 \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_WECOM_LOG_CONTENT=1 \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  localhost/cselearning-web:latest

# Start worker (optional)
podman run -d --name cselearning-worker --network cselearning \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  localhost/cselearning-worker:latest
```

### View logs:
```bash
podman logs -f cselearning-web
podman logs -f cselearning-worker
```

## Appendix: Apple Silicon Local Build Workflow

If you are developing on a MacBook Pro M2/M-series machine, use the platform-aware build script instead of raw `podman build` commands. This keeps local builds on `linux/arm64` and avoids mixing them up with Ubuntu production `linux/amd64` images.

### Recommended local image tags

- Web: `localhost/cselearning-web:dev-arm64`
- Worker: `localhost/cselearning-worker:dev-arm64`
- Migrator: `localhost/cselearning-migrator:dev-arm64`

`localhost/cselearning-*:latest` can still be used locally as a convenience alias when you build with `--latest-alias`.

### Build local images on Apple Silicon

Build all three local images:

```bash
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --latest-alias
```

Build only one image when iterating:

```bash
# web only
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --web-only --latest-alias

# worker only
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --worker-only --latest-alias

# migrator only
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --migrator-only --latest-alias
```

If you prefer to use the explicit architecture tags instead of `:latest`, the matching images are:

```bash
localhost/cselearning-web:dev-arm64
localhost/cselearning-worker:dev-arm64
localhost/cselearning-migrator:dev-arm64
```

### Recommended local run sequence

```bash
# 1) Start postgres
podman machine start
podman network create cselearning || true
podman volume create cselearning-pgdata || true

podman rm -f cselearning-postgres || true
podman run -d --name cselearning-postgres --network cselearning \
  -e POSTGRES_DB='cselearning-database' \
  -e POSTGRES_USER='postgres' \
  -e POSTGRES_PASSWORD='postgres' \
  -v cselearning-pgdata:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg16

# 2) Build local arm64 images
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --latest-alias

# 3) Run migrations
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  localhost/cselearning-migrator:latest

# 4) Start web
podman rm -f cselearning-web || true
podman run -d --name cselearning-web --network cselearning -p 3000:3000 \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_WECOM_LOG_CONTENT=1 \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  localhost/cselearning-web:latest

# 5) Start worker
podman rm -f cselearning-worker || true
podman run -d --name cselearning-worker --network cselearning \
  --env-file tmp/podman/local.env \
  -v "$HOME/.aws:/root/.aws:ro" \
  -e AWS_PROFILE=default \
  -e AWS_SDK_LOAD_CONFIG=1 \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_OPENAI_LOG_CONTENT=1 \
  localhost/cselearning-worker:latest
```

### Important note about production builds

Your local Apple Silicon machine should build `linux/arm64` for local testing only. Ubuntu production is `x86_64`, which means production images must be built as `linux/amd64`, ideally on Ubuntu or CI rather than through local cross-architecture emulation on the M2.

## Appendix: Faster Local Web Iteration

If you are only changing frontend or API code locally, you do **not** need to rebuild the `web` image every time. The fastest workflow is to run the Next.js dev server inside a Podman container with your source mounted into `/app`.

### Option A: Hot reload web development container

Use this when iterating on UI or web logic and you want changes to apply without rebuilding `localhost/cselearning-web:latest`.

1) Create a persistent volume for `node_modules` and install dependencies once:

```bash
podman volume create cselearning-web-node_modules || true

podman run --rm --network cselearning \
  --env-file tmp/podman/local.env \
  -v "$PWD:/app" \
  -v cselearning-web-node_modules:/app/node_modules \
  -w /app \
  localhost/cselearning-web:latest \
  npm ci --no-audit --no-fund
```

2) Start the hot reload dev server:

```bash
podman rm -f cselearning-web-dev || true
podman run -d --name cselearning-web-dev --network cselearning -p 3001:3000 \
  --env-file tmp/podman/local.env \
  -v "$PWD:/app" \
  -v cselearning-web-node_modules:/app/node_modules \
  -w /app \
  -e CSE_LOG=api,db,s3,knowledgecontext,openai,worker,transcriptprocessing \
  -e CSE_WECOM_LOG_CONTENT=1 \
  localhost/cselearning-web:latest \
  npm run dev
```

3) Useful commands:

```bash
# watch logs
podman logs -f cselearning-web-dev

# stop the dev container
podman rm -f cselearning-web-dev
```

Notes:
- Re-run the `npm ci` step only when `package-lock.json` changes.
- This is usually much faster than rebuilding the web image for every local change.

### Option B: Build only the web image when you really need an image

If you specifically need to verify production-like container behavior, build only the web target instead of rebuilding all images:

```bash
./scripts/podman/build-images.sh --profile dev --platform linux/arm64 --web-only --latest-alias
```

This is still slower than Option A, but faster than rebuilding `web`, `worker`, and `migrator` together.
