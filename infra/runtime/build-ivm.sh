#!/usr/bin/env bash
# Build isolated-vm 5.0.4 for SCF Nodejs18.15 (glibc 2.28, linux x64). The npm prebuilt needs glibc 2.30 and
# fails to load on SCF ("GLIBC_2.29 not found", funx-ivm-test 2026-10-10). Debian buster = glibc 2.28, gcc 8.
# Output: vendor/isolated-vm-node18-glibc228/ (JS + out/isolated_vm.node, debug symbols stripped).
set -euo pipefail
C=${CHROOT:-/opt/buster-build}; REPO=$(cd "$(dirname "$0")/../.." && pwd); T=$(mktemp -d)
[ -d "$C/usr" ] || sudo debootstrap --no-check-gpg --variant=minbase --include=g++,make,python3,ca-certificates buster "$C" https://archive.debian.org/debian
[ -d "$C/opt/node-v18.15.0-linux-x64" ] || { curl -sSfL https://nodejs.org/dist/v18.15.0/node-v18.15.0-linux-x64.tar.gz | sudo tar xz -C "$C/opt"; }
(cd "$T" && npm pack isolated-vm@5.0.4 >/dev/null) && sudo mkdir -p "$C/build" && sudo cp "$T"/isolated-vm-5.0.4.tgz "$C/build/" && sudo cp /etc/resolv.conf "$C/etc/resolv.conf"
sudo chroot "$C" /bin/bash -c 'set -e; export PATH=/opt/node-v18.15.0-linux-x64/bin:$PATH HOME=/build; cd /build && rm -rf pkg && mkdir pkg && cd pkg && echo "{\"private\":true}" > package.json && npm install --build-from-source --no-audit --no-fund ../isolated-vm-5.0.4.tgz'
V="$REPO/vendor/isolated-vm-node18-glibc228"; P="$C/build/pkg/node_modules/isolated-vm"
mkdir -p "$V/out" && cp "$P"/{isolated-vm.js,package.json,LICENSE,isolated-vm.d.ts} "$V/" && cp "$P/out/isolated_vm.node" "$V/out/"
strip --strip-debug "$V/out/isolated_vm.node" && (cd "$V" && sha256sum out/isolated_vm.node > SHA256SUMS)
objdump -T "$V/out/isolated_vm.node" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1   # must be <= GLIBC_2.28
rm -rf "$T"
