---
name: app-quit
version: 1.0.0
description: Quits a running macOS application by name. Covers quit, close, exit, stop, shut down and kill when they name an application rather than the machine.
parameters:
  app:
    type: string
    required: true
    description: The application's name, for example "Safari".
    aliases: [app_name, application, name, target]
exec:
  type: command
  argv: ["osascript", "-e", "on run argv", "-e", "tell application (item 1 of argv) to quit", "-e", "end run", "{{app}}"]
reply: "{{app}} closed."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Application Quit

Quits a running macOS application by name.
