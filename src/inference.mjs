import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readText, atomicWrite, ensureDir } from './storage.mjs';
import { ControlError, fail } from './constants.mjs';
import { normalizeResponse } from './contracts.mjs';
import { only, text, HASH, digest, fraction } from './training/schema.mjs';

export function loadProviderConfig(home) {
  const source = readText(path.join(home, 'providers.json'), { optional: true, privateFile: true, maxBytes: 8192 });
  const c = source === null ? { version: 1, provider: 'jev', laya: null } : JSON.parse(source);
  only(c, ['version', 'provider', 'laya'], ['version', 'provider']);
  if (c.version !== 1 || !['jev', 'laya'].includes(c.provider)) fail('INVALID_PROVIDER_CONFIG');
  c.laya ??= null;
  if (c.laya !== null) {
    const l = c.laya;
    only(l, ['python', 'modelPath', 'model', 'checkpoint', 'runtimeVersion', 'device', 'startupTimeoutMs', 'idleTimeoutMs', 'qualification'],
      ['python', 'modelPath', 'model', 'checkpoint', 'runtimeVersion', 'device']);
    if (!path.isAbsolute(l.python) || !path.isAbsolute(l.modelPath) || !HASH.test(l.checkpoint) || l.runtimeVersion !== '0.3.4' ||
        !['cpu', 'mps', 'cuda'].includes(l.device) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(l.model)) fail('INVALID_PROVIDER_CONFIG');
    for (const [name, fallback, max] of [['startupTimeoutMs', 120000, 180000], ['idleTimeoutMs', 60000, 300000]]) {
      l[name] ??= fallback; if (!Number.isInteger(l[name]) || l[name] < 100 || l[name] > max) fail('INVALID_PROVIDER_CONFIG');
    }
    if (l.qualification != null) {
      only(l.qualification, ['checkpoint', 'calibrationVersion', 'purposes', 'minConfidence', 'minChoiceProbability', 'noulCertainty'],
        ['checkpoint', 'calibrationVersion', 'purposes', 'minConfidence', 'minChoiceProbability', 'noulCertainty']);
      if (l.qualification.checkpoint !== l.checkpoint || !Array.isArray(l.qualification.purposes) ||
          l.qualification.purposes.some(x => !['route', 'select', 'retry', 'review', 'judge', 'escalate'].includes(x))) fail('INVALID_PROVIDER_CONFIG');
      text(l.qualification.calibrationVersion, 80);
      for (const k of ['minConfidence', 'minChoiceProbability', 'noulCertainty']) { fraction(l.qualification[k]); if (l.qualification[k] < .5) fail('INVALID_PROVIDER_CONFIG'); }
    }
  }
  if (c.provider === 'laya' && !c.laya) fail('LAYA_NOT_CONFIGURED');
  return c;
}
export function selectProvider(home, provider) {
  if (!['jev', 'laya'].includes(provider)) fail('INVALID_PROVIDER_CONFIG');
  const c = loadProviderConfig(home);
  if (provider === 'laya' && !c.laya) fail('LAYA_NOT_CONFIGURED');
  ensureDir(home, true);
  const file = path.join(home, 'providers.json'), old = readText(file, { optional: true, privateFile: true });
  atomicWrite(file, JSON.stringify({ ...c, provider }, null, 2) + '\n', { expected: old });
  return { provider, modeUnchanged: true, downloaded: false };
}
export function layaReady(l) {
  if (!l) return false;
  try { return fs.statSync(l.python).isFile() && fs.statSync(l.modelPath).isDirectory() && fs.statSync(path.join(l.modelPath, 'model.safetensors')).isFile(); }
  catch { return false; }
}
export function normalizeInference(provider, raw, request, config, settings) {
  if (provider === 'jev') {
    const n = normalizeResponse(raw, request, config);
    return { ...n, provenance: { provider, model: n.model, model_version: n.model, checkpoint: n.model,
      runtime_version: 'typesafe-systemone-v1', preprocessing_version: 'wire-request-v1', confidence_semantics: 'provider-distribution-statistic' } };
  }
  const identity = raw?.identity, l = settings.laya;
  if (!identity || identity.checkpoint !== l.checkpoint || identity.runtime_version !== l.runtimeVersion || identity.model !== l.model ||
      typeof identity.device !== 'string' || identity.device.split(':')[0] !== l.device || !['torch.float32', 'torch.float16', 'torch.bfloat16'].includes(identity.precision)) fail('LAYA_IDENTITY_MISMATCH');
  const policy = l.qualification;
  // Canonical shape validation is shared; probability meaning and acceptance are provider-specific.
  const n = normalizeResponse({ ...raw, model: identity.model }, request, { ...config,
    minConfidence: policy?.minConfidence ?? 1, minChoiceProbability: policy?.minChoiceProbability ?? 1, noulCertainty: policy?.noulCertainty ?? 1 });
  return { ...n, eligible: Boolean(policy?.purposes.includes(request.purpose)) && n.eligible,
    qualified: Boolean(policy?.purposes.includes(request.purpose)), provenance: { provider, model: identity.model,
      model_version: identity.checkpoint, checkpoint: identity.checkpoint, runtime_version: identity.runtime_version,
      preprocessing_version: 'official-laya-0.3.4-lossless-v1', confidence_semantics: 'choice-score-normalized-entropy;noul-probability',
      device: identity.device, precision: identity.precision } };
}

/** One optional warm Python process. No shell, API keys, downloaded code, HTTP listener or automatic training. */
export function createLayaClient({ spawnImpl = spawn } = {}) {
  let child, starting, readyIdentity, identityKey, buffer = '', idle, decoder = new StringDecoder('utf8');
  const pending = new Map();
  let readyResolve, readyReject, startupTimer;
  function stop(code = 'LAYA_WORKER_STOPPED') {
    clearTimeout(idle); clearTimeout(startupTimer);
    const old = child; child = null; starting = null; readyIdentity = null; buffer = ''; decoder = new StringDecoder('utf8');
    readyReject?.(new ControlError(code)); readyReject = null; readyResolve = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new ControlError(code)); }
    pending.clear();
    if (old) { old.stdin.destroy(); old.kill('SIGTERM'); const kill = setTimeout(() => old.kill('SIGKILL'), 500); kill.unref(); }
  }
  function armIdle(l) { clearTimeout(idle); if (!pending.size) { idle = setTimeout(() => stop(), l.idleTimeoutMs); idle.unref(); } }
  async function start(l, env) {
    const key = digest(l);
    if (child && identityKey !== key) stop('LAYA_CONFIG_CHANGED');
    if (readyIdentity) return readyIdentity;
    if (starting) return starting;
    if (!layaReady(l)) fail('LAYA_NOT_READY');
    identityKey = key;
    const script = fileURLToPath(new URL('../workers/laya_worker.py', import.meta.url));
    const allowedEnv = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'SYSTEMROOT'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
    const promise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    starting = promise;
    const process = spawnImpl(l.python, ['-I', script], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...allowedEnv, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false',
    } });
    child = process;
    process.stderr.on('data', () => {}); // Drain only. Dependency diagnostics can contain paths/data.
    process.stdin.on('error', () => { if (child === process) stop('LAYA_WORKER_IO'); });
    process.on('error', () => { if (child === process) stop('LAYA_WORKER_START'); });
    process.on('exit', () => { if (child === process) stop('LAYA_WORKER_EXIT'); });
    process.stdout.on('data', chunk => {
      if (child !== process) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 262144) { stop('LAYA_FRAME_TOO_LARGE'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { stop('LAYA_PROTOCOL_ERROR'); return; }
        if (msg.ready === true) { clearTimeout(startupTimer); readyIdentity = msg.identity; const resolve = readyResolve; readyResolve = readyReject = null; resolve?.(msg.identity); }
        else if (msg.error && !msg.id) { stop('LAYA_STARTUP_REJECTED'); return; }
        else {
          const p = pending.get(msg.id); if (!p) { stop('LAYA_PROTOCOL_ERROR'); return; }
          pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.error) p.reject(new ControlError(/^[A-Z_]{1,64}$/.test(msg.error) ? msg.error : 'LAYA_ERROR'));
          else p.resolve(msg.result);
          armIdle(l);
        }
      }
    });
    startupTimer = setTimeout(() => stop('LAYA_STARTUP_TIMEOUT'), l.startupTimeoutMs);
    process.stdin.write(JSON.stringify({ init: { modelPath: l.modelPath, model: l.model, checkpoint: l.checkpoint, runtimeVersion: l.runtimeVersion, device: l.device } }) + '\n');
    return promise;
  }
  async function infer(request, settings, { timeoutMs, signal, env = process.env } = {}) {
    const l = settings.laya;
    if (!l) fail('LAYA_NOT_CONFIGURED');
    if (signal?.aborted) fail('CANCELLED');
    const cancelled = () => stop('CANCELLED'); signal?.addEventListener('abort', cancelled, { once: true });
    try {
      clearTimeout(idle); await start(l, env);
      if (signal?.aborted) fail('CANCELLED');
      if (pending.size >= 4) fail('CONCURRENCY_LIMIT');
      const id = randomUUID();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, state: request.state, questions: request.questions }) + '\n');
      });
    } finally { signal?.removeEventListener('abort', cancelled); }
  }
  return Object.freeze({ infer, close: stop, status: () => ({ running: Boolean(child), ready: Boolean(readyIdentity), inFlight: pending.size }) });
}
