#!/usr/bin/env node
// Installs the jarvis-browse skill into an OpenClaw workspace, stamping in the
// absolute runner path for this checkout. Run it again after moving the repo.
//
//   node backend/eval/openclaw/install.js [workspace-skills-dir]
//
// Defaults to ~/.openclaw/workspace/skills.

const fs = require('fs');
const os = require('os');
const path = require('path');

const skillsDir = process.argv[2]
    || path.join(os.homedir(), '.openclaw', 'workspace', 'skills');
const source = path.join(__dirname, 'jarvis-browse');
const runner = path.join(source, 'run.js');

const target = path.join(skillsDir, 'jarvis-browse');
fs.mkdirSync(target, { recursive: true });

const manifest = fs.readFileSync(path.join(source, 'SKILL.md.template'), 'utf8')
    .split('%RUNNER%').join(runner);
fs.writeFileSync(path.join(target, 'SKILL.md'), manifest);

console.log(`installed jarvis-browse into ${target}`);
console.log(`runner: ${runner}`);
