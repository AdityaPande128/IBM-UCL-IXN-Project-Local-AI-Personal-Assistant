# Skill Format v1

A skill is a **self-contained directory** under `backend/skills/`. It holds its
manifest, any assets it needs, and its verification test:

```
skills/display-brightness/
  SKILL.md          manifest + prose instructions (required)
  brightness.swift  assets owned by the skill (optional)
  test.json         verification cases (optional, required for generated skills)
```

`SKILL.md` keeps its Markdown-with-YAML-frontmatter shape so OpenClaw can still
read the prose body as a skill description. Everything the Jarvis runtime needs
lives in the frontmatter; everything the *model* needs lives in the body.

---

## Frontmatter schema

```yaml
name: display-brightness          # required, unique, kebab-case
version: 1.0.0                    # required, semver
description: >                    # required — this is what the router sees
  Sets the built-in display brightness.

parameters:                       # optional; omit for skills that take none
  level:
    type: number                  # number | string | boolean | enum
    required: true
    description: Brightness as a fraction from 0 (dim) to 1 (full).
    min: 0
    max: 1
    accepts_percent: true         # number: also accept 0-100 and /100 it
    aliases: [brightness, value]  # tolerated inbound names; canonical is the key
    vocabulary:                   # words the model may use instead of a number
      max: 1.0
      low: 0.2

exec:
  type: command                   # command | script
  argv: ["swift", "{{__dir__}}/brightness.swift", "{{level}}"]
  timeout_ms: 15000               # optional, default 15000

reply: "Screen brightness set to {{level|percent}}."

capabilities:                     # what this skill is permitted to touch
  exec: true                      # spawns a process
  filesystem: []                  # path globs it may read/write; [] = none
  network: false

provenance:
  author: builtin                 # builtin | generated
  # generated skills additionally carry:
  # generated_at, source_prompt, model, verified_at
```

### `exec.type`

- **`command`** — run `argv[0]` with `argv[1..]` via `execFile`. **No shell.**
  Parameters are substituted as discrete argv elements, so a value containing
  `;`, `$(...)`, backticks or newlines is passed through as literal text and
  cannot alter the command. This is the security property that replaces the
  old ad-hoc app-name regex.
- **`script`** — run an interpreter against a file in the skill directory.
  This is the target shape for generated skills; the sandbox in Phase 3
  constrains it.

### Substitution tokens

| Token | Expands to |
|---|---|
| `{{param}}` | the coerced value of that parameter |
| `{{__dir__}}` | absolute path of the skill's own directory |
| `{{param\|percent}}` | `reply` only — value formatted as a percentage |

A token referencing an undeclared parameter is a **load-time validation error**,
not a runtime surprise.

---

## Why parameters are typed

The router is a language model: asked for a brightness level it has returned
`level`, `brightness`, and `brightness_level` across runs. Rather than guessing
at aliases in the executor, the declared schema is **injected into the routing
prompt**, so the model is told the canonical names and types up front. `aliases`
and `vocabulary` remain as a tolerance layer, not the primary mechanism.

This is also what makes a generated skill callable: generation must emit a
parameter schema, and the registry rejects it if it doesn't.

---

## Declared vs enforced

For a skill with `provenance.author: generated`, `capabilities` is **enforced**
at execution time via a macOS `sandbox-exec` profile, not merely documented:

| | Status |
|---|---|
| writes | **Enforced.** Confined to a private scratch dir plus scopes derived from this invocation's path parameters. |
| network | **Enforced.** Denied unless declared; generated skills never declare it. |
| exec | **Enforced.** `exec: false` prevents spawning subprocesses. |
| self-modification | **Enforced.** A skill cannot write to its own directory, so it cannot widen its own capabilities. |
| reads | **Enforced for user data.** The whole home directory is denied, then re-allowed only for the skill's own directory, its scratch dir, and the scopes this invocation needs. Paths outside `$HOME` (system locations, `/tmp`) stay readable so the interpreter can start. Credential stores are denied last, so naming one as a parameter cannot expose it. |

Built-in skills (`author: builtin`) run unconfined by default: they are
developer-authored and reviewed, and several need system access no useful policy
could express (`networksetup`, `osascript`, `open`). Set
`security.enforce_capabilities` to `"always"` to confine them too, or `"never"`
to disable enforcement entirely.

**An over-broad declaration is not a capability.** Declaring `~`, `/`, `/tmp` or
similar is ignored with a warning — it would grant everything the user can
reach. Write scope then comes solely from the invocation's path parameters.

## Immutable manifest, mutable ledger

`SKILL.md` describes what a skill *is* and where it came from. It never records
how often it ran or how often it succeeded — that lives in the run ledger
(`skills/.ledger.json`), which is what the cold-vs-warm evaluation reads.

Keeping them apart means a skill's identity is stable and diffable, and a
regenerated skill can be compared against its predecessor.
