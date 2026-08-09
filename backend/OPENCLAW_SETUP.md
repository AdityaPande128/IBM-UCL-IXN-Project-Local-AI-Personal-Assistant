# OpenClaw Setup Instructions for Personal JARVIS

This document provides step-by-step instructions to connect OpenClaw to the Jarvis backend application.

## Prerequisites

- macOS (Apple Silicon recommended)
- Node.js v22.19+ or v24+
- An AI provider API key (Anthropic, OpenAI, or Google) OR a local model server (IBM Granite 4.1 8B via MLX)

## Step 1: Install OpenClaw CLI

OpenClaw is automatically installed when you run `npm install` in the backend directory, via the `postinstall` script. If it was not installed, run manually:

```bash
npm install -g openclaw@latest
```

Verify installation:

```bash
openclaw --version
```

## Step 2: Run Onboarding

Initialize your OpenClaw workspace and daemon:

```bash
openclaw onboard --install-daemon
```

This will:
- Create the `~/.openclaw/` workspace directory
- Set up the gateway daemon
- Prompt you to configure your AI model provider

## Step 3: Configure the AI Model

### Option A: Local Model (IBM Granite via MLX)

If you are running IBM Granite 4.1 8B locally via MLX, configure OpenClaw to point to your local model server:

```bash
openclaw configure --section agents.defaults.model
```

Select "Custom Provider" and enter:
- Base URL: `http://127.0.0.1:8888/v1`
- Model ID: `ibm-granite-4.1-8b`

### Option B: Cloud Provider

If using a cloud provider (Anthropic, OpenAI, Google), follow the prompts during `openclaw onboard` to enter your API key.

## Step 4: Grant macOS Permissions

When you first launch the OpenClaw macOS companion app (if using it), you will be prompted for:
- Accessibility permissions
- Screen Recording permissions
- Microphone permissions

These are required for system-level actions like screen capture, media control, and volume adjustment.

## Step 5: Register Skills

The Jarvis skills are located in `./skills/` within this project. OpenClaw discovers them automatically via the `openclaw.json` configuration.

Verify skills are loaded:

```bash
openclaw skills list
```

You should see 9 skills: system-volume, display-brightness, app-launch, app-quit, screen-capture-ocr, wifi-toggle, bluetooth-toggle, media-control, file-explore.

## Step 6: Start the Daemon

Start the OpenClaw gateway daemon:

```bash
openclaw daemon start
```

The gateway listens on `ws://localhost:18789` by default. The Jarvis backend connects to this address automatically on boot.

## Step 7: Start Jarvis Backend

```bash
npm start
```

The backend will:
1. Verify the ~/Jarvis_Sandbox directory exists
2. Connect to the OpenClaw gateway
3. Start the WebSocket server on ws://localhost:8080

## Step 8: Verify Connection

Send a status check via WebSocket:

```json
{ "type": "status" }
```

The response will indicate whether OpenClaw is connected.

## Step 9: Test an Intent

Send an intent via WebSocket:

```json
{ "type": "intent", "text": "set volume to 50" }
```

If OpenClaw is connected and the skill is registered, the agent will execute the appropriate system command.

## Troubleshooting

### OpenClaw daemon not starting
```bash
openclaw doctor --fix
```

### Skills not appearing
Ensure `openclaw.json` has the correct skills directory path and restart the daemon:
```bash
openclaw daemon restart
```

### Connection refused on ws://localhost:18789
The OpenClaw daemon may not be running. Start it with:
```bash
openclaw daemon start
```

### macOS permission issues
Open System Settings > Privacy & Security and manually grant the required permissions to the OpenClaw app and your terminal emulator.
