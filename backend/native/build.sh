#!/bin/sh
set -e
cd "$(dirname "$0")"

swiftc -O ax.swift -o jarvis-ax
codesign --force --sign - --identifier com.jarvis.ax jarvis-ax

echo "built: $(pwd)/jarvis-ax"
./jarvis-ax trust
