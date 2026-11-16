# SPDX-License-Identifier: GPL-3.0-or-later
# Pinned Linux build environment for docs/REPRODUCIBLE.md: same Ubuntu release as the release
# workflow's ubuntu-22.04 runner, base image by digest, packages from a dated Ubuntu snapshot.
# Bump the digest, SNAPSHOT, NODE_VERSION and the pnpm version deliberately, in their own commit.
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11

ARG SNAPSHOT=20261101T000000Z
ARG NODE_VERSION=22.23.4
ARG PNPM_VERSION=11.0.9
ENV DEBIAN_FRONTEND=noninteractive

# snapshot.ubuntu.com only answers over https: ca-certificates comes first, from the image's mirror.
# It sometimes answers 503 under load: apt retries each download (does not change what is installed).
RUN printf 'Acquire::Retries "8";\nAcquire::Retries::Delay::Maximum "60";\n' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && printf 'deb https://snapshot.ubuntu.com/ubuntu/%s jammy main universe\ndeb https://snapshot.ubuntu.com/ubuntu/%s jammy-updates main universe\ndeb https://snapshot.ubuntu.com/ubuntu/%s jammy-security main universe\n' \
      "$SNAPSHOT" "$SNAPSHOT" "$SNAPSHOT" > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential curl file git patchelf pkg-config xz-utils \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
      libudev-dev libusb-1.0-0-dev \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
 && npm install -g "pnpm@${PNPM_VERSION}"

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
# The toolchain itself comes from the repository's rust-toolchain.toml at build time.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none

WORKDIR /src
