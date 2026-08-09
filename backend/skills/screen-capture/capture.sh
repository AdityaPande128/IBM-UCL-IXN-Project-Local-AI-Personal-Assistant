#!/bin/sh
target="$HOME/Desktop/screenshot_$(date +%s).png"
screencapture -x "$target"
printf %s "$target"
