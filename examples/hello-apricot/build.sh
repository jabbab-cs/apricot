#!/usr/bin/env bash
# Builds hello-apricot.apk with the raw Android build tools (no Gradle).
# Needs: build-tools + platforms;android-35 (sdkmanager), a JDK.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
PLATFORM="$ANDROID_HOME/platforms/$(ls "$ANDROID_HOME/platforms" | sort -V | tail -1)/android.jar"
OUT=build
KEYSTORE="$HOME/.android/debug.keystore"

rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/res"

# 1. resources + manifest
"$BT/aapt2" compile --dir res -o "$OUT/res/compiled.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$PLATFORM" --manifest AndroidManifest.xml \
  --java "$OUT/gen" "$OUT/res/compiled.zip" --auto-add-overlay

# 2. code
find src "$OUT/gen" -name '*.java' -print0 \
  | xargs -0 javac --release 11 -classpath "$PLATFORM" -d "$OUT/classes" 2>&1 | grep -v 'warning: \[options\]' || true
find "$OUT/classes" -name '*.class' -print0 | xargs -0 "$BT/d8" --min-api 24 --lib "$PLATFORM" --output "$OUT"
(cd "$OUT" && zip -q -u unsigned.apk classes.dex)

# 3. align + sign with the standard debug key
if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null
fi
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --out hello-apricot.apk "$OUT/aligned.apk"
rm -rf "$OUT" hello-apricot.apk.idsig
echo "Built $(pwd)/hello-apricot.apk ($(du -h hello-apricot.apk | cut -f1))"
