# The Linux side of `bun run ci:local --linux`: CI's `ubuntu-24.04-arm` jobs,
# replayed in a container on any machine with Docker (or OrbStack, Colima,
# Podman). See the docblock in scripts/ci-local.mjs.
#
# Built for the host's architecture, never emulated: on arm64 that is CI's
# arch; on x86-64 it is the arch release-linux.yml ships, which no CI job
# tests. ci-local passes the three versions in from rust-toolchain.toml and
# mise.toml and tags the image by them, so a pin change builds a new image
# rather than drifting from CI.
#
# Closer to CI than any other local run, but not identical: GitHub's runner is
# a VM with a large preinstalled image, and this is plain ubuntu:24.04 plus
# what the Linux jobs are known to need.
FROM ubuntu:24.04

ARG RUST_VERSION
# rust-toolchain.toml's `targets`, space-separated. Installed here because the
# toolchain is read-only at run time, so rustup cannot add them on first use.
ARG RUST_TARGETS
ARG BUN_VERSION
ARG NODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The -sys crates in Cargo.lock that the Linux jobs compile: openssl-sys,
# aws-lc-sys (cmake, clang), libdbus-sys, libsqlite3-sys. The GTK/WebKit
# headers are for the `app-linux` job, which installs the same list. bubblewrap
# is the engine's Linux sandbox; CI installs it for `sandbox: true` crates.
# ci-local skips both jobs' `sudo apt-get` steps because they are already here.
# Any mirror of ubuntu-ports (arm64) or ubuntu (x86-64) can stand in for the
# official one, which can be slow far from it; ci-local passes
# ATLAS_CI_APT_MIRROR through. An http:// URL: this layer runs before
# ca-certificates is installed, and apt verifies packages by the signed
# Release file, not the transport. It is not part of the image tag: whichever
# mirror serves them, the packages are the same.
ARG APT_MIRROR
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#^URIs: .*#URIs: $APT_MIRROR#" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      build-essential pkg-config cmake clang perl python3 \
      libssl-dev libdbus-1-dev libsqlite3-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libglib2.0-dev \
      git curl ca-certificates unzip xz-utils procps \
      bubblewrap \
 && rm -rf /var/lib/apt/lists/*

# Read-only at run time: the steps run as the host user, and the cargo
# registry and target dir live in volumes (CARGO_HOME is set per run).
RUN curl -sSf https://sh.rustup.rs | CARGO_HOME=/opt/cargo sh -s -- -y -q \
      --no-modify-path --profile minimal \
      --default-toolchain "$RUST_VERSION" -c clippy -c rustfmt \
      $(for t in $RUST_TARGETS; do printf -- '-t %s ' "$t"; done) \
 && chmod -R a+rX /opt/rustup /opt/cargo

# For scripts/target-gc.sh, which ci:local runs on the cache volume's target dir
# before each run. Pinned, since the image is rebuilt only on a pin change.
RUN CARGO_HOME=/opt/cargo cargo install --locked --quiet cargo-sweep --version 0.8.0 \
 && rm -rf /opt/cargo/registry /opt/cargo/git \
 && chmod -R a+rX /opt/cargo

# Bun and Node through mise, as CI's jdx/mise-action does, so "node = 24"
# resolves the same way. Only the binaries are kept on PATH.
RUN curl -sSf https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && MISE_DATA_DIR=/opt/mise mise install -y "bun@$BUN_VERSION" "node@$NODE_VERSION" \
 && ln -s "$(MISE_DATA_DIR=/opt/mise mise where "bun@$BUN_VERSION")"/bin/* /usr/local/bin/ \
 && ln -s "$(MISE_DATA_DIR=/opt/mise mise where "node@$NODE_VERSION")"/bin/* /usr/local/bin/ \
 && chmod -R a+rX /opt/mise \
 && bun --version && node --version

# The checkout is bind-mounted and owned by the host user, not by whoever git
# sees inside; without this every git call refuses the repository.
RUN git config --system safe.directory '*'

COPY entrypoint.sh /usr/local/bin/ci-linux-entrypoint
ENTRYPOINT ["/usr/local/bin/ci-linux-entrypoint"]
