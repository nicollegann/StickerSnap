import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import { Construct } from "constructs";
import * as path from "path";

export class StickerSnapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─────────────────────────────────────────────
    // S3 bucket — stores both uploads and processed sticker outputs.
    // Public access is blocked; the frontend talks to it via presigned URLs.
    // A lifecycle rule auto-deletes objects under uploads/ and outputs/ after
    // 24 hours so we don't accumulate unnecessary storage costs.
    // ─────────────────────────────────────────────
    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `stickersnap-assets-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep data on stack destroy
      lifecycleRules: [
        {
          id: "expire-uploads-and-outputs",
          prefix: "uploads/",
          expiration: cdk.Duration.days(1),
        },
        {
          id: "expire-outputs",
          prefix: "outputs/",
          expiration: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedOrigins: ["*"], // Restrict to Vercel domain in production
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    const assetsBucketDev = new s3.Bucket(this, "AssetsBucketDev", {
      bucketName: `stickersnap-assets-dev-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep data on stack destroy
      lifecycleRules: [
        {
          id: "expire-uploads-and-outputs",
          prefix: "uploads/",
          expiration: cdk.Duration.days(1),
        },
        {
          id: "expire-outputs",
          prefix: "outputs/",
          expiration: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedOrigins: ["*"], // Restrict to Vercel preview domain in production
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    // ─────────────────────────────────────────────
    // DynamoDB quota table — tracks daily/hourly anonymous usage and upload
    // reservations. TTL removes old counters/reservations automatically.
    // ─────────────────────────────────────────────
    const quotaTable = new dynamodb.Table(this, "QuotaTable", {
      partitionKey: {
        name: "quota_key",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─────────────────────────────────────────────
    // Docker image for Lambda — built from /lambda/Dockerfile.
    // CDK builds and pushes the image to ECR automatically during `cdk deploy`.
    // The REMBG model (~500 MB) is baked into the image at build time so Lambda
    // doesn't have to download it on every cold start.
    // ─────────────────────────────────────────────
    const lambdaImage = new ecr_assets.DockerImageAsset(this, "LambdaImage", {
      directory: path.join(__dirname, "../../lambda"),
      platform: ecr_assets.Platform.LINUX_AMD64, // Lambda runs on x86_64
    });

    // ─────────────────────────────────────────────
    // Lambda function — runs the sticker processing pipeline:
    //   1. Fetch uploaded image from S3 uploads/
    //   2. Remove background with REMBG
    //   3. Add white dilation border with Pillow
    //   4. Write finished sticker to S3 outputs/
    //   5. Return a presigned GET URL for the frontend to display
    //
    // Memory: 3 GB — REMBG's U²-Net model is memory-hungry; anything below
    //   2 GB causes OOM kills. Higher memory also gives proportionally more
    //   vCPU, which speeds up inference.
    // Timeout: 60 s — ample headroom even on a cold start with a large image.
    //   Typical warm execution is 3–8 s.
    // ─────────────────────────────────────────────
    const processingDevLambda = new lambda.DockerImageFunction(
      this,
      "ProcessingDevLambda",
      {
        code: lambda.DockerImageCode.fromEcr(lambdaImage.repository, {
          tagOrDigest: lambdaImage.imageTag,
        }),
        memorySize: 3008, // MB — max without requesting a quota increase
        timeout: cdk.Duration.seconds(120),
        description: "StickerSnap — background removal + sticker border",
        environment: {
          BUCKET_NAME: assetsBucketDev.bucketName,
          UPLOADS_PREFIX: "uploads/",
          OUTPUTS_PREFIX: "outputs/",
          PRESIGNED_URL_EXPIRY_SECONDS: "3600",
          BORDER_SIZE_PX: "12",
          MAX_IMAGE_DIMENSION_PX: "1024",
          QUOTA_TABLE_NAME: quotaTable.tableName,
          QUOTA_NAMESPACE: "dev",
          DAILY_DEVICE_LIMIT: "10", // set to 10 for dev to allow more testing
          DAILY_IP_LIMIT: "10",
          HOURLY_IP_LIMIT: "10",
          NUMBA_CACHE_DIR: "/tmp/numba_cache",
          NUMBA_DISABLE_JIT: "0",
          // Redirect all model/cache dirs to /tmp — the only writable dir in Lambda
          U2NET_HOME: "/tmp/u2net",
          XDG_CACHE_HOME: "/tmp/cache",
          HOME: "/tmp",
        },
        // Hard cap: max 10 concurrent executions at any time
        // leaves 10+ unreserved for other functions
        // reservedConcurrentExecutions: 10,
      },
    );

    const processingLambda = new lambda.DockerImageFunction(
      this,
      "ProcessingLambda",
      {
        code: lambda.DockerImageCode.fromEcr(lambdaImage.repository, {
          tagOrDigest: lambdaImage.imageTag,
        }),
        memorySize: 3008, // MB — max without requesting a quota increase
        timeout: cdk.Duration.seconds(120),
        description: "StickerSnap — background removal + sticker border",
        environment: {
          BUCKET_NAME: assetsBucket.bucketName,
          UPLOADS_PREFIX: "uploads/",
          OUTPUTS_PREFIX: "outputs/",
          PRESIGNED_URL_EXPIRY_SECONDS: "3600",
          BORDER_SIZE_PX: "12",
          MAX_IMAGE_DIMENSION_PX: "1024",
          QUOTA_TABLE_NAME: quotaTable.tableName,
          QUOTA_NAMESPACE: "prod",
          DAILY_DEVICE_LIMIT: "2",
          DAILY_IP_LIMIT: "3",
          HOURLY_IP_LIMIT: "2",
          NUMBA_CACHE_DIR: "/tmp/numba_cache",
          NUMBA_DISABLE_JIT: "0",
          // Redirect all model/cache dirs to /tmp — the only writable dir in Lambda
          U2NET_HOME: "/tmp/u2net",
          XDG_CACHE_HOME: "/tmp/cache",
          HOME: "/tmp",
        },
        // Hard cap: max 10 concurrent executions at any time
        // leaves 10+ unreserved for other functions
        // reservedConcurrentExecutions: 10,
      },
    );

    // ─────────────────────────────────────────────
    // IAM — grant Lambda least-privilege access to the S3 bucket.
    // It only needs to read from uploads/ and write to outputs/.
    // ─────────────────────────────────────────────
    assetsBucketDev.grantPut(processingDevLambda, "uploads/*"); // for presigned PUT URLs
    assetsBucketDev.grantRead(processingDevLambda, "uploads/*");
    assetsBucketDev.grantPut(processingDevLambda, "outputs/*"); // for processed sticker

    assetsBucket.grantPut(processingLambda, "uploads/*"); // for presigned PUT URLs
    assetsBucket.grantRead(processingLambda, "uploads/*"); // for downloading to process
    assetsBucket.grantPut(processingLambda, "outputs/*"); // for processed sticker
    quotaTable.grantReadWriteData(processingDevLambda);
    quotaTable.grantReadWriteData(processingLambda);

    // Also allow Lambda to generate presigned GET URLs for outputs/
    processingDevLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [assetsBucketDev.arnForObjects("outputs/*")],
      }),
    );

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [assetsBucket.arnForObjects("outputs/*")],
      }),
    );

    // ─────────────────────────────────────────────
    // Lambda Function URL — exposes Lambda over HTTPS without needing API
    // Gateway. CORS is configured to allow requests from any origin during
    // development; restrict to the Vercel domain in production.
    // ─────────────────────────────────────────────
    const lambdaDevUrl = processingDevLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public endpoint
      cors: {
        allowedOrigins: ["*"], // TODO: lock to Vercel preview domain post-launch
        allowedHeaders: ["content-type"],
        allowedMethods: [lambda.HttpMethod.POST],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    const lambdaUrl = processingLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public endpoint
      cors: {
        allowedOrigins: ["*"], // TODO: lock to Vercel production domain post-launch
        allowedHeaders: ["content-type"],
        allowedMethods: [lambda.HttpMethod.POST],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    // Frontend is deployed via Vercel — no S3 bucket or CloudFront needed.

    // ─────────────────────────────────────────────
    // IAM role for GitHub Actions CI/CD.
    // The role is assumed via OIDC (no long-lived credentials).
    // Permissions are intentionally narrow:
    //   - ECR: push images (for Lambda deploys)
    //   - Lambda: update function code
    //
    // Frontend is deployed via Vercel — no S3/CloudFront permissions needed.
    //
    // SETUP REQUIRED: Replace YOUR_GITHUB_ORG below, then run
    //   `cdk deploy` once to create the role. Copy the output RoleArn into
    //   your GitHub repo's Settings → Secrets as AWS_DEPLOY_ROLE_ARN.
    // ─────────────────────────────────────────────
    const githubOidcProvider = new iam.OpenIdConnectProvider(
      this,
      "GitHubOIDC",
      {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      },
    );

    const githubActionsRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "StickerSnapGitHubActionsRole",
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringLike: {
            "token.actions.githubusercontent.com:sub":
              "repo:nicollegann/stickersnap:*",
          },
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
        },
      ),
      description: "Assumed by GitHub Actions for CI/CD deploys",
    });

    // ECR — push Docker images
    lambdaImage.repository.grantPullPush(githubActionsRole);

    // Lambda — update function code after new image push
    processingDevLambda.grantInvoke(githubActionsRole); // sanity-check invocations
    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:UpdateFunctionCode"],
        resources: [processingDevLambda.functionArn],
      }),
    );

    processingLambda.grantInvoke(githubActionsRole); // sanity-check invocations
    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:UpdateFunctionCode"],
        resources: [processingLambda.functionArn],
      }),
    );

    // ─────────────────────────────────────────────
    // Stack outputs — printed after `cdk deploy` and stored in SSM-style
    // so GitHub Actions workflows can read them without hardcoding.
    // ─────────────────────────────────────────────
    new cdk.CfnOutput(this, "AssetsBucketName", {
      value: assetsBucket.bucketName,
      description: "S3 bucket for uploads and processed stickers",
      exportName: "StickerSnapAssetsBucketName",
    });

    new cdk.CfnOutput(this, "AssetsBucketNameDev", {
      value: assetsBucketDev.bucketName,
      description: "S3 bucket for uploads and processed stickers (dev)",
      exportName: "StickerSnapAssetsBucketNameDev",
    });

    new cdk.CfnOutput(this, "QuotaTableName", {
      value: quotaTable.tableName,
      description: "DynamoDB table for anonymous sticker quota counters",
      exportName: "StickerSnapQuotaTableName",
    });

    new cdk.CfnOutput(this, "LambdaDevFunctionUrl", {
      value: lambdaDevUrl.url,
      description:
        "Dev Lambda Function URL — POST endpoint for sticker processing",
      exportName: "StickerSnapDevLambdaFunctionUrl",
    });

    new cdk.CfnOutput(this, "LambdaFunctionUrl", {
      value: lambdaUrl.url,
      description: "Lambda Function URL — POST endpoint for sticker processing",
      exportName: "StickerSnapLambdaFunctionUrl",
    });

    new cdk.CfnOutput(this, "GitHubActionsRoleArn", {
      value: githubActionsRole.roleArn,
      description: "Copy this into GitHub Secrets as AWS_DEPLOY_ROLE_ARN",
      exportName: "StickerSnapGitHubActionsRoleArn",
    });

    new cdk.CfnOutput(this, "LambdaDevFunctionName", {
      value: processingDevLambda.functionName,
      description:
        "Lambda function name — used by CI/CD to update function code",
      exportName: "StickerSnapDevLambdaFunctionName",
    });

    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: processingLambda.functionName,
      description:
        "Lambda function name — used by CI/CD to update function code",
      exportName: "StickerSnapLambdaFunctionName",
    });
  }
}
