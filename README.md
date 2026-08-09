# Jarvis

Privacy-first personal assistant for macOS. Mail, calendar, browsing, voice, and
generated skills run against local models; nothing leaves the machine.

- `backend/` — Node services, the skill engine and sandbox, and a Python MLX
  inference server
- `frontend/` — Tauri + React shell
- `ClawBenchmark/` — evaluation harness comparing Jarvis against OpenClaw
- `docs/` — design notes and measurements

This is the production codebase. It consolidates work validated during a
prototyping phase (July–August 2026); development proceeds by pull request with
required CI checks on a protected master.

## Running

Backend: `cd backend && npm ci && npm start`. Tests: `npm test`.

Frontend: `cd frontend && npm ci && npm run tauri dev`.

Inference server: `cd backend/inference && python3 server.py` (requires an
Apple-silicon Mac; models are configured in `config.json`).
