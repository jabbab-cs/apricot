#!/usr/bin/env bash
# Apricot one-time setup for macOS and Linux (Windows: scripts/setup-windows.ps1).
#  - installs the Android SDK pieces Apricot needs (adb + emulator + a system image)
#  - creates a ready-to-use virtual phone ("Apricot_Phone")
#  - downloads scrcpy-server (screen streaming + input)
#  - installs the server's npm dependencies
# Safe to re-run: every step is skipped when already done.
set -euo pipefail

SCRCPY_VERSION="${APRICOT_SCRCPY_VERSION:-5.0.1}"
API_LEVEL="${APRICOT_API_LEVEL:-35}"
AVD_NAME="${APRICOT_AVD_NAME:-Apricot_Phone}"
AVD_DEVICE="${APRICOT_AVD_DEVICE:-pixel_7}"
REPO="https://dl.google.com/android/repository"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[38;5;209m▸\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }

case "$(uname -s)" in
  Darwin) OS=mac;   DEFAULT_SDK="$HOME/Library/Android/sdk" ;;
  Linux)  OS=linux; DEFAULT_SDK="$HOME/Android/Sdk" ;;
  *)      die "Unsupported OS. On Windows run: powershell -ExecutionPolicy Bypass -File scripts\\setup-windows.ps1" ;;
esac
export ANDROID_HOME="${ANDROID_HOME:-$DEFAULT_SDK}"

case "$(uname -m)" in
  arm64|aarch64) ABI="arm64-v8a" ;;
  *)             ABI="x86_64" ;;
esac
IMAGE="system-images;android-${API_LEVEL};google_apis;${ABI}"

bold ""
bold "  Apricot setup  ($OS, Android SDK: $ANDROID_HOME)"

# ---------- prerequisites ----------
step "Checking prerequisites"
command -v node >/dev/null || die "Node.js 20+ is required: https://nodejs.org (or your package manager)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 20+ is required (found $(node -v))"
ok "Node $(node -v)"
for tool in curl unzip; do
  command -v "$tool" >/dev/null || die "'$tool' is required. Install it with your package manager."
done

if [[ "$OS" == linux && "$ABI" == arm64-v8a ]]; then
  warn "Google doesn't ship the Android emulator for Linux on ARM."
  warn "Apricot still works with a real Android phone connected over USB (adb). Continuing without an emulator."
  NO_EMULATOR=1
else
  NO_EMULATOR=0
fi

has_java() { command -v java >/dev/null || /usr/libexec/java_home >/dev/null 2>&1; }
if has_java; then
  ok "Java available"
else
  warn "Installing a Java runtime (needed by the Android SDK tools)"
  if [[ "$OS" == mac ]]; then
    command -v brew >/dev/null || die "Install Java 17+ (https://adoptium.net) or Homebrew, then re-run."
    brew install --quiet openjdk@17
    JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
    export JAVA_HOME
    export PATH="$JAVA_HOME/bin:$PATH"
  elif command -v apt-get >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq openjdk-17-jre-headless
  elif command -v dnf >/dev/null; then sudo dnf install -y -q java-17-openjdk-headless
  elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm jre17-openjdk-headless
  else die "Install Java 17+ (https://adoptium.net), then re-run."
  fi
fi

# ---------- Android command-line tools ----------
step "Android SDK"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [[ ! -x "$SDKMANAGER" ]]; then
  # Google's own zip, installed inside $ANDROID_HOME so sdkmanager/avdmanager agree on the SDK root.
  ZIP="$(curl -fsSL "$REPO/repository2-3.xml" | grep -o "commandlinetools-$OS-[0-9]*_latest\.zip" | sort -t- -k3 -n | tail -1)"
  [[ -n "$ZIP" ]] || die "Couldn't find the Android command-line tools download."
  TMP="$(mktemp -d)"
  warn "Downloading $ZIP"
  curl -fL --progress-bar -o "$TMP/tools.zip" "$REPO/$ZIP"
  unzip -q "$TMP/tools.zip" -d "$TMP"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$TMP/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$TMP"
fi
yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true

PACKAGES=("platform-tools")
(( NO_EMULATOR )) || PACKAGES+=("emulator")
if [[ -x "$ANDROID_HOME/platform-tools/adb" ]] && { (( NO_EMULATOR )) || [[ -x "$ANDROID_HOME/emulator/emulator" ]]; }; then
  ok "Already installed: ${PACKAGES[*]}"
else
  "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "${PACKAGES[@]}"
  ok "Installed ${PACKAGES[*]}"
fi

# ---------- hardware acceleration ----------
if (( ! NO_EMULATOR )); then
  step "Hardware acceleration"
  if [[ "$OS" == linux ]]; then
    if [[ ! -e /dev/kvm ]]; then
      warn "/dev/kvm is missing: enable virtualization (VT-x/AMD-V) in your BIOS and install KVM:"
      warn "  sudo apt install qemu-kvm   # or your distro's equivalent"
    elif [[ ! -w /dev/kvm ]]; then
      warn "No permission for /dev/kvm. Run this, then log out and back in:"
      warn "  sudo usermod -aG kvm \$USER"
    else
      ok "KVM available"
    fi
  else
    ok "Hypervisor.framework (built into macOS)"
  fi
fi

# ---------- virtual phone ----------
if (( ! NO_EMULATOR )); then
  step "Virtual phone ($AVD_NAME)"
  EMULATOR="$ANDROID_HOME/emulator/emulator"
  AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
  if "$EMULATOR" -list-avds 2>/dev/null | grep -qx "$AVD_NAME"; then
    ok "$AVD_NAME already exists"
  elif "$EMULATOR" -list-avds 2>/dev/null | grep -q .; then
    ok "Using your existing virtual devices: $("$EMULATOR" -list-avds | tr '\n' ' ')"
  else
    warn "Downloading Android ${API_LEVEL} system image (~1.5 GB, one time)"
    "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "$IMAGE"
    echo "no" | "$AVDMANAGER" create avd --force --name "$AVD_NAME" --package "$IMAGE" --device "$AVD_DEVICE"
    CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
    if [[ -f "$CONFIG" ]]; then
      # Hardware keyboard, host GPU (needed for a smooth stream); no cameras or mic, modest RAM: it runs in the background
      for kv in "hw.keyboard=yes" "hw.gpu.enabled=yes" "hw.gpu.mode=host" "hw.ramSize=2048" \
                "hw.camera.back=none" "hw.camera.front=none" "hw.audioInput=no" "showDeviceFrame=no"; do
        key="${kv%%=*}"
        grep -v "^${key//./\\.}=" "$CONFIG" > "$CONFIG.tmp" || true
        mv "$CONFIG.tmp" "$CONFIG"
        echo "$kv" >> "$CONFIG"
      done
    fi
    ok "Created $AVD_NAME"
  fi
fi

# ---------- scrcpy-server ----------
step "scrcpy-server v$SCRCPY_VERSION"
VENDOR="$ROOT/server/vendor"
JAR="$VENDOR/scrcpy-server-v$SCRCPY_VERSION"
mkdir -p "$VENDOR"
if [[ -s "$JAR" ]]; then
  ok "Already downloaded"
else
  curl -fL --progress-bar -o "$JAR.part" \
    "https://github.com/Genymobile/scrcpy/releases/download/v$SCRCPY_VERSION/scrcpy-server-v$SCRCPY_VERSION"
  mv "$JAR.part" "$JAR"
  ok "Saved to server/vendor/"
fi

# ---------- server ----------
step "Server dependencies"
(cd "$ROOT/server" && npm install --silent)
ok "npm install done"

touch "$VENDOR/.setup-done"

bold ""
bold "  All set."
echo ""
