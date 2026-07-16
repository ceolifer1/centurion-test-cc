#!/usr/bin/env bash
# Build the Piper container image LOCALLY. Does NOT push (no ECR creds in the
# build agent's context - SEC-2). The shared ECR repo is herald-browser
# (bootstrap/herald.tf); the deploy pipeline tags <agent>-<version> and pushes
# via the herald-deploy OIDC role, never from here.
set -euo pipefail

VERSION="${1:-$(node -e "process.stdout.write(require('./package.json').version)")}"
IMAGE="herald-browser:piper-${VERSION}"
# The infra/envs/herald-piper task def pins :piper-latest — build/push it too so
# the RunTask container_image default resolves without a per-deploy var override.
IMAGE_LATEST="herald-browser:piper-latest"
ACCOUNT="262602454064"
REGION="us-east-1"
ECR_URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${IMAGE}"
ECR_URI_LATEST="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${IMAGE_LATEST}"

cd "$(dirname "$0")/.."

echo "Building ${IMAGE} (+ :piper-latest) ..."
docker build -t "${IMAGE}" -t "${ECR_URI}" -t "${IMAGE_LATEST}" -t "${ECR_URI_LATEST}" .

echo ""
echo "Built local tags:"
echo "  ${IMAGE}"
echo "  ${IMAGE_LATEST}"
echo "  ${ECR_URI}          (push target - push happens in CI via herald-deploy OIDC)"
echo "  ${ECR_URI_LATEST}   (task def pins this tag)"
echo ""
echo "To push (CI only, authenticated):"
echo "  aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
echo "  docker push ${ECR_URI}"
echo "  docker push ${ECR_URI_LATEST}"
