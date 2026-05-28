# StickerSnap

Turn a photo into a sticker from a mobile-friendly PWA. The app resizes the image in the browser, uploads it directly to S3 with a presigned URL, runs a Lambda image-processing pipeline, and returns a temporary URL for the finished PNG sticker.

## Table of Contents

- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [AWS Deployment](#aws-deployment)
- [CORS Notes](#cors-notes)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Sensitive Information Checklist](#sensitive-information-checklist)

## Architecture

```text
Browser PWA
  | 1. POST { action: "presign_upload", object_key }
  v
Lambda Function URL
  | 2. returns presigned S3 PUT URL
  v
S3 assets bucket: uploads/<uuid>.jpg
  ^
  | 3. browser uploads resized image directly to S3
  |
Browser PWA
  | 4. POST { object_key }
  v
Lambda Function URL
  | 5. download image, remove background, add border, upload PNG
  v
S3 assets bucket: outputs/<uuid>_sticker.png
  | 6. presigned GET URL
  v
Browser PWA
```

- **Frontend:** Vite + React 18 PWA served locally by Vite and deployable behind CloudFront.
- **Upload flow:** Browser asks Lambda for a presigned `PUT`, then uploads directly to S3.
- **Processing:** Docker-based Python Lambda uses REMBG, Pillow, NumPy, and boto3.
- **Storage:** One assets bucket per environment, with `uploads/` and `outputs/` prefixes and 1-day lifecycle cleanup.
- **Infrastructure:** AWS CDK creates prod and dev assets buckets, prod and dev processing Lambdas, Lambda Function URLs, a frontend bucket, CloudFront, IAM, and a GitHub Actions OIDC role.
- **Region default:** `ap-southeast-1`.

## Repository Layout

```text
.
├── docker-compose.yml              # Local Lambda container runner
├── frontend/
│   ├── src/
│   │   ├── components/             # Upload, processing, result, and error screens
│   │   ├── hooks/
│   │   │   ├── useUpload.ts        # Resize, presign, S3 upload, process request
│   │   │   └── useShare.ts         # Save, clipboard, Web Share, Telegram, WhatsApp
│   │   ├── utils/imageUtils.ts     # Validation, UUID, canvas resize
│   │   └── styles/globals.css
│   ├── public/manifest.json
│   ├── vite.config.ts              # React + PWA plugin and local Lambda proxy
│   └── package.json
├── infra/
│   ├── bin/infra.ts                # CDK app entrypoint
│   ├── lib/stickersnap-stack.ts    # S3, Lambda, CloudFront, IAM, outputs
│   ├── cdk.json
│   └── infra-README.md
└── lambda/
    ├── Dockerfile
    ├── handler.py                  # Presign + processing Lambda handler
    ├── requirements.txt
    └── tests/test_handler.py
```

## Prerequisites

- Node.js 18 or newer
- Python 3.11
- Docker
- AWS CLI v2
- AWS CDK v2

Configure AWS credentials before deploying:

```bash
aws configure
aws sts get-caller-identity
```

## Local Development

Install dependencies from the project root:

```bash
npm --prefix frontend install
npm --prefix infra install
pip install -r lambda/requirements.txt
```

Run the Lambda container locally from the project root:

```bash
docker compose up --build
```

The compose file reads root `.env`. Use `.env.example` as the template:

```text
BUCKET_NAME=your-bucket-name
AWS_DEFAULT_REGION=ap-southeast-1
ALLOWED_ORIGIN=http://localhost:5173
```

Run the frontend from a separate terminal:

```bash
cd frontend
cp .env.example .env.local
npm run dev
```

For local frontend-to-local-Lambda testing, set:

```text
VITE_LAMBDA_URL=/lambda
```

The Vite dev server proxies `/lambda` to the local Lambda Runtime Interface Emulator endpoint at `http://localhost:9000/2015-03-31/functions/function/invocations`.

For full upload and processing tests, `BUCKET_NAME` must point to an S3 bucket that the local AWS credentials can read and write. The browser still uploads to the presigned S3 URL, so the bucket CORS must allow the local frontend origin.

## AWS Deployment

CDK builds the Lambda Docker image, publishes it to the CDK-managed ECR asset repository, and updates both Lambda functions during deploy. You do not need to create an ECR repository or push the Lambda image manually.

Bootstrap once per account and region:

```bash
cd infra
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-southeast-1
```

Deploy:

```bash
cd infra
npm run deploy
```

The stack creates:

- `AssetsBucket`: production assets bucket, named `stickersnap-assets-{account}-{region}`
- `AssetsBucketDev`: development assets bucket, named `stickersnap-assets-dev-{account}-{region}`
- `ProcessingLambda`: production Docker Lambda
- `ProcessingDevLambda`: development Docker Lambda
- Two public Lambda Function URLs, one for each Lambda
- `FrontendBucket`: private bucket for the built React app
- `FrontendDistribution`: CloudFront distribution with S3 Origin Access Control
- GitHub Actions OIDC provider and deploy role
- CloudFormation outputs for bucket names, Lambda URLs, Lambda names, CloudFront domain, distribution ID, and deploy role ARN

Build the frontend with the Lambda URL you want to use, from the project root:

```bash
cd frontend
echo "VITE_LAMBDA_URL=<LambdaDevFunctionUrl-or-LambdaFunctionUrl>" > .env.production
npm run build
```

Deploy the built frontend to the CDK output bucket:

```bash
aws s3 sync dist/ s3://<FrontendBucketName> --delete
aws cloudfront create-invalidation \
  --distribution-id <CloudFrontDistributionId> \
  --paths "/*"
```

## CORS Notes

There are two separate CORS surfaces:

- **Lambda Function URL CORS:** configured in CDK for `POST` requests from the frontend. The current `_ok` and `_error` helpers do not add CORS headers.
- **S3 bucket CORS:** required for browser `PUT` uploads to presigned S3 URLs and browser `GET` fetches of generated stickers.

For local dev against the dev bucket, S3 CORS should include `http://localhost:5173` and methods `GET`, `PUT`, and `HEAD`. If you lock CORS down for production, include the CloudFront origin or custom domain used by the deployed frontend.

## Environment Variables

Frontend:

| Variable | Used by | Description |
| --- | --- | --- |
| `VITE_LAMBDA_URL` | Vite app | Lambda Function URL or `/lambda` for the local Vite proxy |

Lambda:

| Variable | Default | Description |
| --- | --- | --- |
| `BUCKET_NAME` | required | Assets bucket containing both `uploads/` and `outputs/` |
| `UPLOADS_PREFIX` | `uploads/` | Accepted upload key prefix |
| `OUTPUTS_PREFIX` | `outputs/` | Generated sticker key prefix |
| `PRESIGNED_URL_EXPIRY_SECONDS` | `3600` | Presigned output download URL lifetime |
| `BORDER_SIZE_PX` | `12` | White sticker border size |
| `MAX_IMAGE_DIMENSION_PX` | `1024` | Lambda-side longest-edge resize cap |
| `ALLOWED_ORIGIN` | `http://localhost:5173` | Used by the handler's manual `OPTIONS` response |
| `NUMBA_CACHE_DIR` | `/tmp/numba_cache` | Writable cache location for Lambda |
| `U2NET_HOME` | `/tmp/u2net` | REMBG model cache location |
| `XDG_CACHE_HOME` | `/tmp/cache` | General cache location |
| `HOME` | `/tmp` | Avoids writes to Lambda's read-only home directory |

## Testing

Lambda tests:

```bash
cd lambda
pytest tests/ -v --tb=short
```

Frontend typecheck and build:

```bash
cd frontend
npm run build
```

Infrastructure synth:

```bash
cd infra
npm run synth
```

## Sensitive Information Checklist

Do not commit:

- Root `.env`
- `frontend/.env.local`
- Real AWS access keys, secret access keys, or session tokens
- Real Lambda Function URLs if this is a public repository
- Real CloudFront distribution IDs if you do not want deployment metadata public
- `infra/cdk.out/`, because synthesized templates can contain account IDs, ARNs, generated bucket names, and deployment metadata
- `.DS_Store` files

Currently safe-to-commit templates:

- `.env.example`
- `frontend/.env.example`

Review before sharing publicly:

- Bucket name patterns include the AWS account ID at deploy time.
- `GitHubActionsDeployRole` currently contains the placeholder `repo:YOUR_GITHUB_ORG/stickersnap:*`; replace it with your real GitHub owner and repo before using CI/CD.
- S3 and Lambda Function URL CORS are permissive in CDK (`*`) for development. Restrict them to the deployed frontend origin before production launch.
