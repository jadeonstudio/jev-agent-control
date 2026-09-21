import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DEFAULTS, VERSION, PURPOSES, MODES, ControlError, errorCode, fail, isObject } from './constants.mjs';
import { resolveHome, loadConfig, getCredential, appendEvent } from './storage.mjs';
import { validateRequest, containsSensitiveData, wireRequest, normalizeResponse } from './contracts.mjs';
import { callTypeSafe } from './provider.mjs';

/** Shared implementation for MCP, CLI and owned orchestration loops. */
export function createDecisionEngine({ home = resolveHome(), env = process.env, provider = callTypeSafe, now = Date.now } = {}) {
  let inFlight = 0, failures = 0, circuitUntil = 0;
  let calls = [];
  const pendingFeedback = new Map();
  function remember(id, normalized) {
    for (const [key, value] of pendingFeedback) if (now() - value.at > 300000) pendingFeedback.delete(key);
    while (pendingFeedback.size >= 128) pendingFeedback.delete(pendingFeedback.keys().next().value);
    pendingFeedback.set(id, { at: now(), answers: normalized.answers });
  }
  function status() {
    let config, credential = 'missing', configError = null;
    try { config = loadConfig(home, env); } catch (e) { config = { ...DEFAULTS }; configError = errorCode(e); }
    try { credential = getCredential(home, env).source; } catch { credential = 'invalid'; }
    return { version: VERSION, mode: config.mode, killSwitch: env.JEV_DISABLE === '1', credential,
      ready: !configError && !['missing', 'invalid'].includes(credential), configError,
      model: config.model, home, telemetry: config.telemetry, inFlight, circuitOpen: now() < circuitUntil,
      limits: { timeoutMs: config.timeoutMs, maxCallsPerMinute: config.maxCallsPerMinute, maxInFlight: config.maxInFlight, scope: 'per-process' },
      requestLimits: { maxInputBytes: config.maxInputBytes, maxQuestions: config.maxQuestions },
      policyRevision: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      authorizesExecution: false };
  }
  async function decide(input, { signal, modeLimit = 'on', onEvaluated, modelOverride } = {}) {
    const start = performance.now();
    const result = { version: 1, id: randomUUID(), mode: 'off', apply: false, source: 'host', reason: 'OFF', answers: {},
      usage: { inputTokens: null, outputTokens: null }, networkCalls: 0, elapsedMs: 0, authorizesExecution: false };
    let config, request, inputBytes = 0, eligible = false, reserved = false;
    try {
      config = loadConfig(home, env);
      if (!MODES.includes(modeLimit)) fail('INVALID_MODE_LIMIT');
      result.mode = config.mode === 'off' || modeLimit === 'off' ? 'off' :
        (config.mode === 'shadow' || modeLimit === 'shadow' ? 'shadow' : 'on');
      if (result.mode === 'off') return result;
      if (signal?.aborted) fail('CANCELLED');
      request = validateRequest(input, config);
      if (request.risk === 'sensitive') fail('SENSITIVE_SCOPE');
      if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('INSECURE_TLS_REFUSED');
      const { key } = getCredential(home, env);
      if (!key) fail('NO_API_KEY');
      if (containsSensitiveData(request, key)) fail('SENSITIVE_INPUT');
      if (modelOverride !== undefined && (typeof modelOverride !== 'string' || !/^jev-\d+\.\d+\.\d+$/.test(modelOverride))) fail('INVALID_MODEL_OVERRIDE');
      const payload = wireRequest(request, modelOverride ?? config.model);
      inputBytes = Buffer.byteLength(JSON.stringify(payload));
      if (inputBytes > config.maxInputBytes) fail('INPUT_TOO_LARGE');
      if (now() < circuitUntil) fail('CIRCUIT_OPEN');
      if (inFlight >= config.maxInFlight) fail('CONCURRENCY_LIMIT');
      calls = calls.filter(t => now() - t < 60000);
      if (calls.length >= config.maxCallsPerMinute) fail('LOCAL_RATE_LIMIT');
      calls.push(now()); inFlight++; reserved = true; result.networkCalls = 1;
      const raw = await provider(payload, key, { timeoutMs: config.timeoutMs, signal });
      const normalized = normalizeResponse(raw, request, config);
      failures = 0; circuitUntil = 0;
      eligible = normalized.eligible;
      result.usage = normalized.usage;
      result.model = normalized.model;
      if (modelOverride && normalized.model !== modelOverride) fail('MODEL_VERSION_MISMATCH');
      // Read the shared switch again; a decision sent before OFF may not be applied afterwards.
      const current = loadConfig(home, env);
      if (signal?.aborted) fail('CANCELLED');
      if (current.mode !== config.mode) fail('MODE_CHANGED');
      if (JSON.stringify(current) !== JSON.stringify(config)) fail('POLICY_CHANGED');
      remember(result.id, normalized);
      // Trusted in-process observer only; never part of the MCP request schema.
      onEvaluated?.(structuredClone(normalized));
      if (result.mode === 'shadow') { result.reason = 'SHADOW'; }
      else if (!eligible) { result.reason = 'LOW_CONFIDENCE'; }
      else { result.apply = true; result.source = 'jev'; result.reason = 'ACCEPTED'; result.answers = normalized.answers; }
    } catch (e) {
      result.reason = errorCode(e);
      if (reserved && !['CANCELLED', 'MODE_CHANGED', 'POLICY_CHANGED'].includes(result.reason)) {
        if (++failures >= config.circuitFailureThreshold) circuitUntil = now() + config.circuitCooldownMs;
      }
    } finally {
      if (reserved) inFlight--;
      result.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      if (config?.telemetry && result.mode !== 'off') {
        result.telemetryStored = appendEvent(home, {
          kind: 'decision', at: new Date().toISOString(), id: result.id, mode: result.mode,
          model: result.model ?? null,
          purpose: request?.purpose ?? 'unknown', reason: result.reason, apply: result.apply, eligible,
          inputBytes, questionCount: request ? Object.keys(request.questions).length : 0,
          networkCalls: result.networkCalls, elapsedMs: result.elapsedMs, usage: result.usage,
        });
      }
    }
    return result;
  }
  function feedback(input) {
    if (!isObject(input) || Object.keys(input).some(k => !['id', 'baseline', 'baselineUsage', 'baselineElapsedMs', 'taskSucceeded'].includes(k))) fail('INVALID_FEEDBACK');
    if (typeof input.id !== 'string' || !isObject(input.baseline)) fail('INVALID_FEEDBACK');
    const saved = pendingFeedback.get(input.id);
    if (!saved || now() - saved.at > 300000) fail('FEEDBACK_EXPIRED_OR_UNKNOWN');
    const names = Object.keys(saved.answers);
    if (Object.keys(input.baseline).length !== names.length) fail('INVALID_FEEDBACK');
    let matched = 0;
    for (const name of names) {
      const expected = saved.answers[name].value, actual = input.baseline[name];
      if (typeof actual !== typeof expected || (typeof actual === 'number' && !Number.isFinite(actual))) fail('INVALID_FEEDBACK');
      if (typeof expected === 'number' ? Math.abs(expected - actual) <= 0.05 : expected === actual) matched++;
    }
    const usage = { inputTokens: null, outputTokens: null };
    if (input.baselineUsage !== undefined) {
      if (!isObject(input.baselineUsage) || Object.keys(input.baselineUsage).some(k => !Object.hasOwn(usage, k))) fail('INVALID_FEEDBACK');
      for (const k of Object.keys(usage)) {
        const v = input.baselineUsage[k];
        if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v < 0)) fail('INVALID_FEEDBACK');
        usage[k] = v ?? null;
      }
    }
    if (input.baselineElapsedMs !== undefined && (!Number.isFinite(input.baselineElapsedMs) || input.baselineElapsedMs < 0 || input.baselineElapsedMs > 86400000)) fail('INVALID_FEEDBACK');
    if (input.taskSucceeded !== undefined && typeof input.taskSucceeded !== 'boolean') fail('INVALID_FEEDBACK');
    const config = loadConfig(home, env);
    const event = { kind: 'feedback', at: new Date().toISOString(), id: input.id, matched, total: names.length, baselineUsage: usage,
      baselineElapsedMs: input.baselineElapsedMs ?? null, taskSucceeded: input.taskSucceeded ?? null };
    const telemetryStored = config.telemetry && config.mode !== 'off' ? appendEvent(home, event) : false;
    pendingFeedback.delete(input.id);
    return { matched, total: names.length, agreementOnly: true, telemetryStored };
  }
  return Object.freeze({ decide, status, feedback });
}

/** This replaces a host-model decision call; merely adding an MCP tool does not. */
export async function decideOrDelegate(engine, request, { use, delegate, signal } = {}) {
  if (typeof use !== 'function' || typeof delegate !== 'function') throw new ControlError('HANDLERS_REQUIRED');
  const decision = await engine.decide(request, { signal });
  return decision.apply ? use(decision.answers, decision) : delegate(decision);
}
