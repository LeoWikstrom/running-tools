#!/usr/bin/env bash
# Gradle-free build for Termux — android/runtour/build.sh is the pattern.
# RaceTwin is only a WebView over apps/profile-course's build, so there is no
# variant machinery; it signs with the suite's shared keystore.
set -euo pipefail
cd "$(dirname "$0")"

API="${API:-34}"
MIN_API=26
SDK_DIR="${SDK_DIR:-$HOME/android-sdk}"
ANDROID_JAR="${ANDROID_JAR:-$SDK_DIR/android-$API.jar}"
KS="../runtour/keystore/runtour.jks"
KS_PASS="runtour"
VERSION_NAME="${VERSION_NAME:-0.1}"
VERSION_CODE="$(date +%Y%m%d%H)"   # grows with every build, so reinstalls upgrade in place

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1  (pkg install $2)"; exit 1; }; }
need aapt2 aapt2
need d8 d8
need apksigner apksigner
need javac openjdk-17
need python3 python

[ -f "$ANDROID_JAR" ] || { echo "run android/runtour/build.sh once first — it fetches android.jar"; exit 1; }
[ -f "$KS" ] || { echo "run android/runtour/build.sh once first — it creates the keystore"; exit 1; }

# 1. the web app is the asset: build apps/profile-course and ship its dist as www/
if [ "${SKIP_WEB:-0}" != 1 ]; then
  (cd ../../apps/profile-course && npm run build)
fi
[ -f ../../apps/profile-course/dist/index.html ] || { echo "apps/profile-course/dist missing"; exit 1; }
rm -rf assets
mkdir -p assets/www
cp -r ../../apps/profile-course/dist/. assets/www/

rm -rf build
mkdir -p build/gen build/classes build/dex

# 2. resources
aapt2 compile --dir res -o build/res.zip
aapt2 link -o build/base.apk -I "$ANDROID_JAR" \
  --manifest AndroidManifest.xml -A assets --java build/gen \
  --min-sdk-version "$MIN_API" --target-sdk-version "$API" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  build/res.zip

# 3. java -> class -> dex
javac --release 11 -encoding UTF-8 -cp "$ANDROID_JAR" -d build/classes \
  $(find src build/gen -name '*.java')
d8 --release --lib "$ANDROID_JAR" --min-api "$MIN_API" --output build/dex \
  $(find build/classes -name '*.class')

# 4. add classes.dex and align resources.arsc
python3 ../runtour/align.py build/base.apk build/dex/classes.dex build/aligned.apk

# 5. sign
apksigner sign --ks "$KS" --ks-key-alias runtour --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out build/racetwin.apk build/aligned.apk
apksigner verify build/racetwin.apk
echo
echo "built build/racetwin.apk (versionCode $VERSION_CODE)"
echo "install with:  termux-open build/racetwin.apk"
