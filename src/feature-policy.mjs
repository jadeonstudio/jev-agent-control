import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODES, ID, MODEL_ID, RESERVED, fail, isObject } from './constants.mjs';
import { atomicWrite, ensureDir, readText } from './storage.mjs';
import { containsSensitiveData } from './contracts.mjs';

export const INTENTS = Object.freeze(['explain', 'edit', 'debug', 'operate', 'research', 'architecture', 'other']);
export const TIERS = Object.freeze(['economy', 'standard', 'strong']);
export const FEATURE_DEFAULTS = Object.freeze({
  version: 1,
  router: { mode: 'off', expectedModel: 'jev-1.13.0', minConfidence: 0.90, minProbability: 0.85,
    maxRiskProbability: 0.01, maxUnknownProbability: 0.05,
    economyMaxDifficulty: 2, standardMaxDifficulty: 3.5,
    economyMaxHardProbability: 0.02, standardMaxDeepProbability: 0.05,
    profiles: { codex: {}, claude: {} } },
  bulk: { mode: 'off', expectedModel: 'jev-1.13.0', maxItems: 128, batchSize: 8,
    maxRequests: 16, maxTotalMs: 10000, minRejectConfidence: 0.97, minRejectProbability: 0.99 },
});
function fields(value, allowed) {
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(k => RESERVED.has(k) || !allowed.includes(k))) fail('INVALID_FEATURE_POLICY');
}
function probability(value) { if (!Number.isFinite(value) || value < 0 || value > 1) fail('INVALID_FEATURE_POLICY'); }
function model(value) {
  if (typeof value !== 'string' || !MODEL_ID.test(value)) fail('INVALID_FEATURE_POLICY');
}
function profile(value) {
  fields(value, TIERS);
  for (const target of Object.values(value)) {
    fields(target, ['model', 'reasoning', 'skills']); model(target.model);
    if (target.reasoning !== undefined && (typeof target.reasoning !== 'string' || !ID.test(target.reasoning))) fail('INVALID_FEATURE_POLICY');
    if (target.skills !== undefined) {
      fields(target.skills, INTENTS);
      for (const ids of Object.values(target.skills)) {
        if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length ||
            ids.some(id => typeof id !== 'string' || !ID.test(id) || RESERVED.has(id))) fail('INVALID_FEATURE_POLICY');
      }
    }
  }
}
export function validateFeaturePolicy(raw) {
  fields(raw, ['version', 'router', 'bulk']);
  if (Object.hasOwn(raw, 'version') && raw.version !== 1) fail('INVALID_FEATURE_POLICY');
  fields(Object.hasOwn(raw, 'router') ? raw.router : {}, Object.keys(FEATURE_DEFAULTS.router));
  fields(Object.hasOwn(raw, 'bulk') ? raw.bulk : {}, Object.keys(FEATURE_DEFAULTS.bulk));
  const policy = { version: raw.version ?? 1,
    router: { ...structuredClone(FEATURE_DEFAULTS.router), ...raw.router },
    bulk: { ...FEATURE_DEFAULTS.bulk, ...raw.bulk } };
  if (policy.version !== 1) fail('INVALID_FEATURE_POLICY');
  for (const feature of [policy.router, policy.bulk]) {
    if (!MODES.includes(feature.mode) || !/^jev-\d+\.\d+\.\d+$/.test(feature.expectedModel)) fail('INVALID_FEATURE_POLICY');
  }
  const r = policy.router, b = policy.bulk;
  for (const key of ['minConfidence', 'minProbability', 'maxRiskProbability', 'maxUnknownProbability', 'economyMaxHardProbability', 'standardMaxDeepProbability']) probability(r[key]);
  if (r.minConfidence < 0.5 || r.minProbability < 0.5 || r.maxRiskProbability > 0.1 || r.maxUnknownProbability > 0.2) fail('INVALID_FEATURE_POLICY');
  if (!Number.isFinite(r.economyMaxDifficulty) || !Number.isFinite(r.standardMaxDifficulty) || !(r.economyMaxDifficulty >= 1 && r.economyMaxDifficulty <= r.standardMaxDifficulty && r.standardMaxDifficulty <= 5)) fail('INVALID_FEATURE_POLICY');
  fields(r.profiles, ['codex', 'claude']);
  for (const p of Object.values(r.profiles)) profile(p);
  for (const [key, min, max] of [['maxItems', 1, 128], ['batchSize', 1, 8], ['maxRequests', 1, 32], ['maxTotalMs', 100, 10000]]) {
    if (!Number.isInteger(b[key]) || b[key] < min || b[key] > max) fail('INVALID_FEATURE_POLICY');
  }
  for (const key of ['minRejectConfidence', 'minRejectProbability']) { probability(b[key]); if (b[key] < 0.9) fail('INVALID_FEATURE_POLICY'); }
  if (containsSensitiveData(policy)) fail('SENSITIVE_FEATURE_POLICY');
  return structuredClone(policy);
}
export function loadFeaturePolicy(home) {
  const text = readText(path.join(home, 'features.json'), { optional: true, privateFile: true, maxBytes: 16384 });
  let raw; try { raw = text === null ? {} : JSON.parse(text); } catch { fail('INVALID_FEATURE_POLICY'); }
  return validateFeaturePolicy(raw);
}
export function policyFingerprint(policy) { return createHash('sha256').update(JSON.stringify(policy)).digest('hex'); }
export function setFeatureMode(home, feature, mode) {
  if (!['router', 'bulk'].includes(feature) || !MODES.includes(mode)) fail('INVALID_FEATURE_MODE');
  ensureDir(home, true);
  const file = path.join(home, 'features.json');
  const previous = readText(file, { optional: true, privateFile: true });
  let policy;
  try { policy = loadFeaturePolicy(home); }
  catch (error) { if (mode !== 'off') throw error; policy = validateFeaturePolicy({}); }
  policy[feature].mode = mode;
  atomicWrite(file, JSON.stringify(policy, null, 2) + '\n', { expected: previous });
  return policy;
}
export function initializeFeaturePolicy(home) {
  ensureDir(home, true);
  const file = path.join(home, 'features.json');
  const previous = readText(file, { optional: true, privateFile: true });
  if (previous !== null) return { created: false, path: file, policy: loadFeaturePolicy(home) };
  const policy = validateFeaturePolicy({});
  atomicWrite(file, JSON.stringify(policy, null, 2) + '\n', { expected: null });
  return { created: true, path: file, policy };
}
export function effectiveMode(globalMode, featureMode) {
  if (globalMode === 'off' || featureMode === 'off') return 'off';
  return globalMode === 'shadow' || featureMode === 'shadow' ? 'shadow' : 'on';
}
