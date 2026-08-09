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

ls -lhtA "$target" | tail -n +2 | head -50
