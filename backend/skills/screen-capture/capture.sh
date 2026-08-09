#!/bin/sh
target="$HOME/Desktop/screenshot_$(date +%s).png"
screencapture -x "$target"
if [ ! -s "$target" ]; then
    rm -f "$target"
    echo "macOS did not allow the capture. Grant Screen Recording permission to Jarvis in System Settings > Privacy & Security > Screen Recording, then try again." >&2
    exit 1
fi
printf 'JARVIS_RESULT {"files":["%s"]}\n' "$target"
