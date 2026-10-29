#!/usr/bin/env bash
# Gradle-free build for Termux, same approach as sylvester.
# Needs: openjdk-17, aapt2, d8, apksigner, python, curl.
#   pkg install openjdk-17 aapt2 d8 apksigner python curl
set -euo pipefail
cd "$(dirname "$0")"

API="${API:-34}"
MIN_API=26
SDK_DIR="${SDK_DIR:-$HOME/android-sdk}"
ANDROID_JAR="${ANDROID_JAR:-$SDK_DIR/android-$API.jar}"
KS="keystore/runtour.jks"
KS_PASS="runtour"
VERSION_NAME="${VERSION_NAME:-0.1}"
VERSION_CODE="$(date +%Y%m%d%H)"   # grows with every build, so reinstalls upgrade in place

# VARIANT=bus builds BusTour from the same sources: the dist-bus web build, a
# blue icon/label, and its own application id so both apps install side by
# side. R and the Java classes stay in se.leo.runtour — --rename-manifest-package
# only rewrites the final manifest.
VARIANT="${VARIANT:-run}"
if [ "$VARIANT" = bus ]; then
  APP_LABEL="BusTour"
  DIST="dist-bus"
  OUT="bustour.apk"
  RENAME=(--rename-manifest-package se.leo.bustour)
else
  APP_LABEL="RunTour"
  DIST="dist"
  OUT="runtour.apk"
  RENAME=()
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1  (pkg install $2)"; exit 1; }; }
need aapt2 aapt2
need d8 d8
need apksigner apksigner
need javac openjdk-17
need keytool openjdk-17
need python3 python

# 1. android.jar: taken from the official platform zip, cached in $SDK_DIR
if [ ! -f "$ANDROID_JAR" ]; then
  need curl curl
  mkdir -p "$SDK_DIR"
  ok=0
  for rev in 03 02 01; do
    url="https://dl.google.com/android/repository/platform-${API}_r${rev}.zip"
    echo "fetching $url"
    if curl -fL -o "$SDK_DIR/platform-$API.zip" "$url"; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "could not download platform-$API; set ANDROID_JAR to an existing android.jar"; exit 1; }
  python3 - "$SDK_DIR/platform-$API.zip" "$ANDROID_JAR" <<'PY'
import sys, zipfile
src, dst = sys.argv[1:3]
with zipfile.ZipFile(src) as z:
    name = next(n for n in z.namelist() if n.endswith('/android.jar') or n == 'android.jar')
    open(dst, 'wb').write(z.read(name))
print('android.jar ->', dst)
PY
  rm -f "$SDK_DIR/platform-$API.zip"
fi

# 2. signing key, created once and kept (same key = updates install over the old version)
if [ ! -f "$KS" ]; then
  mkdir -p keystore
  keytool -genkeypair -v -keystore "$KS" -alias runtour -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" -dname "CN=RunTour, O=Leo"
fi

# 3. the web app is the asset: build apps/runtour and ship its dist as www/
if [ "${SKIP_WEB:-0}" != 1 ]; then
  (cd ../../apps/runtour && npm run build)
fi
[ -f "../../apps/runtour/$DIST/index.html" ] || { echo "apps/runtour/$DIST missing; run npm run build there"; exit 1; }
rm -rf assets
mkdir -p assets/www
cp -r "../../apps/runtour/$DIST/." assets/www/

rm -rf build
mkdir -p build/gen build/classes build/dex

# 4. resources, re-branded per variant
cp -r res build/res-src
sed -i "s/>RunTour</>$APP_LABEL</" build/res-src/values/strings.xml
if [ "$VARIANT" = bus ]; then
  cp variants/ic_launcher_fg_bus.png build/res-src/drawable-nodpi/ic_launcher_fg.png
  sed -i "s/#2D7A4F/#1D5FA8/" build/res-src/values/colors.xml
fi
aapt2 compile --dir build/res-src -o build/res.zip
aapt2 link -o build/base.apk -I "$ANDROID_JAR" \
  --manifest AndroidManifest.xml -A assets --java build/gen \
  --min-sdk-version "$MIN_API" --target-sdk-version "$API" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  "${RENAME[@]}" \
  build/res.zip

# 5. java -> class -> dex
javac --release 11 -encoding UTF-8 -cp "$ANDROID_JAR" -d build/classes \
  $(find src build/gen -name '*.java')
d8 --release --lib "$ANDROID_JAR" --min-api "$MIN_API" --output build/dex \
  $(find build/classes -name '*.class')

# 6. add classes.dex and align resources.arsc (python replaces zipalign)
python3 align.py build/base.apk build/dex/classes.dex build/aligned.apk

# 7. sign
apksigner sign --ks "$KS" --ks-key-alias runtour --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "build/$OUT" build/aligned.apk
apksigner verify "build/$OUT"
echo
echo "built build/$OUT (versionCode $VERSION_CODE)"
echo "install with:  termux-open build/$OUT"
