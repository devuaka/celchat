#!/usr/bin/env bash
# Builds the CelChat iPhone app on a Mac and makes an unsigned .ipa (sign it while installing,
# e.g. with Sideloadly and a free Apple ID). Run from the project folder:
#   bash scripts/build-ipa.sh
# Needs: Xcode (App Store, opened once to finish installing) and Node.js 22 or newer (nodejs.org).
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$1"; exit 1; }

say "Checking tools"
command -v xcodebuild >/dev/null || fail "Xcode is not installed. Get it from the App Store, open it once, then run this again."
xcodebuild -version | head -1
if ! xcode-select -p | grep -q "Xcode.app"; then
  echo "Pointing the command line tools at Xcode (asks for your Mac password)..."
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
fi
command -v node >/dev/null || fail "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR is too old: install version 22 or newer from https://nodejs.org"
node -v

say "Installing packages (first time takes a minute)"
npm ci --ignore-scripts --no-audit --no-fund

say "Building the web app"
node scripts/build-variant.mjs serverless

say "Copying it into the iOS project"
npx cap sync ios

# the iPhone app must not mention other chat apps (App Store rules and the owner's wish)
if grep -rliE "discord|nitro" ios/App/App/public ios/App/App/Info.plist >/dev/null 2>&1; then
  grep -rliE "discord|nitro" ios/App/App/public ios/App/App/Info.plist
  fail "The app mentions Discord or Nitro in the files above. Remove that text before building for iPhone."
fi

VERSION=$(node -p "require('./package.json').version")
say "Building CelChat $VERSION for iPhone (a few minutes)"
rm -rf build-ios
xcodebuild \
  -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build-ios \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build > build-ios.log 2>&1 || { tail -40 build-ios.log; fail "Xcode build failed. Send build-ios.log to whoever gave you this."; }
APP=build-ios/Build/Products/Release-iphoneos/App.app
[ -d "$APP" ] || fail "The build finished but no app was produced. Send build-ios.log."

say "Packaging the .ipa"
rm -rf Payload
mkdir Payload
cp -R "$APP" Payload/CelChat.app
OUT="CelChat-iOS-$VERSION.ipa"
rm -f "$OUT"
zip -qry "$OUT" Payload
rm -rf Payload

say "Done: $(pwd)/$OUT ($(du -h "$OUT" | cut -f1))"
echo "Send that file to the iPhone owner. They install it with Sideloadly (see FOR-THE-MAC.md)."
open -R "$OUT" 2>/dev/null || true
