#!/bin/sh
# Install Fiber from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aakshintala/Fiber/main/install.sh | sh
#
# Environment:
#   FIBER_INSTALL_DIR  install directory (default: $HOME/.local/bin)
#   FIBER_VERSION      install a pinned release tag (default: latest release)
#
# POSIX sh. No bashisms.
set -eu

REPO="aakshintala/Fiber"
INSTALL_DIR="${FIBER_INSTALL_DIR:-$HOME/.local/bin}"
# Test hook: base URL for release downloads. Defaults to GitHub Releases.
# A pinned FIBER_VERSION downloads from $BASE/$FIBER_VERSION/..., otherwise
# from the moving "latest" URL, so a local file:// or http:// base can serve
# as a draft release for verification.
DOWNLOAD_BASE="${FIBER_DOWNLOAD_BASE_URL:-https://github.com/$REPO/releases}"

die() {
    echo "install.sh: error: $1" >&2
    exit 1
}

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

need_cmd curl
need_cmd tar
if command -v sha256sum >/dev/null 2>&1; then
    SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA256="shasum -a 256"
else
    die "required command not found: sha256sum or shasum"
fi

# Fail before any download when the install directory cannot be written.
# Walk up to the nearest existing ancestor so a missing directory does not
# get created as a side effect of the check.
check_writable() {
    dir="$1"
    while [ ! -e "$dir" ]; do
        dir=$(dirname "$dir")
        if [ "$dir" = "/" ] || [ "$dir" = "." ]; then
            break
        fi
    done
    [ -w "$dir" ] || die "install directory is not writable: $1"
}

case "$INSTALL_DIR" in
    ""|*".."* ) die "refusing to install into: ${INSTALL_DIR:-<empty>}" ;;
esac
check_writable "$INSTALL_DIR"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
    Linux) os="linux" ;;
    Darwin) os="macos" ;;
    *) die "unsupported platform: os=$OS arch=$ARCH (supported: Linux or macOS on x86_64 or arm64)" ;;
esac

case "$ARCH" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) die "unsupported platform: os=$OS arch=$ARCH (supported: Linux or macOS on x86_64 or arm64)" ;;
esac

PLATFORM="$os-$arch"
ARCHIVE="fiber-$PLATFORM.tar.gz"

if [ -n "${FIBER_VERSION:-}" ]; then
    BASE="$DOWNLOAD_BASE/download/$FIBER_VERSION"
else
    BASE="$DOWNLOAD_BASE/latest/download"
fi

TMPDIR=$(mktemp -d) || die "could not create a temporary directory"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

curl -fsSL -o "$TMPDIR/$ARCHIVE" "$BASE/$ARCHIVE" \
    || die "no release found: could not download $BASE/$ARCHIVE"
curl -fsSL -o "$TMPDIR/$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256" \
    || die "missing checksum file: could not download $BASE/$ARCHIVE.sha256"

# Verify before anything is moved into place.
EXPECTED=$(cut -d' ' -f1 "$TMPDIR/$ARCHIVE.sha256")
if [ -z "$EXPECTED" ]; then
    die "missing checksum file: empty $ARCHIVE.sha256"
fi
if [ "$SHA256" = "sha256sum" ]; then
    ACTUAL=$(sha256sum "$TMPDIR/$ARCHIVE" | cut -d' ' -f1)
else
    ACTUAL=$(shasum -a 256 "$TMPDIR/$ARCHIVE" | cut -d' ' -f1)
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch for $ARCHIVE (expected $EXPECTED, got $ACTUAL); nothing was installed"
fi

tar -xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR" \
    || die "could not extract $ARCHIVE"
[ -x "$TMPDIR/fiber" ] || [ -f "$TMPDIR/fiber" ] \
    || die "archive $ARCHIVE does not contain a fiber binary"

mkdir -p "$INSTALL_DIR" || die "could not create install directory: $INSTALL_DIR"
mv "$TMPDIR/fiber" "$INSTALL_DIR/fiber" \
    || die "could not move fiber into $INSTALL_DIR"
chmod +x "$INSTALL_DIR/fiber"

trap - EXIT INT TERM
rm -rf "$TMPDIR"

"$INSTALL_DIR/fiber" --version

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        echo "warning: $INSTALL_DIR is not on PATH." >&2
        echo "warning: add this line to your shell profile:" >&2
        echo "warning:   export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
        ;;
esac
