---
name: wifi-toggle
version: 1.0.0
description: Turns the Wi-Fi radio on or off.
parameters:
  state:
    type: enum
    required: true
    description: Whether Wi-Fi should be on or off.
    values: [on, off]
    aliases: [enabled, power, wifi, action]
    vocabulary:
      "true": on
      enable: on
      "false": off
      disable: off
exec:
  type: command
  argv: ["networksetup", "-setairportpower", "en0", "{{state}}"]
reply: "Wi-Fi turned {{state}}."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Wi-Fi Toggle

Turns the Wi-Fi radio on or off on the primary interface (en0).
