---
name: bluetooth-toggle
version: 1.0.0
description: Turns Bluetooth on or off. Requires the blueutil tool.
parameters:
  state:
    type: enum
    required: true
    description: Whether Bluetooth should be on or off.
    values: ["1", "0"]
    aliases: [enabled, power, bluetooth, action]
    vocabulary:
      on: "1"
      "true": "1"
      enable: "1"
      off: "0"
      "false": "0"
      disable: "0"
exec:
  type: command
  argv: ["blueutil", "--power", "{{state}}"]
reply: "Bluetooth setting applied."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Bluetooth Toggle

Turns Bluetooth on or off. Depends on `blueutil` being installed.
