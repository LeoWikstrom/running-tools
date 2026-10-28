#!/usr/bin/env bash
# Build the APK and publish it as a GitHub Release. The landing page links to
# releases/latest/download/runtour.apk, which always serves the newest release.
# Usage: ./release.sh [tag]   (default tag: v<today>)
set -euo pipefail
cd "$(dirname "$0")"

tag=${1:-v$(date +%Y.%m.%d)}

./build.sh
gh release create "$tag" build/runtour.apk --generate-notes
