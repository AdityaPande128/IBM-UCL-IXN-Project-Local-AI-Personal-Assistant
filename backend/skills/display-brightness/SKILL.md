---
name: display-brightness
version: 1.0.0
description: Sets the built-in display brightness to a specific level.
parameters:
  level:
    type: number
    required: true
    description: Brightness as a fraction from 0 (dimmest) to 1 (full).
    min: 0
    max: 1
    accepts_percent: true
    aliases: [brightness, brightness_level, value, percent]
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
      minimum: 0.05
exec:
  type: command
  argv: ["swift", "{{__dir__}}/brightness.swift", "{{level}}"]
reply: "Screen brightness set to {{level|percent}}."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Display Brightness

Sets the brightness of the built-in display. Takes a level between 0 and 1;
percentages and words like "low" or "max" are accepted and normalised.
