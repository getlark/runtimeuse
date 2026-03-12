#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

S3_BUCKET="${S3_BUCKET:?S3_BUCKET env var is required (set in .env or pass inline)}"
S3_PREFIX="${S3_PREFIX:-local-dev}"
PRESIGN_EXPIRY="${PRESIGN_EXPIRY:-3600}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ZIP_NAME="runtimeuse-dev-${TIMESTAMP}.zip"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR=$(mktemp -d)

cleanup() { rm -rf "$STAGING_DIR" "$PROJECT_DIR/$ZIP_NAME"; }
trap cleanup EXIT

echo "Building..."
npm run build --prefix "$PROJECT_DIR"

echo "Staging package..."
cp "$PROJECT_DIR/package.json" "$STAGING_DIR/"
cp -r "$PROJECT_DIR/dist" "$STAGING_DIR/dist"
(cd "$STAGING_DIR" && npm install --omit=dev --ignore-scripts)

echo "Creating zip..."
(cd "$STAGING_DIR" && zip -qr "$PROJECT_DIR/$ZIP_NAME" .)

S3_KEY="${S3_PREFIX}/${ZIP_NAME}"
echo "Uploading to s3://${S3_BUCKET}/${S3_KEY}..."
aws s3 cp "$PROJECT_DIR/$ZIP_NAME" "s3://${S3_BUCKET}/${S3_KEY}"

URL=$(aws s3 presign "s3://${S3_BUCKET}/${S3_KEY}" --expires-in "$PRESIGN_EXPIRY")

echo ""
echo "Download URL (expires in ${PRESIGN_EXPIRY}s):"
echo "$URL"
echo ""
echo "Quick start:"
echo "  curl -L \"$URL\" -o runtimeuse.zip && unzip -o runtimeuse.zip -d runtimeuse && node runtimeuse/dist/cli.js & echo \"RuntimeUse WS server started (PID \$!)\""
