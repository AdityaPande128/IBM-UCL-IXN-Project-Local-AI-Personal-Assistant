#!/usr/bin/env node
// Installs the jarvis-skill-builder meta-skill into an OpenClaw workspace,
// stamping in the absolute builder path for this checkout. Run it again after
// moving the repo.
//
//   node backend/tools/install-builder.js [workspace-skills-dir]
//
// Defaults to ~/.openclaw/workspace/skills.

const fs = require('fs');
const os = require('os');
const path = require('path');

const skillsDir = process.argv[2]
    || path.join(os.homedir(), '.openclaw', 'workspace', 'skills');
const builder = path.join(__dirname, 'skill-build.js');

const target = path.join(skillsDir, 'jarvis-skill-builder');
fs.mkdirSync(target, { recursive: true });

const manifest = fs.readFileSync(
    path.join(__dirname, 'openclaw-builder', 'SKILL.md.template'), 'utf8')
    .split('%BUILDER%').join(builder);
fs.writeFileSync(path.join(target, 'SKILL.md'), manifest);

console.log(`installed jarvis-skill-builder into ${target}`);
console.log(`builder: ${builder}`);
