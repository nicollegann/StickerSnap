#!/bin/bash
aws lambda delete-function-concurrency \
  --function-name StickerSnapStack-ProcessingLambda0A3B4A63-JVbgaZuuNVBV
echo "Backend enabled"