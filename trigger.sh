#!/bin/bash

PORT=${PORT:-3002}
API_SECRET="TV-Sync-\$3cr3t-K3y-2024-cookies!"
TOOL_ID=${1:-"all"}

echo "🚀 Triggering Google Flow sync for toolId=${TOOL_ID}..."

curl -s -X POST http://localhost:${PORT}/trigger \
  -H "Content-Type: application/json" \
  -H "X-Sync-Api-Key: ${API_SECRET}" \
  -d "{\"toolId\": \"${TOOL_ID}\"}" | jq . 2>/dev/null || echo "Done (install jq for pretty output)"
