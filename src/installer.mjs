import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { SERVER_NAME, VERSION, fail, isObject } from './constants.mjs';
import { atomicWrite, noSymlinks, ensureDir, readText, setMode } from './storage.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BEGIN = '# >>> jev-agent-control managed';
const END = '# <<< jev-agent-control managed';
const hash = s => createHash('sha256').update(s).digest('hex');
const sh = s => `'${s.replaceAll("'", "'\\''")}'`;
function sameJson(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}
function parseJson(text) {
  let value; try { value = JSON.parse(text); } catch { fail('INVALID_HOST_CONFIG'); }
  if (!isObject(value)) fail('INVALID_HOST_CONFIG'); return value;
}
function codexPatch(text, block, remove, recordedBlock) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if ((start === -1) !== (end === -1) || (start !== -1 && (end < start || text.indexOf(BEGIN, start + 1) !== -1 || text.indexOf(END, end + 1) !== -1))) fail('MANAGED_BLOCK_DAMAGED');
  if (start !== -1) {
    const current = text.slice(start, end + END.length);
    if (current !== block && current !== recordedBlock) fail('MANAGED_CONFIG_CHANGED');
    if (!remove) return text.slice(0, start) + block + text.slice(end + END.length);
    return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
  }
  if (remove) return text;
  // Refuse name collisions rather than parsing/reformatting unrelated TOML.
  if (text.includes(SERVER_NAME)) fail('SERVER_NAME_COLLISION');
  return text + (text && !text.endsWith('\n') ? '\n' : '') + block + '\n';
}
export function installationPlan({ home, env = process.env, target = 'both', scope = 'user', project = process.cwd(), remove = false, root = REPO_ROOT } = {}) {
  if (process.platform === 'win32') fail('USE_WSL');
  if (!['both', 'codex', 'claude'].includes(target) || !['user', 'project'].includes(scope)) fail('INVALID_INSTALL_OPTIONS');
  const userHome = fs.realpathSync(env.HOME || os.homedir());
  const projectRoot = fs.realpathSync(project);
  root = fs.realpathSync(root);
  const cli = path.join(root, 'bin/jev-control.mjs');
  if (!fs.existsSync(cli)) fail('RUNTIME_MISSING');
  const agents = target === 'both' ? ['codex', 'claude'] : [target];
  if (scope === 'user' && agents.includes('claude') && env.CLAUDE_CONFIG_DIR) fail('CUSTOM_CLAUDE_PROFILE_USE_PROJECT_SCOPE');
  const actions = [];
  const record = key => {
    const file = path.join(home, 'installations', `${hash(key)}.json`);
    const before = readText(file, { optional: true, privateFile: true });
    const data = before ? parseJson(before) : null;
    if (data && (data.owner !== 'jev-agent-control' || data.path !== key)) fail('INSTALL_RECORD_INVALID');
    return { file, before, value: data?.value };
  };
  const updateRecord = (r, key, value, deleting = remove) => add(r.file, deleting ? null : JSON.stringify({ owner: 'jev-agent-control', path: key, value }, null, 2) + '\n', r.before);
  const add = (file, next, before, mode = 0o600) => { if (next !== before) actions.push({ file, before, next, mode }); };
  const server = { command: process.execPath, args: [cli, 'mcp'], env: { JEV_HOME: home } };
  const block = [BEGIN, `[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`, 'env_vars = ["TYPESAFE_API_KEY", "JEV_DISABLE"]',
    'startup_timeout_sec = 10', 'tool_timeout_sec = 15', 'enabled = true',
    `[mcp_servers.${SERVER_NAME}.env]`, `JEV_HOME = ${JSON.stringify(home)}`, END].join('\n');
  for (const agent of agents) {
    let file;
    if (agent === 'codex') {
      const dir = scope === 'user' ? (env.CODEX_HOME || path.join(userHome, '.codex')) : path.join(projectRoot, '.codex');
      if (!path.isAbsolute(dir)) fail('CODEX_HOME_MUST_BE_ABSOLUTE');
      file = path.join(dir, 'config.toml');
      const before = readText(file, { optional: true });
      const owned = record(file);
      add(file, codexPatch(before || '', block, remove, owned.value) || null, before);
      updateRecord(owned, file, block);
    } else {
      file = scope === 'user' ? path.join(userHome, '.claude.json') : path.join(projectRoot, '.mcp.json');
      const before = readText(file, { optional: true });
      const json = before ? parseJson(before) : {};
      if (json.mcpServers !== undefined && !isObject(json.mcpServers)) fail('INVALID_HOST_CONFIG');
      const existing = json.mcpServers?.[SERVER_NAME];
      const owned = record(file);
      if (existing && !sameJson(existing, server) && !sameJson(existing, owned.value)) fail('SERVER_NAME_COLLISION');
      if (remove) {
        if (existing) { delete json.mcpServers[SERVER_NAME]; if (!Object.keys(json.mcpServers).length) delete json.mcpServers; }
        if (existing) add(file, Object.keys(json).length ? JSON.stringify(json, null, 2) + '\n' : null, before);
      } else if (!sameJson(existing, server)) {
        json.mcpServers = { ...(json.mcpServers || {}), [SERVER_NAME]: server };
        add(file, JSON.stringify(json, null, 2) + '\n', before);
      }
      updateRecord(owned, file, server);
    }
    const skillsDir = path.join(scope === 'user' ? userHome : projectRoot, agent === 'codex' ? '.agents/skills' : '.claude/skills');
    for (const skill of ['jev-control', 'jev-decisions']) {
      const dir = path.join(skillsDir, skill), markerPath = path.join(dir, '.jev-managed.json');
      const markerText = readText(markerPath, { optional: true });
      const marker = markerText ? parseJson(markerText) : null;
      if (marker && marker.owner !== 'jev-agent-control') fail('SKILL_COLLISION');
      const files = {
        'SKILL.md': readText(path.join(root, 'skills', skill, 'SKILL.md')),
        'scripts/run.mjs': `#!/usr/bin/env node\nprocess.env.JEV_HOME ??= ${JSON.stringify(home)};\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`,
      };
      for (const [name, next] of Object.entries(files)) {
        const destination = path.join(dir, name), before = readText(destination, { optional: true });
        if (before !== null && (!marker || marker.files?.[name] !== hash(before))) fail('SKILL_CHANGED_OR_COLLISION');
        add(destination, remove ? null : next, before);
      }
      const nextMarker = JSON.stringify({ owner: 'jev-agent-control', version: VERSION, files: Object.fromEntries(Object.entries(files).map(([n, s]) => [n, hash(s)])) }, null, 2) + '\n';
      add(markerPath, remove ? null : nextMarker, markerText);
    }
  }
  // User-scope shim is an optional convenience, not a shell startup-file modification.
  if (scope === 'user') {
    const shim = path.join(userHome, '.local/bin/jev-control');
    const before = readText(shim, { optional: true });
    const next = `#!/bin/sh\n# jev-agent-control managed\nif [ -z "\${JEV_HOME:-}" ]; then JEV_HOME=${sh(home)}; export JEV_HOME; fi\nexec ${sh(process.execPath)} ${sh(cli)} "$@"\n`;
    const owned = record(shim);
    if (before !== null && before !== next && before !== owned.value) fail('SHIM_CHANGED_OR_COLLISION');
    // A partial uninstall leaves the shared shim for the other agent.
    add(shim, remove && target === 'both' ? null : (remove ? before : next), before, 0o700);
    if (!remove || target === 'both') updateRecord(owned, shim, next);
  }
  return { home, target, scope, remove, agents, actions, runtime: cli };
}
export function applyInstallation(plan, { dryRun = false } = {}) {
  const report = { ok: true, dryRun, target: plan.target, scope: plan.scope, operation: plan.remove ? 'uninstall' : 'install',
    changes: plan.actions.map(a => ({ path: a.file, action: a.next === null ? 'remove-owned-file' : 'write' })),
    runtime: plan.runtime, typeSafeCredentialWritten: false, hostApprovalsChanged: false };
  if (dryRun) return report;
  ensureDir(plan.home, true);
  const lock = path.join(plan.home, 'install.lock'); noSymlinks(lock);
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail('INSTALL_LOCKED'); throw e; }
  const applied = [];
  try {
    const backupDir = path.join(plan.home, 'backups', randomUUID());
    for (const a of plan.actions) {
      if (readText(a.file, { optional: true }) !== a.before) fail('WRITE_CONFLICT');
      if (a.before !== null) atomicWrite(path.join(backupDir, `${hash(a.file)}.bak`), a.before);
    }
    if (plan.actions.some(a => a.before !== null)) {
      atomicWrite(path.join(backupDir, 'manifest.json'), JSON.stringify(plan.actions.filter(a => a.before !== null).map(a => ({ path: a.file, backup: `${hash(a.file)}.bak` })), null, 2) + '\n');
      report.backupDirectory = backupDir;
    }
    for (const a of plan.actions) {
      if (readText(a.file, { optional: true }) !== a.before) fail('WRITE_CONFLICT');
      if (a.next === null) { noSymlinks(a.file); fs.unlinkSync(a.file); }
      else atomicWrite(a.file, a.next, { expected: a.before, mode: a.mode });
      applied.push(a);
    }
    const config = path.join(plan.home, 'config.json');
    if (!plan.remove && readText(config, { optional: true }) === null) setMode(plan.home, 'off');
    if (plan.remove && plan.target === 'both') setMode(plan.home, 'off');
    return report;
  } catch (e) {
    // Roll back only files that still match our own write, never somebody else's concurrent edit.
    for (const a of applied.reverse()) {
      try {
        if (readText(a.file, { optional: true }) !== a.next) continue;
        if (a.before === null) { if (a.next !== null) fs.unlinkSync(a.file); }
        else atomicWrite(a.file, a.before, { expected: a.next });
      } catch { /* private backups remain available */ }
    }
    throw e;
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}
