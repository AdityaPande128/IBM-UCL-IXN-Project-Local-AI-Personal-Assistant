---
name: system-volume
version: 1.0.0
description: Sets the system output volume to a specific level.
parameters:
  level:
    type: number
    required: true
    description: Output volume as a fraction from 0 (silent) to 1 (loudest).
    min: 0
    max: 1
    accepts_percent: true
    aliases: [volume, volume_level, value, percent]
    vocabulary:
      max: 1.0
      maximum: 1.0
      full: 1.0
      high: 0.8
      up: 0.8
      medium: 0.5
      half: 0.5
      low: 0.2
      down: 0.2
      min: 0.05
      mute: 0.0
      silent: 0.0
exec:
  type: command
  argv: ["osascript", "-e", "set volume output volume {{level|percent_number}}"]
reply: "Volume set to {{level|percent}}."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# System Volume

Sets the system output volume. Accepts a fraction, a percentage, or words
like "half" and "max".
