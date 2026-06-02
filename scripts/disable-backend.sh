#!/bin/bash
aws lambda put-function-concurrency \
  --function-name StickerSnapStack-ProcessingLambda0A3B4A63-JVbgaZuuNVBV \
  --reserved-concurrent-executions 0
echo "Backend disabled"