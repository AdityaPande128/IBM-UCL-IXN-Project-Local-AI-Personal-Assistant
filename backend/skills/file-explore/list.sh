#!/bin/sh
target="$1"
case "$target" in
  "~") target="$HOME" ;;
  "~/"*) target="$HOME/${target#\~/}" ;;
esac

if [ ! -d "$target" ]; then
  echo "Not a directory: $target" >&2
  exit 1
fi

files=$(find "$target" -mindepth 1 -maxdepth 1 -type f ! -name '.*' | wc -l | tr -d ' ')
folders=$(find "$target" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d ' ')
hidden=$(find "$target" -mindepth 1 -maxdepth 1 -name '.*' | wc -l | tr -d ' ')
echo "$((files + folders)) items: $files files and $folders folders (plus $hidden hidden)"
ls -lhtA "$target" | tail -n +2 | head -50
