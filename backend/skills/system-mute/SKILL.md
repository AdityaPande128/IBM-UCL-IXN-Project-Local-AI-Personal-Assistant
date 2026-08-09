---
name: system-mute
version: 1.0.0
description: Mutes or unmutes the system audio output without changing the volume level.
parameters:
  muted:
    type: boolean
    required: true
    description: True to mute the output, false to unmute it.
    aliases: [mute, state, enabled, silent]
exec:
  type: command
  argv: ["osascript", "-e", "set volume output muted {{muted}}"]
reply: "Audio mute set to {{muted}}."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# System Mute

Mutes or unmutes system audio without changing the volume level.
