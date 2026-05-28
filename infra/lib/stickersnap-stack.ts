import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
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
          allowedOrigins: ["*"], // Restrict to CloudFront domain in production
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
          allowedOrigins: ["*"], // Restrict to CloudFront domain in production
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
        // Reserve one warm instance to eliminate cold starts for the first
        // user after a quiet period. Costs ~$3/month — remove if budget is
        // tight and you're happy to show a loading animation instead.
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
        // Reserve one warm instance to eliminate cold starts for the first
        // user after a quiet period. Costs ~$3/month — remove if budget is
        // tight and you're happy to show a loading animation instead.
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
    // development; restrict to the CloudFront domain in production.
    // ─────────────────────────────────────────────
    const lambdaDevUrl = processingDevLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public endpoint
      cors: {
        allowedOrigins: ["*"], // TODO: lock to CloudFront domain post-launch
        allowedHeaders: ["content-type"],
        allowedMethods: [lambda.HttpMethod.POST],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    const lambdaUrl = processingLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public endpoint
      cors: {
        allowedOrigins: ["*"], // TODO: lock to CloudFront domain post-launch
        allowedHeaders: ["content-type"],
        allowedMethods: [lambda.HttpMethod.POST],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    // ─────────────────────────────────────────────
    // Frontend S3 bucket — stores the built Vite/React app.
    // Only CloudFront (via OAC) can read from it; direct S3 access is denied.
    // ─────────────────────────────────────────────
    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `stickersnap-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─────────────────────────────────────────────
    // CloudFront distribution — CDN that serves the React PWA globally.
    // Uses Origin Access Control (OAC) so S3 bucket stays private.
    // The SPA rewrite rule (403/404 → /index.html) is essential for
    // client-side routing to work on direct URL loads or refreshes.
    // ─────────────────────────────────────────────
    const distribution = new cloudfront.Distribution(
      this,
      "FrontendDistribution",
      {
        defaultBehavior: {
          origin:
            origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          // SPA fallback — let React Router handle 404s client-side
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(0),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(0),
          },
        ],
        comment: "StickerSnap frontend CDN",
      },
    );

    // ─────────────────────────────────────────────
    // IAM role for GitHub Actions CI/CD.
    // The role is assumed via OIDC (no long-lived credentials).
    // Permissions are intentionally narrow:
    //   - ECR: push images (for Lambda deploys)
    //   - Lambda: update function code
    //   - S3: sync built frontend files
    //   - CloudFront: create cache invalidations
    //
    // SETUP REQUIRED: Replace GITHUB_ORG and GITHUB_REPO below, then run
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
            // Replace with your GitHub org/repo
            "token.actions.githubusercontent.com:sub":
              "repo:YOUR_GITHUB_ORG/stickersnap:*",
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

    // S3 + CloudFront — deploy frontend
    frontendBucket.grantReadWrite(githubActionsRole);
    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
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

    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName,
      description: "S3 bucket for the React frontend",
      exportName: "StickerSnapFrontendBucketName",
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

    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
      description:
        "CloudFront domain for the frontend (add CNAME for custom domain)",
      exportName: "StickerSnapCloudFrontDomain",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution.distributionId,
      description:
        "CloudFront distribution ID — used by CI/CD for cache invalidation",
      exportName: "StickerSnapCloudFrontDistributionId",
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
