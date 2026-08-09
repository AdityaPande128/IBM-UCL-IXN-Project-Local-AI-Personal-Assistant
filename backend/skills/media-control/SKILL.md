---
name: media-control
version: 1.0.0
description: Controls media playback in the Music app - play, pause, next or previous track.
parameters:
  action:
    type: enum
    required: true
    description: The playback action to perform.
    values: [playpause, "next track", "previous track"]
    aliases: [command, control, state]
    vocabulary:
      play: playpause
      pause: playpause
      toggle: playpause
      next: "next track"
      skip: "next track"
      forward: "next track"
      previous: "previous track"
      back: "previous track"
      prev: "previous track"
exec:
  type: command
  argv: ["osascript", "-e", "tell application \"Music\" to {{action}}"]
reply: "Media control applied."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Media Control

Controls playback in the Music app.
