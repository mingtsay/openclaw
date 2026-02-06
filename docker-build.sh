#!/usr/bin/env bash
set -e

VERSION="${1:-cojad-$(date +%Y.%-m.%-d)-jq}"

echo "Building OpenClaw Docker image: openclaw:${VERSION}"
docker build \
  --build-arg OPENCLAW_VERSION="${VERSION}" \
  -t "openclaw:${VERSION}" \
  -f Dockerfile .

# Also tag as latest cojad
docker tag "openclaw:${VERSION}" "openclaw:cojad"

echo "✅ Built successfully:"
echo "   - openclaw:${VERSION}"
echo "   - openclaw:cojad"
echo ""
echo "Environment variables set in image:"
echo "   OPENCLAW_BUNDLED_VERSION=${VERSION}"