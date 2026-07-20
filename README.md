# StickerSnap

> Turn any photo into a clean PNG sticker — right from your phone.

StickerSnap is a mobile-first Progressive Web App (PWA) that lets a user pick a photo, automatically removes the background, adds a white border, and produces a ready-to-share sticker PNG — all in a few seconds. It is built on a serverless AWS backend with a Vite + React 18 frontend deployed on Vercel, with infrastructure managed through AWS CDK.

**Live demo:** https://youtu.be/koUffXNqDVE

---

## Table of Contents

- [StickerSnap](#stickersnap)
  - [Table of Contents](#table-of-contents)
  - [What it does](#what-it-does)
  - [Architecture](#architecture)
    - [High-level flow](#high-level-flow)
    - [Infrastructure diagram](#infrastructure-diagram)
    - [Why these choices?](#why-these-choices)
  - [Repository layout](#repository-layout)
  - [Key features and design decisions](#key-features-and-design-decisions)
    - [1. Mobile-first PWA](#1-mobile-first-pwa)
    - [2. Client-side image resize before upload](#2-client-side-image-resize-before-upload)
    - [3. Direct S3 upload via presigned URL](#3-direct-s3-upload-via-presigned-url)
    - [4. Docker-based Lambda for ML dependencies](#4-docker-based-lambda-for-ml-dependencies)
    - [5. Animated processing screen](#5-animated-processing-screen)
    - [6. Quota enforcement at the Lambda layer](#6-quota-enforcement-at-the-lambda-layer)
    - [7. Kill switch for cost control](#7-kill-switch-for-cost-control)
    - [8. Separate dev and prod environments](#8-separate-dev-and-prod-environments)
  - [Environment variables](#environment-variables)
    - [Frontend](#frontend)
    - [Lambda](#lambda)
  - [Local development](#local-development)
    - [Prerequisites](#prerequisites)
    - [Install dependencies](#install-dependencies)
    - [Run the Lambda locally (Docker)](#run-the-lambda-locally-docker)
    - [Run the frontend](#run-the-frontend)
  - [AWS deployment](#aws-deployment)
    - [Bootstrap (once per account/region)](#bootstrap-once-per-accountregion)
    - [Deploy](#deploy)
    - [Build and deploy the frontend](#build-and-deploy-the-frontend)
    - [Branching and production deployments](#branching-and-production-deployments)
  - [CI/CD](#cicd)
    - [Continuous Integration](#continuous-integration)
    - [Continuous Deployment / Delivery](#continuous-deployment--delivery)
    - [GitHub Actions secrets setup](#github-actions-secrets-setup)
  - [Useful commands reference](#useful-commands-reference)
  - [CORS notes](#cors-notes)
  - [Testing](#testing)
    - [Backend (Python / pytest)](#backend-python--pytest)
    - [Frontend (Node / Vitest)](#frontend-node--vitest)
    - [Infrastructure (CDK synth)](#infrastructure-cdk-synth)
    - [CI thresholds](#ci-thresholds)
  - [Sensitive information checklist](#sensitive-information-checklist)

---

## What it does

1. User opens the PWA on their phone and picks (or takes) a photo.
2. The browser resizes the image on a canvas before touching the network.
3. The app asks the backend for a short-lived S3 upload URL and uploads directly to S3.
4. The backend Lambda downloads the image, strips the background with [rembg](https://github.com/danielgatis/rembg) (U2-Net model), adds a clean white border with Pillow, and saves a PNG.
5. The app polls for the result, shows a step-by-step animated processing screen, and presents the finished sticker.
6. The user can save it to their gallery, copy it to the clipboard, or share it via the native OS share sheet.

---

## Architecture

### High-level flow

```
Browser PWA
  │ 1. POST { action: "presign_upload", object_key, device_id }
  ▼
Lambda Function URL  ──── DynamoDB QuotaTable (check & reserve)
  │ 2. returns presigned S3 PUT URL
  ▼
S3 assets bucket
  │ 3. browser PUTs resized JPEG directly
  ▼
Browser PWA
  │ 4. POST { object_key, device_id }
  ▼
Lambda Function URL
  │ 5. download → rembg → Pillow border → upload PNG
  ▼
S3 assets bucket: outputs/<uuid>_sticker.png
  │ 6. returns presigned GET URL (1 h TTL)
  ▼
Browser PWA  →  save / copy / share
```

### Infrastructure diagram

```
                        ┌───────────────────────────────────┐
                        │          AWS (ap-southeast-1)     │
                        │                                   │
  Browser PWA  ◄──────► │  Lambda Function URL (prod / dev) │
  (React + Vite)        │      │              │             │
  hosted on Vercel      │      ▼              ▼             │
                        │  S3 AssetsBucket  DynamoDB        │
                        │  (uploads/ +      QuotaTable      │
                        │   outputs/)                       │
                        └───────────────────────────────────┘

  GitHub Actions  ──OIDC──►  IAM Deploy Role  ──►  ECR + Lambda update
```

**AWS resources created by CDK:**

| Resource              | Name pattern                                | Purpose                            |
| --------------------- | ------------------------------------------- | ---------------------------------- |
| `AssetsBucket`        | `stickersnap-assets-{account}-{region}`     | Prod image store                   |
| `AssetsBucketDev`     | `stickersnap-assets-dev-{account}-{region}` | Dev image store                    |
| `ProcessingLambda`    | Docker Lambda                               | Prod background removal            |
| `ProcessingDevLambda` | Docker Lambda                               | Dev background removal             |
| `QuotaTable`          | DynamoDB                                    | Per-device / per-IP quota counters |
| GitHub OIDC role      | `StickerSnapGitHubActionsRole`              | Keyless CI/CD                      |

Both S3 buckets have a **1-day lifecycle rule** on `uploads/` and `outputs/` to keep storage costs near zero.

The frontend is hosted entirely on **Vercel** — no S3 bucket or CloudFront distribution is provisioned by CDK.

### Why these choices?

| Decision                                   | Rationale                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Lambda Function URL instead of API Gateway | No extra cost, simpler setup, sufficient for this use case (no auth, no routing, no throttling config)      |
| Direct S3 upload via presigned URL         | Lambda never proxies binary data — avoids the 6 MB payload limit and removes unnecessary data transfer cost |
| Docker Lambda instead of a zip deployment  | rembg + PyTorch/ONNX + NumPy exceed the 250 MB zip limit; Docker images up to 10 GB are supported           |
| DynamoDB for quota                         | Serverless, no idle cost, atomic conditional writes make per-device counter updates race-condition safe     |
| CDK (TypeScript) for infrastructure        | Typed, testable, version-controlled infra; `cdk diff` makes change reviews easy before every deploy         |
| Vercel for frontend hosting                | Zero-config deployments, automatic preview URLs per branch, and no S3/CloudFront setup required             |
| Region `ap-southeast-1`                    | Singapore; lowest latency for the target user base                                                          |

---

## Repository layout

```
.
├── docker-compose.yml              # Run the Lambda container locally
├── .env.example                    # Root env template for local Lambda
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Run backend (pytest) and frontend (vitest) tests
│       └── deploy.yml              # Build Docker image, deploy dev/prod Lambda
├── frontend/
│   ├── src/
│   │   ├── components/             # UploadScreen, ProcessingScreen,
│   │   │                           # ResultScreen, ErrorScreen
│   │   ├── hooks/
│   │   │   ├── useUpload.ts        # Core upload + processing state machine
│   │   │   └── useShare.ts         # Save / copy / native share
│   │   ├── utils/imageUtils.ts     # Validation, UUID, canvas resize
│   │   └── styles/globals.css
│   ├── public/manifest.json        # PWA manifest
│   ├── vite.config.ts              # React plugin, PWA plugin, /lambda proxy
│   └── package.json
├── infra/
│   ├── bin/infra.ts                # CDK app entrypoint
│   ├── lib/stickersnap-stack.ts    # All AWS resources
│   ├── cdk.json
│   └── infra-README.md
└── lambda/
    ├── Dockerfile
    ├── handler.py                  # Presign + process Lambda handler
    ├── requirements.txt
    └── tests/test_handler.py
```

---

## Key features and design decisions

### 1. Mobile-first PWA

The app ships as a PWA so users can install it on their home screen and access the camera roll natively without an App Store. Vite's PWA plugin generates the service worker and asset manifest automatically. No React Native or Expo — one codebase, any device.

### 2. Client-side image resize before upload

`useUpload.ts` calls `resizeImage()` (a canvas-based helper in `imageUtils.ts`) to cap the longest edge at **1024 px** before any network request is made. This has two benefits: it significantly reduces upload time on mobile connections, and it prevents unexpectedly large files reaching Lambda. Lambda also enforces its own `MAX_IMAGE_DIMENSION_PX` cap as a defence-in-depth measure.

### 3. Direct S3 upload via presigned URL

The upload flow is split into two Lambda calls:

1. **`presign_upload`** — Lambda validates the request, checks quota, reserves a slot in DynamoDB, and returns a short-lived S3 `PUT` URL. The browser then uploads the JPEG **directly to S3**, bypassing Lambda entirely for the binary transfer.
2. **Process** — A second Lambda call triggers background removal on the already-uploaded file.

This pattern keeps Lambda invocation duration (and cost) low, avoids the 6 MB request payload limit, and lets the browser report real upload progress via `XMLHttpRequest.upload.onprogress`.

### 4. Docker-based Lambda for ML dependencies

Background removal uses [rembg](https://github.com/danielgatis/rembg) with the U2-Net model, which pulls in PyTorch/ONNX, NumPy, and Pillow. These exceed AWS Lambda's 250 MB zip size limit. The Lambda is therefore packaged as a **Docker image** and published to the CDK-managed ECR repository at deploy time — no manual ECR setup required.

Model and cache files are written to `/tmp` paths (`U2NET_HOME`, `NUMBA_CACHE_DIR`, `XDG_CACHE_HOME`) because Lambda's filesystem is read-only outside `/tmp`.

### 5. Animated processing screen

Once the image is uploaded, the `ProcessingScreen` component shows the user what is happening in real time with:

- **Named steps** — e.g. _Uploading_, _Removing background_, _Adding border_, _Finishing up_ — each highlighted as the pipeline progresses.
- **An overall progress bar** — fills smoothly across all steps without showing a raw percentage, so it feels responsive even when individual steps take variable time.

The hook tracks a `"ready"` state (result returned but animation not finished) separately from `"done"` (animation complete, result screen shown). This means the sticker URL is available in the background while the completion animation finishes, avoiding a jarring jump.

### 6. Quota enforcement at the Lambda layer

To prevent abuse and keep AWS costs predictable, sticker generation is rate-limited before any compute runs. On the **`presign_upload`** call, Lambda checks three counters in DynamoDB:

| Counter            | Default limit | Key                  |
| ------------------ | ------------- | -------------------- |
| Per-device per day | 2             | `DAILY_DEVICE_LIMIT` |
| Per-IP per day     | 3             | `DAILY_IP_LIMIT`     |
| Per-IP per hour    | 2             | `HOURLY_IP_LIMIT`    |

All limits are **environment variables** on the Lambda function, so they can be changed in the AWS console or via a CDK redeploy without touching code. When a limit is hit, the Lambda returns `HTTP 429` with a `reset_at` timestamp. `useUpload.ts` reads this and shows a human-readable message like _"Limit reached. You can make more after Jun 3, 8:00 AM."_

Quota uses a `QUOTA_NAMESPACE` (`dev` or `prod`) so dev testing does not eat into prod allowances.

### 7. Kill switch for cost control

If the backend needs to be shut off quickly (e.g. unexpected traffic spike or Lambda cost runaway), two things happen:

- **Lambda side:** The `QUOTA_TABLE_NAME` environment variable can be left unset, which disables quota enforcement and signals the function to reject all processing requests.
- **Frontend side:** Setting `VITE_BACKEND_ENABLED=false` at build time short-circuits the upload flow entirely. Instead of making any network calls, the app immediately displays a configurable message: _"Sticker generation is temporarily unavailable. Drop me a message if you'd like to give it a try!"_

This lets the UI stay up and readable while the backend is paused, and requires no code change — just an environment variable toggle.

### 8. Separate dev and prod environments

CDK creates **two fully independent environments** from the same stack:

- `AssetsBucketDev` + `ProcessingDevLambda` with `QUOTA_NAMESPACE=dev`
- `AssetsBucket` + `ProcessingLambda` with `QUOTA_NAMESPACE=prod`

The dev Lambda URL can be used during local frontend development without touching production data or counters. Both environments share the same Docker image build; CDK handles publishing and Lambda updates during `cdk deploy`.

---

## Environment variables

### Frontend

| Variable               | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `VITE_LAMBDA_URL`      | Lambda Function URL, or `/lambda` to proxy through Vite's local dev server |
| `VITE_BACKEND_ENABLED` | Set to `false` to show the kill-switch message and disable all uploads     |

### Lambda

| Variable                       | Default                 | Description                                                |
| ------------------------------ | ----------------------- | ---------------------------------------------------------- |
| `BUCKET_NAME`                  | _required_              | S3 bucket for both `uploads/` and `outputs/`               |
| `UPLOADS_PREFIX`               | `uploads/`              | Accepted upload key prefix                                 |
| `OUTPUTS_PREFIX`               | `outputs/`              | Generated sticker key prefix                               |
| `PRESIGNED_URL_EXPIRY_SECONDS` | `3600`                  | Output download URL lifetime                               |
| `BORDER_SIZE_PX`               | `12`                    | White sticker border thickness                             |
| `MAX_IMAGE_DIMENSION_PX`       | `1024`                  | Lambda-side longest-edge cap                               |
| `ALLOWED_ORIGIN`               | `http://localhost:5173` | Used in manual `OPTIONS` CORS response                     |
| `QUOTA_TABLE_NAME`             | _unset_                 | DynamoDB quota table name. **If unset, quota is disabled** |
| `QUOTA_NAMESPACE`              | `default`               | Set to `dev` or `prod` by CDK                              |
| `DAILY_DEVICE_LIMIT`           | `2`                     | Stickers per device per UTC day                            |
| `DAILY_IP_LIMIT`               | `3`                     | Stickers per IP per UTC day                                |
| `HOURLY_IP_LIMIT`              | `2`                     | Stickers per IP per UTC hour                               |
| `NUMBA_CACHE_DIR`              | `/tmp/numba_cache`      | Writable Numba cache for Lambda                            |
| `U2NET_HOME`                   | `/tmp/u2net`            | rembg model cache location                                 |
| `XDG_CACHE_HOME`               | `/tmp/cache`            | General cache location                                     |
| `HOME`                         | `/tmp`                  | Avoids writes to Lambda's read-only home dir               |

---

## Local development

### Prerequisites

- Node.js 18+
- Python 3.11
- Docker
- AWS CLI v2 with credentials configured (`aws configure`)
- AWS CDK v2 (`npm install -g aws-cdk`)

### Install dependencies

```bash
npm --prefix frontend install
npm --prefix infra install
pip install -r lambda/requirements.txt
```

### Run the Lambda locally (Docker)

```bash
# Copy and fill in the root env file
cp .env.example .env
# Edit .env: set BUCKET_NAME, AWS_DEFAULT_REGION, ALLOWED_ORIGIN

docker compose up --build
```

The Lambda Runtime Interface Emulator listens on `http://localhost:9000`.

### Run the frontend

```bash
cd frontend
cp .env.example .env.local
# Set VITE_LAMBDA_URL=/lambda  (Vite proxies /lambda → localhost:9000)
npm run dev
```

The Vite dev server proxies `/lambda` → `http://localhost:9000/2015-03-31/functions/function/invocations` so frontend code can call the local Lambda as if it were deployed.

> **Note:** Full upload testing requires `BUCKET_NAME` to point to a real S3 bucket that your local credentials can read/write. S3 CORS on that bucket must allow `http://localhost:5173` for `GET`, `PUT`, and `HEAD`.

---

## AWS deployment

### Bootstrap (once per account/region)

```bash
cd infra
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-southeast-1
```

### Deploy

```bash
cd infra
npm run deploy
```

CDK builds the Docker image, pushes it to ECR, and creates or updates all resources. Note the Lambda Function URLs printed in the CDK outputs — you will need them for the frontend build.

### Build and deploy the frontend

The frontend is deployed automatically by Vercel on every push to the `production` branch. For a manual local build:

```bash
cd frontend
echo "VITE_LAMBDA_URL=<LambdaFunctionUrl from CDK output>" > .env.production
npm run build
```

Set `VITE_LAMBDA_URL` in your Vercel project's environment variables so production builds pick up the correct Lambda URL without a local `.env.production` file.

### Branching and production deployments

This repository uses separate `main` and `production` branches:

- `main` is the primary development branch.
- `production` contains code that is deployed to the live site.

The Vercel project is configured to track the `production` branch. Any commit pushed directly to `production`, or merged into `production`, will automatically trigger a production deployment.

**Deployment workflow:**

1. Create feature branches from `main`.
2. Open pull requests into `main`.
3. Once changes are validated, merge `main` into `production`.
4. Vercel automatically deploys the latest commit on `production`.

```text
feature/* → main → production → Vercel Production Deployment
```

---

## CI/CD

This project uses two GitHub Actions workflows for automated testing and AWS backend deployment. The frontend is handled entirely by Vercel's GitHub integration and is not part of these workflows.

### Continuous Integration

**Workflow:** `.github/workflows/ci.yml`  
**Triggers:** every push and pull request to `main` or `production`

Two jobs run in parallel:

**`backend` — Python tests (pytest)**

Runs inside the `lambda/` directory against Python 3.11. Installs runtime deps from `requirements.txt` plus test deps from `requirements-test.txt`, then runs:

```bash
pytest tests/ -v --tb=short --cov=handler --cov-fail-under=80
```

Coverage must reach **80%** for the job to pass. A coverage XML report is uploaded as an artifact (`backend-coverage`, retained for 14 days).

**`frontend` — Node tests (Vitest)**

Runs inside the `frontend/` directory against Node 24. After `npm ci` and an optional type-check (`npm run typecheck`), it runs:

```bash
npm test -- --reporter=verbose --coverage --coverage.thresholds.lines=30
```

Line coverage must reach **30%** for the job to pass. An lcov report is uploaded as an artifact (`frontend-coverage`, retained for 14 days).

A final `all-checks-pass` job acts as a single status check that branch protection rules can key off — the PR cannot be merged unless both `backend` and `frontend` succeed.

In-flight runs for the same branch are cancelled automatically when a new push arrives.

### Continuous Deployment / Delivery

**Workflow:** `.github/workflows/deploy.yml`  
**Triggers:** on successful completion of the CI workflow for `main` or `production`

Authentication to AWS uses OIDC — no long-lived credentials are stored in GitHub.

**Shared step — `build-image`**

Runs for both branches. Builds the Lambda Docker image for `linux/amd64`, tags it with the commit SHA and `latest`, and pushes both tags to ECR.

**`deploy-dev` — Continuous Deployment (runs on `main`)**

Automatically updates `ProcessingDevLambda` with the newly pushed image. No approval required — dev environment breakage is expected and easy to roll back.

**`deploy-prod` — Continuous Delivery (runs on `production`)**

Pauses at the `environment: production` gate and sends an approval request to configured reviewers. Once approved, `ProcessingLambda` is updated with the image that was already pushed to ECR. The actual Lambda update takes ~30 seconds after approval.

```text
push to main       → CI passes → build-image → deploy-dev   (automatic)
push to production → CI passes → build-image → (approval)  → deploy-prod
```

### GitHub Actions secrets setup

After running `cdk deploy` once, copy the CDK outputs into your repository's **Settings → Secrets and variables → Actions**:

| Secret                      | CDK output                         |
| --------------------------- | ---------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`       | `GitHubActionsRoleArn`             |
| `AWS_REGION`                | e.g. `ap-southeast-1`              |
| `ECR_REPOSITORY_URI`        | ECR repo URI (AWS Console or CDK)  |
| `LAMBDA_DEV_FUNCTION_NAME`  | `StickerSnapDevLambdaFunctionName` |
| `LAMBDA_PROD_FUNCTION_NAME` | `StickerSnapLambdaFunctionName`    |

---

## Useful commands reference

| Task                                   | Command                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| **Start local Lambda**                 | `docker compose up --build` (from project root)         |
| **Stop local Lambda**                  | `docker compose down`                                   |
| **Start frontend dev server**          | `cd frontend && npm run dev`                            |
| **Type-check frontend**                | `cd frontend && npm run typecheck`                      |
| **Run backend unit tests**             | `cd lambda && pytest tests/ -v --tb=short`              |
| **Run frontend tests**                 | `cd frontend && npm test`                               |
| **Run frontend tests with coverage**   | `cd frontend && npm test -- --coverage`                 |
| **Synth CDK (preview CloudFormation)** | `cd infra && npm run synth`                             |
| **Diff CDK (preview changes)**         | `cd infra && cdk diff`                                  |
| **Deploy everything**                  | `cd infra && npm run deploy`                            |
| **Enable kill switch (frontend)**      | Set `VITE_BACKEND_ENABLED=false` and rebuild            |
| **Enable kill switch (backend)**       | `./scripts/disable-backend.sh` in root folder           |
| **Disable quota (Lambda)**             | Unset `QUOTA_TABLE_NAME` env var on the Lambda function |
| **Verify AWS identity**                | `aws sts get-caller-identity`                           |

---

## CORS notes

There are two independent CORS surfaces:

**Lambda Function URL CORS** — configured in CDK for `POST` requests from the frontend origin. Currently set to `*` for development; tighten to your Vercel domain before production launch.

**S3 bucket CORS** — required for browser `PUT` uploads to presigned URLs and browser `GET` requests to fetch sticker output. Must include:

- Local dev: origin `http://localhost:5173`, methods `GET PUT HEAD`
- Production: your Vercel domain, same methods

These are two separate configurations. Missing either one produces browser CORS errors that look identical — check both when debugging.

---

## Testing

### Backend (Python / pytest)

```bash
cd lambda
pip install -r requirements.txt -r requirements-test.txt
pytest tests/ -v --tb=short
```

To run with coverage:

```bash
pytest tests/ -v --tb=short \
  --cov=handler \
  --cov-report=term-missing \
  --cov-fail-under=80
```

Tests mock `rembg.remove` so the U2-Net model (~170 MB) is never downloaded locally. Set `NUMBA_DISABLE_JIT=1` to suppress Numba/LLVM noise in non-CI runs.

### Frontend (Node / Vitest)

```bash
cd frontend
npm ci
npm test
```

To run with coverage:

```bash
npm test -- --coverage --coverage.reporter=text
```

An optional type-check step runs before tests in CI:

```bash
npm run typecheck
```

### Infrastructure (CDK synth)

```bash
cd infra
npm run synth
```

This synthesises the CloudFormation template and validates that all CDK constructs resolve without errors — a lightweight sanity check that does not require AWS credentials.

### CI thresholds

| Suite    | Tool   | Coverage threshold |
| -------- | ------ | ------------------ |
| Backend  | pytest | 80% (lines)        |
| Frontend | Vitest | 30% (lines)        |

Both thresholds are enforced in CI and will fail the build if not met.

---

## Sensitive information checklist

**Never commit:**

- Root `.env` (contains `BUCKET_NAME` and real AWS region)
- `frontend/.env.local` (contains Lambda URLs)
- Real AWS access keys, secret access keys, or session tokens
- Real Lambda Function URLs (if this is a public repository)
- `infra/cdk.out/` — synthesised templates contain account IDs, ARNs, and generated bucket names
- `.DS_Store` files

**Safe to commit:**

- `.env.example` and `frontend/.env.example` (placeholder values only)

**To review:**

- Bucket names include your AWS account ID at deploy time.
- `StickerSnapGitHubActionsRole` is scoped to `repo:nicollegann/StickerSnap:*` — update the CDK stack if the repo is renamed or transferred.
- Lambda Function URL and S3 bucket CORS are set to `*` in the current CDK code — restrict to your Vercel domain before launch.
