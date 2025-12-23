#!/bin/bash

# Exit on error
set -e

# Detect Architecture
ARCH=$(uname -m)
if [ "$ARCH" == "x86_64" ]; then
    TARGET_TRIPLE="x86_64-apple-darwin"
elif [ "$ARCH" == "arm64" ]; then
    TARGET_TRIPLE="aarch64-apple-darwin"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

echo "Detected architecture: $ARCH"
echo "Target triple: $TARGET_TRIPLE"

# Define paths
BACKEND_DIR="../backend"
BINARIES_DIR="src-tauri"
OUTPUT_BINARY="$BINARIES_DIR/horcrux-backend-$TARGET_TRIPLE"

# Create binaries directory
mkdir -p "$BINARIES_DIR"

# Build Go backend
echo "Building Go backend..."
cd "$BACKEND_DIR"
go build -o "../frontend/$OUTPUT_BINARY" .

cd "../frontend/$BINARIES_DIR"
ln -sf "horcrux-backend-$TARGET_TRIPLE" "horcrux-backend"

echo "Build complete: $OUTPUT_BINARY"
