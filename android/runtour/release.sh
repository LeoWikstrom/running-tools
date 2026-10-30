#!/usr/bin/env bash
# Build all three APKs and publish them as one GitHub Release. The landing
# page links to releases/latest/download/<app>.apk, which always serves the
# newest release. Usage: ./release.sh [tag]   (default tag: v<today>)
set -euo pipefail
cd "$(dirname "$0")"

tag=${1:-v$(date +%Y.%m.%d)}

# Each build wipes its build/ directory, so the finished APKs are collected.
rm -rf release
mkdir -p release
./build.sh                               # also builds dist and dist-bus
cp build/runtour.apk release/
SKIP_WEB=1 VARIANT=bus ./build.sh
cp build/bustour.apk release/
(cd ../racetwin && ./build.sh)           # builds apps/profile-course itself
cp ../racetwin/build/racetwin.apk release/

gh release create "$tag" \
  release/runtour.apk release/bustour.apk release/racetwin.apk \
  --generate-notes
