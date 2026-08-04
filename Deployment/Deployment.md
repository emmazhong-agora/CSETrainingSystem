# Deployment Guide (Local + AWS EC2)

This project is a **Next.js app (App Router)** with server-side API routes and a PostgreSQL database (Prisma).
It is deployed as **two containers**:
- **cselearning-web**: Next.js standalone output with all API endpoints
- **cselearning-worker**: Background worker for transcript/knowledge processing

Uses **AWS S3** for assets (MP4, VTT, XML knowledge contexts).

## Contents

- Local deployment (Podman)
- AWS EC2 deployment (Podman + systemd)
- Database migrations (Prisma)
- CloudFront + S3 private assets (optional but recommended)
- Troubleshooting

---

## 1) Local Deployment (Podman, recommended for “prod-like” testing)

### Prerequisites

- Podman installed (macOS needs Podman VM): `podman machine start`
- AWS credentials in env if you want real S3 assets (optional)

### 1.1 Start Postgres (with pgvector)

Prisma migrations require the `vector` extension. Use the pgvector image:

```bash
podman machine start

podman network create cselearning || true
podman rm -f cselearning-postgres || true
podman run -d --name cselearning-postgres --network cselearning \
  -e POSTGRES_DB='cselearning-database' \
  -e POSTGRES_USER='postgres' \
  -e POSTGRES_PASSWORD='postgres' \
  docker.io/pgvector/pgvector:pg16
```

### 1.2 Build images

```bash
podman build -t cselearning-web:latest -f Containerfile .
podman build --target migrator -t cselearning-migrator:latest -f Containerfile .
podman build --target worker -t cselearning-worker:latest -f Containerfile .
```

### 1.3 Create a local env file (do NOT commit secrets)

Create a single env file `tmp/podman/local.env` (already ignored by `.gitignore`).
This file is shared by all containers (web, worker, migrator).

```bash
mkdir -p tmp/podman
cat > tmp/podman/local.env <<'EOF'
NODE_ENV=production
JWT_SECRET=local-dev-secret-change-me

DATABASE_URL=postgresql://postgres:postgres@cselearning-postgres:5432/cselearning-database?schema=public

# AWS S3 access for assets/XML
AWS_REGION=ap-southeast-1
AWS_S3_BUCKET_NAME=cse-training-bucket
AWS_S3_ASSET_PREFIX=assets
CSE_ASSET_DELIVERY_MODE=s3_presigned
CSE_ASSET_URL_TTL_SECONDS=43200
AWS_ACCESS_KEY_ID=REPLACE_ME
AWS_SECRET_ACCESS_KEY=REPLACE_ME

# Optional: AI (only needed if you will use AI endpoints)
OPENAI_API_KEY=REPLACE_ME
OPENAI_MODEL=gpt-4o-mini
LLM_DEFAULT_PROVIDER=openai
VEXKE_API_KEY=REPLACE_ME
VEXKE_BASE_URL=https://v2.vexke.com/openai/v1
VEXKE_CHAT_COMPLETIONS_PATH=/chat/completions
VEXKE_MODEL_IDS=gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-5.5,gpt-5.5-mini,gpt-5.4,gpt-5.4-mini

# Optional: CloudFront signed cookies for private course materials
# CLOUDFRONT_DOMAIN=your-cloudfront-domain
# CLOUDFRONT_KEY_PAIR_ID=your-key-pair-id
# CLOUDFRONT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# CLOUDFRONT_SIGNED_COOKIE_TTL_HOURS=12
EOF
```

### 1.4 Run migrations + seed

```bash
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  cselearning-migrator:latest

# Local dev/test (DATABASE_URL points to localhost/127.*):
# seeds default users (admin@agora.io / user@agora.io).
podman run --rm --network cselearning --env-file tmp/podman/local.env \
  cselearning-migrator:latest npx prisma db seed
```

Production/remote DB (RDS): default users are blocked. You must explicitly seed an admin:

```bash
CSE_SEED_ADMIN_EMAIL=AdminEmail CSE_SEED_ADMIN_PASSWORD='xxxx!' \
  podman run --rm --env-file /home/ubuntu/cselearning.env \
  -e CSE_SEED_ADMIN_EMAIL -e CSE_SEED_ADMIN_PASSWORD \
  cselearning-migrator:latest npx prisma db seed
```

### 1.5 Run the web container

```bash
podman rm -f cselearning-web || true
podman run -d --name cselearning-web --network cselearning \
  -p 3000:3000 \
  --env-file tmp/podman/local.env \
  cselearning-web:latest
```

Open:

- `http://127.0.0.1:3000/login`
  - Local dev default users (only if you used the local seed above):
    - User: `user@agora.io` / `password123`
    - Admin: `admin@agora.io` / `password123`

### 1.6 Optional: run the Worker locally

Required for transcript/knowledge-context background processing:

```bash
podman rm -f cselearning-worker || true
podman run -d --name cselearning-worker --network cselearning \
  --env-file tmp/podman/local.env \
  cselearning-worker:latest
```

### 1.7 Optional E2E checks

- UI smoke (browser):
  ```bash
  E2E_BASE_URL=http://127.0.0.1:3000 npx tsx scripts/e2e/learn-ui-smoke.ts
  ```
- Real S3 chain (DB + S3 CopyObject + Range GET):
  ```bash
  E2E_BASE_URL=http://127.0.0.1:3000 \
  DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/cselearning-database?schema=public' \
  npx tsx scripts/e2e/real-s3-asset-delivery.ts
  ```

---

## 2) AWS EC2 Deployment (Podman + systemd, CloudFront → EC2)

This is the low-ops option you chose:

- EC2 (public) with EIP
- Podman runs the `cselearning-web` container
- RDS PostgreSQL in the same VPC (recommended)
- CloudFront in front of EC2 (recommended)

### 2.1 AWS resources checklist (ap-southeast-1)

- EC2 instance (Amazon Linux 2023 or Ubuntu)
- Elastic IP associated to EC2
- RDS PostgreSQL (Single-AZ to save cost)
  - DB name: `cselearning-database`
  - Username: `postgres`
- Security Groups:
  - EC2 SG: allow `80/443` from internet (or corporate IP), allow `22` from your IP only
  - RDS SG: allow `5432` from EC2 SG only
- S3 bucket: `cse-training-bucket` (private)

### 2.2 Install Podman + git (example)

On the EC2 host:

```bash
sudo yum update -y
sudo yum install -y podman git
podman --version
```

### 2.3 Pull your repo

```bash
git clone <YOUR_GITHUB_REPO_URL> cselearning
cd cselearning
```

### 2.4 Create production env file on EC2

Create `/opt/cselearning.env` (permissions: root-only):

```bash
sudo tee /opt/cselearning.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0

# RDS (example; adjust host/db)
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@<RDS_ENDPOINT>:5432/cselearning-database?schema=public&sslmode=require

JWT_SECRET=<GENERATE_A_STRONG_RANDOM_SECRET>

# AWS S3
AWS_REGION=ap-southeast-1
AWS_S3_BUCKET_NAME=cse-training-bucket
AWS_S3_ASSET_PREFIX=assets

# Asset delivery mode:
# - For production with private assets: cloudfront_signed
# - If you temporarily allow public S3/CF access: public (not recommended)
CSE_ASSET_DELIVERY_MODE=cloudfront_signed
CSE_ASSET_URL_TTL_SECONDS=43200

# CloudFront signed URL & cookies (required when cloudfront_signed)
CLOUDFRONT_DOMAIN=cselearning.club
CLOUDFRONT_KEY_PAIR_ID=<YOUR_KEY_PAIR_ID>
CLOUDFRONT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
CLOUDFRONT_SIGNED_COOKIE_TTL_HOURS=12

# AI
OPENAI_API_KEY=<YOUR_OPENAI_KEY>
OPENAI_MODEL=gpt-4o-mini
LLM_DEFAULT_PROVIDER=openai
VEXKE_API_KEY=<YOUR_VEXKE_KEY>
VEXKE_BASE_URL=https://v2.vexke.com/openai/v1
VEXKE_CHAT_COMPLETIONS_PATH=/chat/completions
VEXKE_MODEL_IDS=gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-5.5,gpt-5.5-mini,gpt-5.4,gpt-5.4-mini
EOF

sudo chmod 600 /opt/cselearning.env
```

Important:

- Do not store AWS access keys on EC2 if you can avoid it. Prefer an **IAM Instance Role** with S3 permissions.
- If you do use keys temporarily, put them in `/opt/cselearning.env` and lock file permissions.

### 2.5 Build images on EC2

```bash
podman build -t cselearning-web:latest -f Containerfile .
podman build --target migrator -t cselearning-migrator:latest -f Containerfile .
podman build --target worker -t cselearning-worker:latest -f Containerfile .
```

### 2.6 Run Prisma migrations (one-off)

```bash
podman run --rm --env-file /home/ubuntu/cselearning.env cselearning-migrator:latest
```

### 2.7 Run the web container

Run on port 3000 (later you can put Nginx in front on 80/443):

```bash
podman rm -f cselearning-web || true
podman run -d --name cselearning-web \
  --env-file /home/ubuntu/cselearning.env \
  -p 3000:3000 \
  cselearning-web:latest
podman logs --tail 100 cselearning-web
```

### 2.8 systemd autostart (recommended)

Important: use **rootless Podman** + **user systemd** (`systemctl --user`).  
Do **NOT** use `sudo systemctl ...` unless you intentionally run **rootful** Podman, because root/system services cannot see rootless pods/images/containers and will fail with exit code `125` (e.g. “pod not found”, “image not found”, port conflicts).

```bash
podman generate systemd --name cselearning-web --files --new
mkdir -p ~/.config/systemd/user
mv container-cselearning-web.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now container-cselearning-web.service
systemctl --user status container-cselearning-web.service

# Ensure the user service starts on boot even without an active SSH session
sudo loginctl enable-linger ubuntu
```

### 2.9 Deploy the Worker on EC2

The worker handles background processing for transcripts and knowledge contexts.

```bash
podman rm -f cselearning-worker || true
podman run -d --name cselearning-worker \
    --env-file /home/ubuntu/cselearning.env \
    cselearning-worker:latest

podman logs --tail 100 cselearning-worker
```

systemd autostart:

```bash
podman generate systemd --name cselearning-worker --files --new
mkdir -p ~/.config/systemd/user
mv container-cselearning-worker.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now container-cselearning-worker.service
systemctl --user status container-cselearning-worker.service
```

---

## 3) CloudFront + S3 private assets (recommended)

If you want private access to S3 assets (MP4/VTT/XML) while keeping the app public:

### 3.1 CloudFront behaviors (example)

Two-origins setup:

- Origin A: EC2 (or Nginx on EC2) for the app
  - Default behavior: `/*` → EC2 origin
- Origin B: S3 bucket for assets
  - Behavior: `/CSETraining/*` → S3 origin (OAC enabled)
  - Require Signed URL (Key Group)

### 3.2 App configuration

Use:

- `AWS_S3_ASSET_PREFIX=CSETraining`
- `CSE_ASSET_DELIVERY_MODE=cloudfront_signed`
- `AWS_CLOUDFRONT_DOMAIN=cselearning.club` (or your CF domain)
- `CLOUDFRONT_KEY_PAIR_ID` + `CLOUDFRONT_PRIVATE_KEY`

The API returns time-limited signed URLs so the browser can fetch MP4/VTT/XML.

---

## 4) Troubleshooting

### Local/EC2: `Invalid supabaseUrl` or "Missing Supabase environment variables"

Use local auth (no Supabase env vars), or ensure Supabase env vars are valid URLs without extra quotes.
For containers, prefer a dedicated env-file (no surrounding quotes).

### Course materials page cannot obtain CloudFront cookie

Symptoms:

- `/courses/:id/materials` videos don't play
- Browser console shows the `cf-cookie` request failing

Checks:

- Ensure CloudFront environment variables are set: `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY`
- Check that the user is enrolled in the course

### Admin MP4/VTT upload fails with S3 CORS error

Symptoms:

- Admin “upload asset” fails in the browser
- Console shows `blocked by CORS policy` to `https://<bucket>.s3.<region>.amazonaws.com/...` (preflight has no `Access-Control-Allow-Origin`)

Cause:

- The browser uploads directly to S3 using a presigned `PUT` URL, which requires an S3 bucket **CORS** rule allowing your app origin.

Fix (recommended: restrict to your origin(s)):

1) Create a local file `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://cselearning.club", "http://127.0.0.1:3000", "http://localhost:3000", "http://<EC2_EIP>:3000"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

2) Apply it:

```bash
aws s3api put-bucket-cors --region ap-southeast-1 --bucket <YOUR_BUCKET> --cors-configuration file://cors.json
aws s3api get-bucket-cors --region ap-southeast-1 --bucket <YOUR_BUCKET>
```

Notes:

- This does **not** make objects public; it only allows the browser to use valid presigned URLs.
- Once you switch fully to the domain, you can remove the `http://<EC2_EIP>:3000` origin.
- Ensure environment has: `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY`


更新 cselearning.env 这种"运行时配置"不要求重新 podman build，但需要让容器"重新读取 env-file"（env 只在 创建容器 时读取一次），所以你要 重建/重跑容器 或 重启 systemd 单元。

  如果你是按 systemd 跑的（推荐）：

  - systemctl --user restart container-cselearning-web.service
  - systemctl --user restart container-cselearning-worker.service
  - 看日志：journalctl --user -u container-cselearning-web.service -n 200 --no-pager
  - 看日志：journalctl --user -u container-cselearning-worker.service -n 200 --no-pager

  如果你是手动 podman run 跑的：

  - 先停掉并删除旧容器（不会删镜像）：podman rm -f cselearning-web cselearning-worker
  - 重新启动：
      - podman run -d --name cselearning-web --network cselearning -p 3000:3000 --env-file /home/ubuntu/cselearning.env cselearning-web:latest
      - podman run -d --name cselearning-worker --network cselearning --env-file /home/ubuntu/cselearning.env cselearning-worker:latest
  - 验证：podman ps、podman logs --tail 200 cselearning-web、podman logs --tail 200 cselearning-worker

  只有当你改了代码/依赖/Containerfile 时，才需要重新 podman build。

  常见流程：

  - 第一次：podman pod create ...（只做一次）
  - 每次启动/更新：podman run --pod cselearning ... 启动/重建容器
  - 如果 pod 已存在，再执行 podman pod create 会报已存在，你就跳过即可。




  1. 确认前端真的在对外提供服务

  - curl -I http://127.0.0.1:3000/
  - curl -sS http://127.0.0.1:3000/api/courses | head

  2. 如果还没 seed 过用户（通常会导致登录失败），跑一次 seed（用 migrator 镜像即可）

  - 生产环境（RDS）不会创建默认账号，必须显式创建管理员：

    CSE_SEED_ADMIN_EMAIL=AdminEmail CSE_SEED_ADMIN_PASSWORD='xxxx!' \
      podman run --rm --env-file /home/ubuntu/cselearning.env \
      -e CSE_SEED_ADMIN_EMAIL -e CSE_SEED_ADMIN_PASSWORD \
      cselearning-migrator:latest npx prisma db seed

  - 本地开发（DATABASE_URL 指向 localhost/127.*）才会创建默认账号：
      - admin@agora.io / password123
      - user@agora.io / password123

  3. 确保 EC2 Security Group 放行 3000 给你当前公网 IP（或临时 0.0.0.0/0 做验证）
  4. 在你本机浏览器打开

  - http://<EC2的EIP或公网IP>:3000/login
  - 用上面的账号密码登录

• 本地开发环境的默认账号来自 `prisma db seed`（会创建 `admin@agora.io / password123`）。生产环境（RDS）默认不会创建这些账号；如果你的数据库里历史上已经存在默认账号，建议禁用它们。

  在 EC2 上执行（用 migrator 镜像即可，避免你本机装依赖）：

  1. 创建/覆盖你的管理员账号（自己换成强密码；注意会进 shell history，做完可以清 history）

  ADMIN_EMAIL='你自己的邮箱'
  ADMIN_PASSWORD='强密码'

  podman run --rm --env-file /home/ubuntu/cselearning.env \
    -e ADMIN_EMAIL -e ADMIN_PASSWORD \
    cselearning-migrator:latest node - <<'NODE'
  const { PrismaClient } = require('@prisma/client')
  const bcrypt = require('bcryptjs')

  const prisma = new PrismaClient()
  ;(async () => {
    const email = process.env.ADMIN_EMAIL
    const password = process.env.ADMIN_PASSWORD
    if (!email || !password) throw new Error('Missing ADMIN_EMAIL / ADMIN_PASSWORD')

    const hash = await bcrypt.hash(password, 10)
    const user = await prisma.user.upsert({
      where: { email },
      update: { password: hash, role: 'ADMIN', status: 'ACTIVE' },
      create: { email, name: 'Admin', password: hash, role: 'ADMIN', status: 'ACTIVE' },
    })
    console.log('Admin ready:', user.email)
    await prisma.$disconnect()
  })().catch(e => { console.error(e); process.exit(1) })
  NODE

  2. 禁用默认账号（避免被撞库；登录逻辑会拒绝 status !== ACTIVE）

  podman run --rm --env-file /home/ubuntu/cselearning.env \
    cselearning-migrator:latest node - <<'NODE'
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  ;(async () => {
    const res = await prisma.user.updateMany({
      where: { email: { in: ['admin@agora.io', 'user@agora.io'] } },
      data: { status: 'SUSPENDED' },
    })
    console.log('Disabled default users:', res.count)
    await prisma.$disconnect()
  })().catch(e => { console.error(e); process.exit(1) })
  NODE

  3. 重启 web（确保后续登录用新账号）

  - podman restart cselearning-web





快速启动：
podman start cselearning-web
podman start cselearning-worker
CSE_SEED_ADMIN_EMAIL=AdminEmail CSE_SEED_ADMIN_PASSWORD='xxxx!' podman run --rm --env-file /home/ubuntu/cselearning.env -e CSE_SEED_ADMIN_EMAIL -e CSE_SEED_ADMIN_PASSWORD cselearning-migrator:latest npx prisma db seed


查看启动状态：
systemctl --user list-unit-files | grep cselearning

日志：
• 用 rootless 的 user service，就用 user journal 看日志：

  - 看最近 200 行（推荐先用这个）
    journalctl --user -u container-cselearning-web.service -n 200 --no-pager
  - 实时跟踪
    journalctl --user -u container-cselearning-web.service -f
  - 如果你想看“上一次启动”的完整日志（含旧日志）
    journalctl --user -u container-cselearning-web.service --since "2 hours ago" --no-pager

  另外也可以直接看容器日志（不经过 systemd）：

  - podman logs --tail 200 cselearning-web
  - podman logs -f cselearning-web




本地测试环境快速部署：
• 在项目根目录用 Podman 跑一套“本地类生产”最快流程（按 Deployment.md）：

  # macOS 先开 Podman VM（Linux 跳过）
  podman machine start

  # 1) 启动 Postgres（带 pgvector）
  podman network create cselearning || true
  podman rm -f cselearning-postgres || true
  podman run -d --name cselearning-postgres --network cselearning \
    -e POSTGRES_DB='cselearning-database' \
    -e POSTGRES_USER='postgres' \
    -e POSTGRES_PASSWORD='postgres' \
    docker.io/pgvector/pgvector:pg16

  # 2) 准备本地环境变量（不要提交）
  mkdir -p tmp/podman
  cat > tmp/podman/local.env <<'EOF'
  NODE_ENV=production
  JWT_SECRET=local-dev-secret-change-me
  DATABASE_URL=postgresql://postgres:postgres@cselearning-postgres:5432/cselearning-database?schema=public
  AWS_REGION=ap-southeast-1
  AWS_S3_BUCKET_NAME=cse-training-bucket
  AWS_S3_ASSET_PREFIX=CSETraining
  CSE_ASSET_DELIVERY_MODE=s3_presigned
  CSE_ASSET_URL_TTL_SECONDS=43200
  EOF

  # 3) build + 迁移 + seed + 启动 web
  podman build -t cselearning-web:latest -f Containerfile .
  podman build --target migrator -t cselearning-migrator:latest -f Containerfile .
  podman build --target worker -t cselearning-worker:latest -f Containerfile .
  podman run --rm --network cselearning --env-file tmp/podman/local.env cselearning-migrator:latest
  podman run --rm --network cselearning --env-file tmp/podman/local.env cselearning-migrator:latest npx tsx prisma/seed.ts
  podman rm -f cselearning-web || true
  podman run -d --name cselearning-web --network cselearning -p 3000:3000 \
    --env-file tmp/podman/local.env cselearning-web:latest

  # 可选：启动 worker（用于 transcript/knowledge processing）
  podman rm -f cselearning-worker || true
  podman run -d --name cselearning-worker --network cselearning \
    --env-file tmp/podman/local.env cselearning-worker:latest




====================================================================
• 按"EC2 + Podman 容器在实例里跑 web/worker"的场景，Instance Role（Instance Profile）配置步骤如下：

  1. 创建 IAM Policy（最小权限）

  - 进 AWS Console → IAM → Policies → Create policy（JSON）
  - 把 bucket/prefix 替换成你的实际值（示例只允许操作 CSETraining/*）：

  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "ListBucketUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::cse-training-bucket",
        "Condition": { "StringLike": { "s3:prefix": ["CSETraining/*"] } }
      },
      {
        "Sid": "ObjectRWUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::cse-training-bucket/CSETraining/*"
      }
    ]
  }

  2. 创建 IAM Role（给 EC2 用）

  - IAM → Roles → Create role → AWS service → EC2
  - Attach 上一步的 policy
  - Role 名字比如：cselearning-ec2-role

  3. 把 Role 绑定到 EC2 实例

  - EC2 Console → Instances → 选中你的实例
  - Actions → Security → Modify IAM role
  - 选择 cselearning-ec2-role → Save

  4. 在 EC2 上验证实例已拿到临时凭证
     在 EC2 SSH 里执行（需要装 awscli；没装也可以跳过，用应用日志验证）：

  aws sts get-caller-identity

  5. 应用侧不用再配 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY

  - 保留/设置这些即可：AWS_REGION、AWS_S3_BUCKET_NAME、AWS_S3_ASSET_PREFIX（以及你的 CSE_ASSET_DELIVERY_MODE）
  - 重启容器后，S3 相关报错应消失

  如果你重启后仍然提示 Could not load credentials from any providers，把你是用 rootless podman 还是 sudo podman、以及容器启动命令（含网络参数）贴一下，我帮你确认容器是否能访问 IMDS（实例元数据
  169.254.169.254）。
• 下面是一套可直接用 AWS CLI 创建 S3 最小权限 policy + EC2 role + 绑定到指定 EC2 实例 的命令（把变量改成你的实际值）。

  # 0) 先填变量
  export AWS_REGION=ap-southeast-1
  export BUCKET_NAME='cse-training-bucket'
  export PREFIX='CSETraining'          # 不要带开头的 /
  export POLICY_NAME='cselearning-s3-policy'
  export ROLE_NAME='cselearning-ec2-role'
  export INSTANCE_PROFILE_NAME='cselearning-ec2-profile'
  export INSTANCE_ID='i-xxxxxxxxxxxxxxxxx'

  1. 创建 IAM Policy（限制到 bucket + prefix）

  cat > /tmp/cselearning-s3-policy.json <<EOF
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "ListBucketUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::${BUCKET_NAME}",
        "Condition": { "StringLike": { "s3:prefix": ["${PREFIX}", "${PREFIX}/*"] } }
      },
      {
        "Sid": "ObjectRWUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::${BUCKET_NAME}/${PREFIX}/*"
      }
    ]
  }
  EOF

  POLICY_ARN="$(aws iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document file:///tmp/cselearning-s3-policy.json \
    --query 'Policy.Arn' --output text)"
  echo "POLICY_ARN=${POLICY_ARN}"

  2. 创建 EC2 Role（信任策略）并挂载上面的 policy

  cat > /tmp/ec2-trust.json <<'EOF'
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }
    ]
  }
  EOF

  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document file:///tmp/ec2-trust.json

  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn "${POLICY_ARN}"

  3. 创建 Instance Profile，把 role 放进去，并绑定到 EC2

  aws iam create-instance-profile \
    --instance-profile-name "${INSTANCE_PROFILE_NAME}"

  aws iam add-role-to-instance-profile \
    --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
    --role-name "${ROLE_NAME}"

  # 绑定到实例（如果实例还没绑过 role）
  aws ec2 associate-iam-instance-profile \
    --region "${AWS_REGION}" \
    --instance-id "${INSTANCE_ID}" \
    --iam-instance-profile Name="${INSTANCE_PROFILE_NAME}"

  如果你的实例已经绑定过 IAM role，需要 replace（先查 association-id，再替换）：

  ASSOC_ID="$(aws ec2 describe-iam-instance-profile-associations \
    --region "${AWS_REGION}" \
    --filters Name=instance-id,Values="${INSTANCE_ID}" \
    --query 'IamInstanceProfileAssociations[0].AssociationId' --output text)"

  aws ec2 replace-iam-instance-profile-association \
    --region "${AWS_REGION}" \
    --association-id "${ASSOC_ID}" \
    --iam-instance-profile Name="${INSTANCE_PROFILE_NAME}"

  你把 BUCKET_NAME / PREFIX / INSTANCE_ID 发我，我也可以帮你把这套命令替换成“可直接复制粘贴”的最终版。


› BUCKET_NAME=cse-training-bucket
  PREFIX=CSETraining
  INSTANCE_ID=i-0047c4804281f16bc


• export AWS_REGION=ap-southeast-1
  export BUCKET_NAME='cse-training-bucket'
  export PREFIX='CSETraining'
  export POLICY_NAME='cselearning-s3-policy'
  export ROLE_NAME='cselearning-ec2-role'
  export INSTANCE_PROFILE_NAME='cselearning-ec2-profile'
  export INSTANCE_ID='i-0047c4804281f16bc'

  cat > /tmp/cselearning-s3-policy.json <<EOF
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "ListBucketUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::${BUCKET_NAME}",
        "Condition": { "StringLike": { "s3:prefix": ["${PREFIX}", "${PREFIX}/*"] } }
      },
      {
        "Sid": "ObjectRWUnderPrefix",
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::${BUCKET_NAME}/${PREFIX}/*"
      }
    ]
  }
  EOF

  POLICY_ARN="$(aws iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document file:///tmp/cselearning-s3-policy.json \
    --query 'Policy.Arn' --output text)"
  echo "POLICY_ARN=${POLICY_ARN}"

  cat > /tmp/ec2-trust.json <<'EOF'
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }
    ]
  }
  EOF

  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document file:///tmp/ec2-trust.json

  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn "${POLICY_ARN}"

  aws iam create-instance-profile \
    --instance-profile-name "${INSTANCE_PROFILE_NAME}"

  aws iam add-role-to-instance-profile \
    --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
    --role-name "${ROLE_NAME}"

  aws ec2 associate-iam-instance-profile \
    --region "${AWS_REGION}" \
    --instance-id "${INSTANCE_ID}" \
    --iam-instance-profile Name="${INSTANCE_PROFILE_NAME}"

  如果提示实例已有关联，改用 replace：

  ASSOC_ID="$(aws ec2 describe-iam-instance-profile-associations \
    --region "${AWS_REGION}" \
    --filters Name=instance-id,Values="${INSTANCE_ID}" \
    --query 'IamInstanceProfileAssociations[0].AssociationId' --output text)"

  aws ec2 replace-iam-instance-profile-association \
    --region "${AWS_REGION}" \
    --association-id "${ASSOC_ID}" \
    --iam-instance-profile Name="${INSTANCE_PROFILE_NAME}"

  验证：

  aws sts get-caller-identity
