#!/bin/sh
# Install Fiber from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aakshintala/Fiber/main/install.sh | sh
#
# Environment:
#   FIBER_INSTALL_DIR  install directory (default: $HOME/.local/bin)
#
# POSIX sh. No bashisms.
set -eu

REPO="aakshintala/Fiber"
INSTALL_DIR="${FIBER_INSTALL_DIR:-$HOME/.local/bin}"
BASE="https://github.com/$REPO/releases/latest/download"

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
# get created as a side effect of the check. An existing install path or
# ancestor that is not a directory is rejected outright.
check_writable() {
    dir="$1"
    while [ ! -e "$dir" ]; do
        dir=$(dirname "$dir")
        if [ "$dir" = "/" ] || [ "$dir" = "." ]; then
            break
        fi
    done
    [ -d "$dir" ] || die "install path exists and is not a directory: $dir"
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
    *) die "unsupported platform: os=$OS arch=$ARCH (supported: linux-x86_64, linux-aarch64, macos-aarch64)" ;;
esac

case "$ARCH" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) die "unsupported platform: os=$OS arch=$ARCH (supported: linux-x86_64, linux-aarch64, macos-aarch64)" ;;
esac

PLATFORM="$os-$arch"
case "$PLATFORM" in
    macos-x86_64) die "unsupported platform: os=$OS arch=$ARCH (supported: linux-x86_64, linux-aarch64, macos-aarch64)" ;;
esac
ARCHIVE="fiber-$PLATFORM.tar.gz"

TMPDIR=$(mktemp -d) || die "could not create a temporary directory"
STAGE_TMP=""
cleanup() {
    rm -rf "$TMPDIR"
    if [ -n "$STAGE_TMP" ]; then
        rm -f "$STAGE_TMP"
    fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

curl -fsSL -o "$TMPDIR/$ARCHIVE" "$BASE/$ARCHIVE" \
    || die "no release found: could not download $BASE/$ARCHIVE"
curl -fsSL -o "$TMPDIR/$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256" \
    || die "missing checksum file: could not download $BASE/$ARCHIVE.sha256"

# Verify before anything is moved into place.
EXPECTED=$(cut -d' ' -f1 "$TMPDIR/$ARCHIVE.sha256")
if [ -z "$EXPECTED" ]; then
    die "missing checksum file: empty $ARCHIVE.sha256"
fi
# Capture the tool output first so set -e sees the checksum tool's own
# status; strip the filename field afterward instead of piping through cut.
if [ "$SHA256" = "sha256sum" ]; then
    ACTUAL_OUTPUT=$(sha256sum "$TMPDIR/$ARCHIVE") || die "could not checksum $ARCHIVE"
else
    ACTUAL_OUTPUT=$(shasum -a 256 "$TMPDIR/$ARCHIVE") || die "could not checksum $ARCHIVE"
fi
ACTUAL=${ACTUAL_OUTPUT%% *}
if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch for $ARCHIVE (expected $EXPECTED, got $ACTUAL); nothing was installed"
fi

tar -xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR" \
    || die "could not extract $ARCHIVE"
# -f follows symlinks, so reject symlinks explicitly: only a regular file
# may become the installed binary.
[ ! -L "$TMPDIR/fiber" ] \
    || die "archive $ARCHIVE does not contain a regular fiber binary; nothing was installed"
[ -f "$TMPDIR/fiber" ] \
    || die "archive $ARCHIVE does not contain a fiber binary"

mkdir -p "$INSTALL_DIR" || die "could not create install directory: $INSTALL_DIR"
# Failure-atomic placement: chmod and --version run against a temp name
# inside the destination directory, and the rename over the final binary
# is the last step. A failure before the rename leaves the previous binary
# (or nothing) in place, never the new one.
STAGE_TMP=$(mktemp "$INSTALL_DIR/.fiber.XXXXXX") || die "could not stage fiber into $INSTALL_DIR"
mv "$TMPDIR/fiber" "$STAGE_TMP" || die "could not stage fiber into $INSTALL_DIR"
chmod +x "$STAGE_TMP" || { rm -f "$STAGE_TMP"; STAGE_TMP=""; die "could not make staged fiber executable; nothing was installed"; }
"$STAGE_TMP" --version || { rm -f "$STAGE_TMP"; STAGE_TMP=""; die "staged fiber failed to run (--version); nothing was installed"; }
mv "$STAGE_TMP" "$INSTALL_DIR/fiber" || { rm -f "$STAGE_TMP"; STAGE_TMP=""; die "could not move fiber into $INSTALL_DIR"; }
STAGE_TMP=""

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
