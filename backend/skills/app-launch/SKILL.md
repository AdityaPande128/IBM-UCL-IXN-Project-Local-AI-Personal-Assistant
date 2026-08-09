---
name: app-launch
version: 1.0.0
description: Launches a macOS application by name.
parameters:
  app:
    type: string
    required: true
    description: The application's name, for example "Safari" or "Visual Studio Code".
    aliases: [app_name, application, name, target]
exec:
  type: command
  argv: ["open", "-a", "{{app}}"]
reply: "{{app}} opened."
capabilities:
  exec: true
  filesystem: []
  network: false
provenance:
  author: builtin
---

# Application Launcher

Launches a macOS application by name. The name is passed as a discrete argument,
so it cannot inject additional shell commands.
