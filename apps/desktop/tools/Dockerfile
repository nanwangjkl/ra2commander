FROM node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libxrandr2 libxdamage1 libxfixes3 libxcomposite1 libx11-xcb1 libxtst6 \
    libnotify4 libsecret-1-0 xvfb xauth squashfs-tools desktop-file-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@9.4.0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_CACHE=/cache/electron ELECTRON_BUILDER_CACHE=/cache/electron-builder
COPY linux-build.sh /usr/local/bin/build-ra2commander
WORKDIR /work
