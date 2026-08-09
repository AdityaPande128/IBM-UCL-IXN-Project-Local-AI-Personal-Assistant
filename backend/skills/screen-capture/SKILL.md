---
name: screen-capture
version: 1.0.0
description: Takes a screenshot of the whole screen and saves it to the Desktop.
exec:
  type: script
  argv: ["sh", "{{__dir__}}/capture.sh"]
reply: "Screenshot saved to"
capabilities:
  exec: true
  filesystem: ["~/Desktop"]
  network: false
provenance:
  author: builtin
---

# Screen Capture

Captures the full screen to a timestamped PNG on the Desktop and reports the path.
