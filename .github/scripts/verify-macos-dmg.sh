#!/usr/bin/env bash
# 发布前校验 macOS 产物：dmg 自身完好、能挂载、.app 确实签过名、二进制包含两个架构。
# 任何一项不过就让 CI 红掉，坏包不进 Release。
#
# 为什么需要这个脚本：v0.4.2 的 dmg 有两个问题，光看「构建成功」是发现不了的 ——
#   1. .app 完全没有签名（只有链接器自动给 arm64 二进制加的那份），
#      下载后被 Gatekeeper 判定为「已损坏，无法打开」；
#   2. 只打了 aarch64 切片，Intel Mac 上根本起不来。
set -euo pipefail

fail() { echo "::error::$*"; exit 1; }

DMG=$(find target -path '*/bundle/dmg/*.dmg' -type f | head -n 1)
[ -n "$DMG" ] || fail "没有找到 dmg 产物（预期在 target/**/bundle/dmg/ 下）"
echo "dmg：$DMG（$(du -h "$DMG" | cut -f 1)）"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -n 1)
[ -n "$VERSION" ] || fail "读不到 src-tauri/tauri.conf.json 里的 version"
case "$(basename "$DMG")" in
  *"$VERSION"*) ;;
  *) fail "dmg 文件名里没有版本号 $VERSION —— tag 与 tauri.conf.json 的版本对不上？" ;;
esac

hdiutil verify "$DMG" >/dev/null || fail "hdiutil verify 不通过：dmg 文件本身损坏"

MNT=$(mktemp -d)
unmount() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rmdir "$MNT" 2>/dev/null || true
}
trap unmount EXIT

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet || fail "dmg 挂载失败"
APP=$(find "$MNT" -maxdepth 1 -name '*.app' -type d | head -n 1)
[ -n "$APP" ] || fail "dmg 里没有 .app"
[ -L "$MNT/Applications" ] || fail "dmg 里缺少指向 /Applications 的符号链接（用户无法拖拽安装）"
echo "app：$(basename "$APP")"

[ -d "$APP/Contents/_CodeSignature" ] \
  || fail "bundle 未签名：缺少 Contents/_CodeSignature —— 下载后 macOS 会报「已损坏，无法打开」"
BIN="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
[ -x "$BIN" ] || fail "可执行文件不存在或不可执行：$BIN"

echo "--- 签名 ---"
codesign -dv --verbose=4 "$APP" 2>&1 \
  | grep -E '^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier|Sealed Resources)' || true
codesign --verify --deep --strict --verbose=2 "$APP" || fail "codesign --verify 不通过：签名无效或文件被改动"

echo "--- 架构 ---"
lipo -info "$BIN"
lipo -info "$BIN" | grep -q 'arm64'  || fail "缺少 arm64 切片：Apple Silicon 上无法运行"
lipo -info "$BIN" | grep -q 'x86_64' || fail "缺少 x86_64 切片：Intel Mac 上无法运行"

echo "--- Gatekeeper（未公证时 rejected 属预期，仅供参考）---"
spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true

echo "macOS 产物校验通过"
