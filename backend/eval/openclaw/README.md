# Jarvis as the browser inside OpenClaw

Evaluation infrastructure for the borrowed-browser arm: OpenClaw keeps its own
loop and model, but browses through Jarvis's execution lane instead of its own
browser tool, so a comparison isolates the agent architecture from browser
plumbing.

Three pieces:

- `jarvis-browse/run.js` — sends one goal to the Jarvis daemon's authenticated
  socket (`{type: "browse"}`) and prints the grounded answer. The daemon runs
  the goal through the same web policy, mandate rules and intent queue as its
  own runs; only the planning brain is the caller's.
- `jarvis-browse/SKILL.md.template` — the OpenClaw skill teaching its model to
  state whole tasks as goals. `%RUNNER%` is stamped at install time.
- `install.js [skills-dir]` — writes the skill into an OpenClaw workspace
  (default `~/.openclaw/workspace/skills`).

**Do not install this into the live workspace outside an evaluation arm.** A
native-OpenClaw run with jarvis-browse present is a contaminated baseline: its
model may pick the borrowed browser and the arm stops measuring OpenClaw. At
eval time the arm setup is: install jarvis-browse, disable `gmail-web` (its
instructions point at the native browser tool), run the arm, remove both
changes. Both steps are logged in the run sheet.
