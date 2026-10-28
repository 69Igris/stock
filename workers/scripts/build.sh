#!/bin/bash
set -e

PROJECT_ID="stock-book-483718"
IMAGE_NAME="stockbook-workers"
TAG=${1:-latest}

echo "Building workers Docker image..."
docker build \
  -t gcr.io/${PROJECT_ID}/${IMAGE_NAME}:${TAG} \
  -f workers/Dockerfile \
  .

echo "Image built: gcr.io/${PROJECT_ID}/${IMAGE_NAME}:${TAG}"
echo ""
echo "To run locally:"
echo "  docker run -p 8081:8080 --env-file workers/.env gcr.io/${PROJECT_ID}/${IMAGE_NAME}:${TAG}"
echo ""
echo "To push to GCR:"
echo "  docker push gcr.io/${PROJECT_ID}/${IMAGE_NAME}:${TAG}"
