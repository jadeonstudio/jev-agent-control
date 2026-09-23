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
const BLOCK_BEGIN = '<!-- >>> jev-agent-control managed -->';
const BLOCK_END = '<!-- <<< jev-agent-control managed -->';
const HOOK_TIMEOUT_SEC = 10;
// Owned host hooks (AGENTS.md "Owned host hooks"): only these event groups are ever added/removed,
// always appended at the end of the host's existing array for that event, never reordering others.
const HOOK_EVENTS_BY_HOST = Object.freeze({
  claude: [
    { key: 'PreToolUse', event: 'pre-spawn', matcher: 'Agent' },
    { key: 'PostToolUse', event: 'post-spawn', matcher: 'Agent' },
    { key: 'SubagentStop', event: 'subagent-stop' },
  ],
  codex: [
    { key: 'PreToolUse', event: 'pre-spawn', matcher: 'Agent' },
    { key: 'SubagentStart', event: 'subagent-start' },
    { key: 'SubagentStop', event: 'subagent-stop' },
  ],
});
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
// Same shape as codexPatch, but for Markdown instruction files (CLAUDE.md / AGENTS.md) where the
// managed block is appended after one blank line, so removal must drop exactly that blank line too.
function mdPatch(text, block, remove, recordedBlock) {
  const start = text.indexOf(BLOCK_BEGIN), end = text.indexOf(BLOCK_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && (end < start || text.indexOf(BLOCK_BEGIN, start + 1) !== -1 || text.indexOf(BLOCK_END, end + 1) !== -1))) fail('MANAGED_BLOCK_DAMAGED');
  if (start !== -1) {
    const current = text.slice(start, end + BLOCK_END.length);
    if (current !== block && current !== recordedBlock) fail('MANAGED_CONFIG_CHANGED');
    if (!remove) return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
    let head = text.slice(0, start), tail = text.slice(end + BLOCK_END.length);
    if (head.endsWith('\n\n')) head = head.slice(0, -1);
    if (tail.startsWith('\n')) tail = tail.slice(1);
    return head + tail;
  }
  if (remove) return text;
  if (!text) return block + '\n';
  return text + (text.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
}
/** The one short managed instruction block the installer may append to a host's global instruction file. */
export function instructionBlock(host) {
  const roleHint = host === 'codex'
    ? 'Codex 예: lightweight_worker/implementer/specialist/scout'
    : 'Claude 예: lightweight-worker/implementer/specialist/scout';
  return [BLOCK_BEGIN,
    '## jev-agent-control (설치기 관리 블록)',
    '- 작업자 역할(economy/standard/strong/scout)로 서브에이전트를 띄울 때 프롬프트 첫 줄에 `[jev scope=<local|cross-module|repository|unknown> complete=<yes|no> failures=<n>]`를 사실대로 적는다. 모르면 scope=unknown, complete=no. 이 줄이 있어야 hook이 역할·모델을 판단한다. (' + roleHint + ')',
    '- 역할·모델 판단은 hook이 자동으로 처리한다. 사용자가 모델을 지정했으면 그대로 둔다.',
    '- 좁은 선택·재시도·에스컬레이션 판단은 `jev_decide`를 쓰고 `apply=true`일 때만 따른다. 가능하면 trace(task_id, snapshot_id)를 넘긴다.',
    BLOCK_END].join('\n');
}
function hookCommand(cli, host, event, home) {
  return `${sh(process.execPath)} ${sh(cli)} hook --host ${sh(host)} --event ${sh(event)} --home ${sh(home)}`;
}
function hookGroup(def, cli, host, home) {
  const entry = { type: 'command', command: hookCommand(cli, host, def.event, home), timeout: HOOK_TIMEOUT_SEC };
  return def.matcher ? { matcher: def.matcher, hooks: [entry] } : { hooks: [entry] };
}
function hookFileFor(host, scope, userHome, projectRoot, env) {
  const dir = host === 'codex'
    ? (scope === 'user' ? (env.CODEX_HOME || path.join(userHome, '.codex')) : path.join(projectRoot, '.codex'))
    : (scope === 'user' ? path.join(userHome, '.claude') : path.join(projectRoot, '.claude'));
  return path.join(dir, host === 'codex' ? 'hooks.json' : 'settings.json');
}
function blockFileFor(host, userHome, env) {
  return host === 'codex' ? path.join(env.CODEX_HOME || path.join(userHome, '.codex'), 'AGENTS.md') : path.join(userHome, '.claude', 'CLAUDE.md');
}
/** Best-effort, non-parsing check for a Codex `[hooks.state]` trust entry naming our hooks.json path. No TOML parser exists here (see AGENTS.md/SECURITY.md: zero runtime deps), so this never reports content, only presence. */
export function codexTrustStatus(configText, hooksFile) {
  if (!configText) return 'trust-entry-absent';
  const idx = configText.indexOf('[hooks.state]');
  if (idx === -1) return 'trust-entry-absent';
  const nextHeader = configText.indexOf('\n[', idx + 1);
  const section = configText.slice(idx, nextHeader === -1 ? undefined : nextHeader);
  return section.includes(hooksFile) ? 'trust-entry-present-unverified' : 'trust-entry-absent';
}
function readRecordedValue(home, key) {
  const file = path.join(home, 'installations', `${hash(key)}.json`);
  const text = readText(file, { optional: true, privateFile: true });
  if (!text) return undefined;
  try { const data = JSON.parse(text); return data && data.owner === 'jev-agent-control' && data.path === key ? data.value : undefined; } catch { return undefined; }
}
/** Read-only status for `doctor`: per host, whether each owned hook event and the instruction block are installed/missing/changed, plus (Codex only) an unverified trust-entry presence check. Never reads or prints unrelated file content. */
export function describeHookStatus({ home, env = process.env, scope = 'user', project = process.cwd() } = {}) {
  const userHome = fs.realpathSync(env.HOME || os.homedir());
  const projectRoot = fs.existsSync(project) ? fs.realpathSync(project) : path.resolve(project);
  const result = {};
  for (const host of ['codex', 'claude']) {
    const hookFile = hookFileFor(host, scope, userHome, projectRoot, env);
    const text = readText(hookFile, { optional: true });
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    const events = {};
    for (const def of HOOK_EVENTS_BY_HOST[host]) {
      const recorded = readRecordedValue(home, `${hookFile}::hooks::${def.key}`);
      if (recorded === undefined) { events[def.key] = 'missing'; continue; }
      const arr = isObject(json) && Array.isArray(json.hooks?.[def.key]) ? json.hooks[def.key] : [];
      events[def.key] = arr.some(g => sameJson(g, recorded)) ? 'installed' : 'changed';
    }
    let instructionBlockStatus = 'not-applicable';
    if (scope === 'user') {
      const blockFile = blockFileFor(host, userHome, env);
      const recordedBlock = readRecordedValue(home, `${blockFile}::block`);
      if (recordedBlock === undefined) instructionBlockStatus = 'missing';
      else { const blockText = readText(blockFile, { optional: true }); instructionBlockStatus = blockText && blockText.includes(recordedBlock) ? 'installed' : 'changed'; }
    }
    const entry = { file: hookFile, events, instructionBlock: instructionBlockStatus };
    if (host === 'codex') entry.trust = codexTrustStatus(readText(path.join(env.CODEX_HOME || path.join(userHome, '.codex'), 'config.toml'), { optional: true }), hookFile);
    result[host] = entry;
  }
  return result;
}
export function installationPlan({ home, env = process.env, target = 'both', scope = 'user', project = process.cwd(), remove = false, hooks = false, hooksOnly = false, root = REPO_ROOT } = {}) {
  if (process.platform === 'win32') fail('USE_WSL');
  if (!['both', 'codex', 'claude'].includes(target) || !['user', 'project'].includes(scope)) fail('INVALID_INSTALL_OPTIONS');
  if (hooksOnly && !remove) fail('HOOKS_ONLY_REQUIRES_UNINSTALL');
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
    'startup_timeout_sec = 10', 'tool_timeout_sec = 210', 'enabled = true',
    `[mcp_servers.${SERVER_NAME}.env]`, `JEV_HOME = ${JSON.stringify(home)}`, END].join('\n');
  const wantHookChanges = hooks || remove;
  const hookChanges = [];
  const instructionBlocks = [];
  const hostTrustSet = new Set();
  // Owned hook-event JSON patch, shared by Codex hooks.json and Claude settings.json. Ownership of a
  // given event's group is decided by exact JSON equality to our own previous recorded value (the
  // same collision-safe pattern the MCP entry above uses), never by array position, so unrelated
  // groups before/after an event's array are never reordered or rewritten.
  function patchHookFile(file, host) {
    const before = readText(file, { optional: true });
    const json = before ? parseJson(before) : {};
    if (json.hooks !== undefined && !isObject(json.hooks)) fail('INVALID_HOST_CONFIG');
    const hooksObj = { ...(json.hooks || {}) };
    const added = [], removedList = [];
    const otherHashesBefore = [], otherHashesAfter = [];
    let touched = false;
    for (const def of HOOK_EVENTS_BY_HOST[host]) {
      const recKey = `${file}::hooks::${def.key}`;
      const owned = record(recKey);
      const existingArr = hooksObj[def.key];
      if (existingArr !== undefined && !Array.isArray(existingArr)) fail('INVALID_HOST_CONFIG');
      const list = Array.isArray(existingArr) ? existingArr.slice() : [];
      const idx = owned.value !== undefined ? list.findIndex(g => sameJson(g, owned.value)) : -1;
      if (owned.value !== undefined && idx === -1) fail('MANAGED_HOOK_CHANGED');
      for (let i = 0; i < list.length; i++) if (i !== idx) otherHashesBefore.push(hash(JSON.stringify(list[i])));
      if (remove) {
        if (idx !== -1) { removedList.push({ event: def.event, group: list[idx] }); list.splice(idx, 1); touched = true; }
        updateRecord(owned, recKey, undefined, true);
        for (const g of list) otherHashesAfter.push(hash(JSON.stringify(g)));
      } else {
        const target = hookGroup(def, cli, host, home);
        // An identical group we have no record of belongs to someone else (or a lost record); never duplicate or adopt it.
        if (idx === -1 && list.some(g => sameJson(g, target))) fail('HOOK_COLLISION');
        if (idx === -1) { list.push(target); added.push({ event: def.event, group: target }); touched = true; }
        else if (!sameJson(list[idx], target)) { list[idx] = target; added.push({ event: def.event, group: target }); touched = true; }
        updateRecord(owned, recKey, target, false);
        for (const g of list) if (!sameJson(g, target)) otherHashesAfter.push(hash(JSON.stringify(g)));
      }
      if (list.length) hooksObj[def.key] = list; else delete hooksObj[def.key];
    }
    // Every foreign group must survive unchanged and in order; otherwise refuse before planning a write.
    if (JSON.stringify(otherHashesBefore) !== JSON.stringify(otherHashesAfter)) fail('HOOK_PRESERVATION_FAILED');
    if (touched) {
      if (Object.keys(hooksObj).length) json.hooks = hooksObj; else delete json.hooks;
      const next = Object.keys(json).length ? JSON.stringify(json, null, 2) + '\n' : null;
      add(file, next, before);
    }
    let reformatted = false;
    if (before !== null) { try { reformatted = JSON.stringify(JSON.parse(before), null, 2) + '\n' !== before; } catch { reformatted = true; } }
    if (before !== null || added.length || removedList.length) {
      hookChanges.push({ path: file, added, removed: removedList, existingGroupHashes: { before: otherHashesBefore, after: otherHashesAfter }, reformatted });
    }
    if (host === 'codex' && added.length) hostTrustSet.add('codex');
  }
  function patchBlockFile(file, host) {
    const key = `${file}::block`;
    const owned = record(key);
    const before = readText(file, { optional: true });
    const targetBlock = instructionBlock(host);
    if (remove) {
      const next = mdPatch(before || '', targetBlock, true, owned.value);
      const changed = before !== null && next !== before;
      if (before !== null) add(file, next === '' ? null : next, before);
      updateRecord(owned, key, undefined, true);
      instructionBlocks.push({ path: file, action: changed ? 'removed' : 'absent', block: targetBlock });
    } else {
      const next = mdPatch(before || '', targetBlock, false, owned.value);
      const changed = next !== before;
      add(file, next, before);
      updateRecord(owned, key, targetBlock, false);
      instructionBlocks.push({ path: file, action: changed ? (before === null || !before.includes(targetBlock) ? 'installed' : 'unchanged') : 'unchanged', block: targetBlock });
    }
  }
  for (const agent of agents) {
    let dir;
    if (agent === 'codex') {
      dir = scope === 'user' ? (env.CODEX_HOME || path.join(userHome, '.codex')) : path.join(projectRoot, '.codex');
      if (!path.isAbsolute(dir)) fail('CODEX_HOME_MUST_BE_ABSOLUTE');
    }
    if (!hooksOnly) {
      let file;
      if (agent === 'codex') {
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
        const skillDir = path.join(skillsDir, skill), markerPath = path.join(skillDir, '.jev-managed.json');
        const markerText = readText(markerPath, { optional: true });
        const marker = markerText ? parseJson(markerText) : null;
        if (marker && marker.owner !== 'jev-agent-control') fail('SKILL_COLLISION');
        const files = {
          'SKILL.md': readText(path.join(root, 'skills', skill, 'SKILL.md')),
          'scripts/run.mjs': `#!/usr/bin/env node\nprocess.env.JEV_HOME ??= ${JSON.stringify(home)};\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`,
        };
        for (const [name, next] of Object.entries(files)) {
          const destination = path.join(skillDir, name), before = readText(destination, { optional: true });
          if (before !== null && (!marker || marker.files?.[name] !== hash(before))) fail('SKILL_CHANGED_OR_COLLISION');
          add(destination, remove ? null : next, before);
        }
        const nextMarker = JSON.stringify({ owner: 'jev-agent-control', version: VERSION, files: Object.fromEntries(Object.entries(files).map(([n, s]) => [n, hash(s)])) }, null, 2) + '\n';
        add(markerPath, remove ? null : nextMarker, markerText);
      }
    }
    if (wantHookChanges) {
      patchHookFile(hookFileFor(agent, scope, userHome, projectRoot, env), agent);
      if (scope === 'user') patchBlockFile(blockFileFor(agent, userHome, env), agent);
      else instructionBlocks.push({ path: null, action: 'skipped-project-scope', block: null });
    }
  }
  // User-scope shim is an optional convenience, not a shell startup-file modification.
  if (scope === 'user' && !hooksOnly) {
    const shim = path.join(userHome, '.local/bin/jev-control');
    const before = readText(shim, { optional: true });
    const next = `#!/bin/sh\n# jev-agent-control managed\nif [ -z "\${JEV_HOME:-}" ]; then JEV_HOME=${sh(home)}; export JEV_HOME; fi\nexec ${sh(process.execPath)} ${sh(cli)} "$@"\n`;
    const owned = record(shim);
    if (before !== null && before !== next && before !== owned.value) fail('SHIM_CHANGED_OR_COLLISION');
    // A partial uninstall leaves the shared shim for the other agent.
    add(shim, remove && target === 'both' ? null : (remove ? before : next), before, 0o700);
    if (!remove || target === 'both') updateRecord(owned, shim, next);
  }
  return { home, target, scope, remove, hooksOnly, agents, actions, runtime: cli, hookChanges, instructionBlocks, hostTrustRequired: [...hostTrustSet] };
}
export function applyInstallation(plan, { dryRun = false } = {}) {
  const report = { ok: true, dryRun, target: plan.target, scope: plan.scope, operation: plan.remove ? (plan.hooksOnly ? 'uninstall-hooks-only' : 'uninstall') : 'install',
    changes: plan.actions.map(a => ({ path: a.file, action: a.next === null ? 'remove-owned-file' : 'write' })),
    runtime: plan.runtime, typeSafeCredentialWritten: false, hostApprovalsChanged: false,
    hookChanges: plan.hookChanges, instructionBlocks: plan.instructionBlocks, hostTrustRequired: plan.hostTrustRequired };
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
    if (plan.remove && plan.target === 'both' && !plan.hooksOnly) setMode(plan.home, 'off');
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
