---
name: file-explore
version: 1.0.0
description: Lists the files in a directory, newest first, with sizes and modification dates.
parameters:
  path:
    type: string
    required: true
    description: The directory to list, for example "~/Desktop" or "~/Downloads".
    aliases: [directory, folder, target, dir, location]
exec:
  type: command
  argv: ["sh", "{{__dir__}}/list.sh", "{{path}}"]
  timeout_ms: 10000
reply: "Contents of {{path}}:"
capabilities:
  exec: true
  filesystem: ["~"]
  network: false
provenance:
  author: builtin
---

# File Explorer

Lists a directory's contents sorted by modification time, newest first.

## Note on scope

The `capabilities.filesystem` declaration above states the paths this skill is
permitted to reach. Declaration is not yet enforcement — the capability
sandbox arrives in Phase 3. Until then this scope is documentation of intent.
