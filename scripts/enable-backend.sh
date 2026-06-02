#!/bin/bash
aws lambda delete-function-concurrency \
  --function-name StickerSnapStack-ProcessingLambda0A3B4A63-JVbgaZuuNVBV
echo "Backend enabled"

# Afterwards, remember to set VITE_BACKEND_ENABLED=true in frontend/.env.local and redeploy the frontend to reflect the changes.