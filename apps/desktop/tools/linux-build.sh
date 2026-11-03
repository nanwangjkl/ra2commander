#!/bin/bash
set -euo pipefail
export npm_config_store_dir=/cache/pnpm
for item in apps packages prompts skills maps resources tests package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json LICENSE; do
  cp -R "/source/$item" /work/
done
pnpm install --frozen-lockfile --store-dir /cache/pnpm
pnpm typecheck
node apps/desktop/tools/check-launcher.mjs
node --import tsx --test --test-concurrency=1 tests/desktop-install.test.ts tests/desktop-build.test.ts tests/workbench-exit.test.ts tests/game-defaults.test.ts tests/game-resources.test.ts tests/speech-model.test.ts tests/model-settings.test.ts
pnpm build
pnpm exec electron-builder --config apps/desktop/electron-builder.cjs --linux --x64 --dir --publish never
task_check_dir=$(mktemp -d)
mv dist/linux-unpacked "$task_check_dir/app"
xvfb-run -a env ELECTRON_RUN_AS_NODE=1 RA2C_PACKAGED=1 "$task_check_dir/app/ra2commander" /work/apps/desktop/tools/check-package.mjs "$task_check_dir/app"
mv "$task_check_dir/app" dist/linux-unpacked
rmdir "$task_check_dir"
pnpm exec electron-builder --config apps/desktop/electron-builder.cjs --prepackaged dist/linux-unpacked --linux --x64 --publish never
task_archive_dir=$(mktemp -d)
node apps/desktop/tools/extract-appimage.mjs /work/dist/RA2Commander-*-linux-x86_64.AppImage "$task_archive_dir/squashfs-root"
mkdir "$task_archive_dir/tar"
tar -xzf dist/RA2Commander-*-linux-x86_64.tar.gz -C "$task_archive_dir/tar"
task_tar_root=$(find "$task_archive_dir/tar" -name ra2commander -type f -printf '%h\n' | head -n 1)
node apps/desktop/tools/check-archives.mjs dist/linux-unpacked "$task_archive_dir/squashfs-root" "$task_tar_root"
rm -rf "$task_archive_dir"
for item in dist/*.AppImage dist/*.tar.gz; do
  cp "$item" /output/
done
(
  cd /output
  shopt -s nullglob
  sha256sum ./*.AppImage ./*.tar.gz ./*.zip > SHA256SUMS
)
