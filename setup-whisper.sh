#!/usr/bin/env sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$ROOT_DIR/whisper.cpp"
REPO_URL="https://github.com/ggerganov/whisper.cpp.git"
MODEL_NAME="${1:-base}"

usage() {
  echo "Usage: $0 [model]"
  echo "Example: $0 base"
}

if [ -d "$TARGET_DIR" ]; then
  echo "whisper.cpp already exists at $TARGET_DIR"
else
  git clone "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"

if command -v cmake >/dev/null 2>&1; then
  :
else
  echo "cmake is required. Install it first (e.g. 'brew install cmake')."
  exit 1
fi

if [ -f "$TARGET_DIR/build/CMakeCache.txt" ]; then
  if ! grep -q "$TARGET_DIR" "$TARGET_DIR/build/CMakeCache.txt"; then
    echo "CMake cache points to a different path. Removing old build directory."
    rm -rf "$TARGET_DIR/build"
  fi
fi

make -j

if [ -x "$TARGET_DIR/models/download-ggml-model.sh" ]; then
  if ! sh "$TARGET_DIR/models/download-ggml-model.sh" "$MODEL_NAME" "$TARGET_DIR/models"; then
    echo "\nModel name invalid. Available models:"
    sh "$TARGET_DIR/models/download-ggml-model.sh" 2>/dev/null || true
    usage
    exit 1
  fi
else
  echo "Model download script not found at $TARGET_DIR/models/download-ggml-model.sh"
  exit 1
fi

echo "Build complete. Binaries are in $TARGET_DIR/bin"
