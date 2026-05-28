#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { StickerSnapStack } from "../lib/stickersnap-stack";

const app = new cdk.App();

new StickerSnapStack(app, "StickerSnapStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-southeast-1",
  },
  tags: {
    Project: "StickerSnap",
    ManagedBy: "CDK",
  },
});
