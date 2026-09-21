import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { errorCode, fail, isObject } from './constants.mjs';
import { resolveHome, appendEvent } from './storage.mjs';
import { containsSensitiveData } from './contracts.mjs';
import { createDecisionEngine } from './engine.mjs';
import { loadFeaturePolicy, policyFingerprint, effectiveMode, TIERS } from './feature-policy.mjs';
import { validateRouteInput, routeGuard, routeRequest, chooseRoute } from './routing.mjs';
import { validateFilterInput, filterRequest, filterChoices, packFilterBatches } from './filtering.mjs';

/** Shared, optional features. No classifier.dev calls, model APIs, shell commands or context mutation. */
export function createControlLayer({ home = resolveHome(), env = process.env, engine = createDecisionEngine({ home, env }), now = Date.now } = {}) {
  const pending = new Map();
  function remember(id, value) {
    for (const [key, item] of pending) if (now() - item.at > 300000) pending.delete(key);
    while (pending.size >= 128) pending.delete(pending.keys().next().value);
    pending.set(id, { ...value, at: now() });
  }
  function status() {
    const base = engine.status();
    try {
      const p = loadFeaturePolicy(home);
      return { ...base, features: { router: { mode: effectiveMode(base.mode, p.router.mode), configuredMode: p.router.mode,
        expectedModel: p.router.expectedModel, configuredTargets: Object.fromEntries(Object.entries(p.router.profiles).map(([host, targets]) => [host, Object.keys(targets)])) },
      bulk: { mode: effectiveMode(base.mode, p.bulk.mode), configuredMode: p.bulk.mode, expectedModel: p.bulk.expectedModel } }, featurePolicyError: null };
    } catch (error) { return { ...base, features: { router: { mode: 'off' }, bulk: { mode: 'off' } }, featurePolicyError: errorCode(error) }; }
  }
  function current(policy, feature, mode, revision) {
    const base = engine.status();
    if (base.configError) fail('INVALID_CONFIG');
    if (base.policyRevision !== revision) fail('GLOBAL_POLICY_CHANGED');
    if (policyFingerprint(loadFeaturePolicy(home)) !== policyFingerprint(policy)) fail('FEATURE_POLICY_CHANGED');
    if (effectiveMode(base.mode, policy[feature].mode) !== mode) fail('MODE_CHANGED');
  }
  function log(kind, result, policy, extra = {}) {
    if (result.mode === 'off' || !engine.status().telemetry) return;
    appendEvent(home, { kind, at: new Date().toISOString(), id: result.id, mode: result.mode, apply: result.apply,
      reason: result.reason, networkCalls: result.networkCalls, elapsedMs: result.elapsedMs,
      model: result.model ?? null, policy: policy ? policyFingerprint(policy) : null, ...extra });
  }
  async function route(input, { signal } = {}) {
    const start = performance.now();
    const result = { version: 1, id: randomUUID(), mode: 'off', apply: false, source: 'host', reason: 'OFF', route: null,
      networkCalls: 0, usage: { inputTokens: null, outputTokens: null }, authorizesExecution: false, changesHostModel: false };
    let policy, proposal, revision;
    try {
      policy = loadFeaturePolicy(home);
      const initial = engine.status(); revision = initial.policyRevision;
      result.mode = effectiveMode(initial.mode, policy.router.mode);
      if (result.mode === 'off') return result;
      if (signal?.aborted) fail('CANCELLED');
      const request = validateRouteInput(input);
      const guard = routeGuard(request, policy.router);
      if (guard) { result.reason = guard; return result; }
      if (containsSensitiveData(request)) fail('SENSITIVE_INPUT');
      let normalized;
      const d = await engine.decide(routeRequest(request), { signal, modeLimit: policy.router.mode, modelOverride: policy.router.expectedModel, onEvaluated: n => { normalized = n; } });
      Object.assign(result, { id: d.id, networkCalls: d.networkCalls, usage: d.usage, model: d.model ?? null, reason: d.reason });
      current(policy, 'router', result.mode, revision);
      if (signal?.aborted) fail('CANCELLED');
      if (!normalized || !normalized.eligible) return result;
      if (normalized.model !== policy.router.expectedModel) fail('MODEL_VERSION_MISMATCH');
      proposal = chooseRoute(normalized.answers, request, policy.router);
      if (!proposal.route) { result.reason = proposal.reason; return result; }
      if (result.mode === 'shadow') {
        remember(result.id, { kind: 'route', proposal: proposal.route.tier });
        result.reason = 'SHADOW';
      } else if (d.apply) {
        result.apply = true; result.source = 'policy'; result.route = proposal.route; result.features = proposal.features; result.reason = proposal.reason;
      }
    } catch (error) { result.reason = errorCode(error); result.apply = false; result.route = null; delete result.features; }
    finally {
      result.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      log('route', result, policy, { candidateAvailable: Boolean(proposal?.route) });
    }
    return result;
  }
  async function filter(input, { signal } = {}) {
    const start = performance.now();
    const result = { version: 1, id: randomUUID(), mode: 'off', apply: false, reason: 'OFF', keepIds: [], rejectIds: [], reviewIds: [],
      networkCalls: 0, valid: false, authorizesExecution: false, mutatesSource: false };
    let policy, request, revision;
    const rejected = new Set(), review = new Set();
    let resolved = 0;
    try {
      policy = loadFeaturePolicy(home);
      request = validateFilterInput(input, policy.bulk.maxItems);
      result.valid = true; result.keepIds = request.items.map(i => i.id);
      const initial = engine.status(); revision = initial.policyRevision;
      result.mode = effectiveMode(initial.mode, policy.bulk.mode);
      if (result.mode === 'off') return result;
      if (request.coverage === 'exhaustive') { result.reason = 'EXHAUSTIVE_KEEP_ALL'; return result; }
      if (request.risk === 'sensitive') { result.reason = 'SENSITIVE_SCOPE'; return result; }
      if (containsSensitiveData(request)) fail('SENSITIVE_INPUT');
      if (signal?.aborted) fail('CANCELLED');
      const candidates = request.items.filter(i => !i.required);
      if (!candidates.length) { result.reason = 'NOTHING_TO_FILTER'; return result; }
      const packed = packFilterBatches(request.query, candidates, { ...initial.requestLimits, batchSize: policy.bulk.batchSize, model: policy.bulk.expectedModel });
      for (const id of packed.deferred) review.add(id);
      const deadline = AbortSignal.timeout(policy.bulk.maxTotalMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      for (let index = 0; index < packed.batches.length; index++) {
        current(policy, 'bulk', result.mode, revision);
        if (signal?.aborted) fail('CANCELLED');
        if (result.networkCalls >= policy.bulk.maxRequests || deadline.aborted) {
          for (const item of packed.batches.slice(index).flat()) review.add(item.id);
          break;
        }
        const batch = packed.batches[index];
        let normalized;
        const d = await engine.decide(filterRequest(request.query, batch), { signal: combined, modeLimit: policy.bulk.mode, modelOverride: policy.bulk.expectedModel, onEvaluated: n => { normalized = n; } });
        result.networkCalls += d.networkCalls;
        if (d.model) result.model = d.model;
        current(policy, 'bulk', result.mode, revision);
        if (signal?.aborted) fail('CANCELLED');
        if (d.reason === 'MODEL_VERSION_MISMATCH') fail('MODEL_VERSION_MISMATCH');
        // Preserve the original engine's all-question acceptance gate: uncertain chunks keep ALL items.
        if (!normalized?.eligible || (!d.apply && d.reason !== 'SHADOW') || normalized.model !== policy.bulk.expectedModel) {
          for (const item of batch) review.add(item.id);
          // Authentication, provider outage, version drift or budget errors cannot be repaired by retrying more chunks.
          if (!['LOW_CONFIDENCE', 'SHADOW', 'ACCEPTED'].includes(d.reason) || (normalized && normalized.model !== policy.bulk.expectedModel)) {
            for (const item of packed.batches.slice(index + 1).flat()) review.add(item.id);
            break;
          }
          continue;
        }
        resolved += batch.length;
        for (const item of filterChoices(normalized.answers, batch, policy.bulk)) {
          if (item.reject) rejected.add(item.id);
          if (item.review) review.add(item.id);
        }
      }
      current(policy, 'bulk', result.mode, revision);
      if (signal?.aborted) fail('CANCELLED');
      if (result.mode === 'shadow') {
        if (resolved) remember(result.id, { kind: 'filter', rejected: [...rejected], ids: request.items.map(i => i.id) });
        result.reason = 'SHADOW';
      } else {
        result.apply = resolved > 0; result.reason = resolved ? (review.size ? 'PARTIAL_KEEP' : 'FILTERED') : 'KEEP_ALL_FALLBACK';
        result.rejectIds = request.items.filter(i => rejected.has(i.id)).map(i => i.id);
        result.keepIds = request.items.filter(i => !rejected.has(i.id)).map(i => i.id);
        result.reviewIds = request.items.filter(i => review.has(i.id)).map(i => i.id);
      }
    } catch (error) {
      result.reason = errorCode(error); result.apply = false; result.rejectIds = []; result.reviewIds = [];
      result.keepIds = request?.items.map(i => i.id) ?? [];
    } finally {
      result.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      result.counts = { input: request?.items.length ?? 0, kept: result.keepIds.length, rejected: result.rejectIds.length, review: result.reviewIds.length };
      log('filter', result, policy, { inputCount: result.counts.input, candidateRejectCount: rejected.size, rejectedCount: result.rejectIds.length });
    }
    return result;
  }
  function observe(input) {
    if (!isObject(input) || Object.keys(input).some(k => !['id', 'tier', 'relevantIds'].includes(k)) || typeof input.id !== 'string') fail('INVALID_OBSERVATION');
    const item = pending.get(input.id);
    if (!item || now() - item.at > 300000) fail('FEEDBACK_EXPIRED_OR_UNKNOWN');
    let metrics;
    if (item.kind === 'route') {
      if (!TIERS.includes(input.tier) || input.relevantIds !== undefined) fail('INVALID_OBSERVATION');
      metrics = { matched: item.proposal === input.tier, agreementOnly: true, taskQualityMeasured: false };
    } else {
      if (input.tier !== undefined || !Array.isArray(input.relevantIds) || new Set(input.relevantIds).size !== input.relevantIds.length || input.relevantIds.some(id => !item.ids.includes(id))) fail('INVALID_OBSERVATION');
      const misses = input.relevantIds.filter(id => item.rejected.includes(id)).length;
      metrics = { relevant: input.relevantIds.length, missed: misses, recall: input.relevantIds.length ? 1 - misses / input.relevantIds.length : null, suppliedLabelsOnly: true };
    }
    pending.delete(input.id);
    const base = engine.status();
    if (base.mode !== 'off' && base.telemetry) appendEvent(home, { kind: 'observation', at: new Date().toISOString(), id: input.id, feature: item.kind, ...metrics });
    return metrics;
  }
  return Object.freeze({ route, filter, observe, status });
}
export const observeSchema = {
  type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string' }, tier: { type: 'string', enum: TIERS }, relevantIds: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string' } },
  },
};
