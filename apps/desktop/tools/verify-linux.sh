#!/bin/bash
set -euo pipefail
task_verify_dir=$(mktemp -d)
task_image="/artifacts/RA2Commander-${RA2C_VERIFY_VERSION}-linux-x86_64.AppImage"
node /source/apps/desktop/tools/extract-appimage.mjs "$task_image" "$task_verify_dir/image"
mkdir "$task_verify_dir/tar"
tar -xzf "/artifacts/RA2Commander-${RA2C_VERIFY_VERSION}-linux-x86_64.tar.gz" -C "$task_verify_dir/tar"
task_tar_root=$(find "$task_verify_dir/tar" -name ra2commander -type f -printf '%h\n' | head -n 1)
node /source/apps/desktop/tools/check-archives.mjs "$task_tar_root" "$task_verify_dir/image"
xvfb-run -a env ELECTRON_RUN_AS_NODE=1 RA2C_PACKAGED=1 RA2C_CHECK_APPIMAGE="$task_image" "$task_verify_dir/image/ra2commander" /source/apps/desktop/tools/check-package.mjs "$task_verify_dir/image"
export APPDIR="$task_verify_dir/image"
export APPIMAGE
APPIMAGE="$task_image"
export XDG_DATA_HOME="$task_verify_dir/xdg"
export RA2C_DATA_ROOT="$task_verify_dir/installer-data"
xvfb-run -a "$APPDIR/AppRun" --no-sandbox --install
cmp "$APPIMAGE" /root/Applications/RA2Commander/RA2Commander.AppImage
xvfb-run -a "$APPDIR/AppRun" --no-sandbox --uninstall
echo '[package] 实际 AppImage 与 tar.gz 内容、AppRun 安装入口均检查通过'
