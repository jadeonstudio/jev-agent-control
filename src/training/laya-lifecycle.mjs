// Explicit Laya checkpoint lifecycle: register -> holdout freeze -> qualify -> compare -> promote -> rollback.
// Nothing here starts training or promotes automatically; every step is one operator-invoked CLI command.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noSymlinks, ensureDir, readText, atomicWrite } from '../storage.mjs';
import { fail, PURPOSES, DEFAULTS } from '../constants.mjs';
import { HASH, digest, encode, only } from './schema.mjs';
import { readDataset } from './dataset.mjs';
import { createTrainingStore } from './store.mjs';
import { loadProviderConfig, validateProviderConfig, normalizeInference, createLayaClient } from '../inference.mjs';
import { validateRequest, wireRequest } from '../contracts.mjs';

export const LAYA_RUNTIME_VERSION = '0.3.4';
const DEVICES = ['cpu', 'mps', 'cuda'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const layaRoot = home => path.join(home, 'laya');
const candidatesDir = home => path.join(layaRoot(home), 'candidates');
const checkpointsDir = home => path.join(layaRoot(home), 'checkpoints');
const holdoutsDir = home => path.join(layaRoot(home), 'holdouts');
const qualificationsDir = home => path.join(layaRoot(home), 'qualifications');
const comparisonsDir = home => path.join(layaRoot(home), 'comparisons');
const historyFile = home => path.join(layaRoot(home), 'history.jsonl');
const providersFile = home => path.join(home, 'providers.json');

// Validate against the exact providers.json contract the runtime loader enforces (never a divergent copy).
function validateLayaSettings(l) { validateProviderConfig({ version: 1, provider: 'jev', laya: structuredClone(l) }); }
function assertNoSymlinksDeep(root) {
  noSymlinks(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fail('LAYA_MODEL_SYMLINK_REFUSED');
      if (st.isDirectory()) stack.push(p);
    }
  }
}
/** Offline, file-hashing only: `python -I workers/laya_worker.py --fingerprint <dir>`. No inference, no download. */
export function defaultFingerprint(python, dir) {
  if (typeof python !== 'string' || !path.isAbsolute(python)) fail('LAYA_PYTHON_NOT_CONFIGURED');
  const script = fileURLToPath(new URL('../../workers/laya_worker.py', import.meta.url));
  const r = spawnSync(python, ['-I', script, '--fingerprint', dir], { shell: false, encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) fail('LAYA_FINGERPRINT_FAILED');
  let parsed; try { parsed = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { fail('LAYA_FINGERPRINT_FAILED'); }
  if (!parsed || !HASH.test(parsed.checkpoint)) fail('LAYA_FINGERPRINT_FAILED');
  return parsed.checkpoint;
}

// --- register ---------------------------------------------------------
export function registerCheckpoint(home, { checkpointDir, model, device, python, fingerprintImpl = defaultFingerprint } = {}) {
  if (typeof checkpointDir !== 'string' || !path.isAbsolute(checkpointDir)) fail('LAYA_CHECKPOINT_PATH_REQUIRED');
  assertNoSymlinksDeep(checkpointDir);
  let stat; try { stat = fs.statSync(checkpointDir); } catch { fail('LAYA_CHECKPOINT_NOT_DIRECTORY'); }
  if (!stat.isDirectory()) fail('LAYA_CHECKPOINT_NOT_DIRECTORY');
  let active = { version: 1, provider: 'jev', laya: null };
  try { active = loadProviderConfig(home); } catch { /* providers.json absent/invalid: fall back to explicit flags only */ }
  const resolvedPython = python ?? active.laya?.python;
  if (typeof resolvedPython !== 'string' || !path.isAbsolute(resolvedPython)) fail('LAYA_PYTHON_NOT_CONFIGURED');
  const resolvedDevice = device ?? active.laya?.device;
  if (!DEVICES.includes(resolvedDevice)) fail('LAYA_DEVICE_REQUIRED');
  const checkpoint = fingerprintImpl(resolvedPython, checkpointDir);
  const resolvedModel = model ?? `laya/${checkpoint.slice(0, 12)}`;
  if (!MODEL_RE.test(resolvedModel)) fail('LAYA_MODEL_INVALID');
  ensureDir(layaRoot(home), true); ensureDir(checkpointsDir(home), true); ensureDir(candidatesDir(home), true);
  const dest = path.join(checkpointsDir(home), checkpoint);
  const reused = fs.existsSync(dest);
  if (reused) {
    noSymlinks(dest);
    if (fingerprintImpl(resolvedPython, dest) !== checkpoint) fail('LAYA_CHECKPOINT_STORE_CORRUPTED');
  } else {
    const tmp = path.join(checkpointsDir(home), `.tmp-${randomUUID()}`);
    fs.cpSync(checkpointDir, tmp, { recursive: true, dereference: false });
    try {
      assertNoSymlinksDeep(tmp);
      if (fingerprintImpl(resolvedPython, tmp) !== checkpoint) fail('LAYA_CHECKPOINT_COPY_MISMATCH');
      fs.chmodSync(tmp, 0o700);
      fs.renameSync(tmp, dest);
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  }
  const candidate = { python: resolvedPython, modelPath: dest, model: resolvedModel, checkpoint, runtimeVersion: LAYA_RUNTIME_VERSION, device: resolvedDevice };
  validateLayaSettings(candidate);
  const file = path.join(candidatesDir(home), `${checkpoint}.json`);
  atomicWrite(file, JSON.stringify(candidate, null, 2) + '\n');
  return { checkpoint, candidate: file, modelPath: dest, reused };
}

// --- holdout ------------------------------------------------------------
export function freezeHoldout(home, { datasetVersion, name = datasetVersion, store } = {}) {
  if (!NAME_RE.test(String(name))) fail('INVALID_HOLDOUT_NAME');
  const s = store ?? createTrainingStore({ home });
  const { samples } = readDataset(s, datasetVersion);
  const testSamples = samples.filter(x => x.split === 'test');
  if (!testSamples.length) fail('EMPTY_HOLDOUT');
  ensureDir(layaRoot(home), true); ensureDir(holdoutsDir(home), true);
  const dataFile = path.join(holdoutsDir(home), `${name}.jsonl`), manifestFile = path.join(holdoutsDir(home), `${name}.json`);
  if (fs.existsSync(dataFile) || fs.existsSync(manifestFile)) fail('HOLDOUT_ALREADY_EXISTS');
  const contents = testSamples.map(encode).join('\n') + '\n';
  const manifest = { name: String(name), dataset_version: datasetVersion, sample_count: testSamples.length, sha256: digest(contents), created_at: new Date().toISOString() };
  atomicWrite(dataFile, contents, { expected: null });
  atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { expected: null });
  return manifest;
}
export function listHoldouts(home) {
  const dir = holdoutsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(readText(path.join(dir, f), { privateFile: true, maxBytes: 65536 })));
}
function readHoldout(home, name) {
  if (!NAME_RE.test(String(name))) fail('INVALID_HOLDOUT_NAME');
  const manifest = JSON.parse(readText(path.join(holdoutsDir(home), `${name}.json`), { privateFile: true, maxBytes: 65536 }));
  const contents = readText(path.join(holdoutsDir(home), `${name}.jsonl`), { privateFile: true, maxBytes: 64 * 1024 * 1024 });
  if (manifest.sha256 !== digest(contents)) fail('HOLDOUT_CORRUPTED');
  const samples = contents.trim() ? contents.trim().split('\n').map(JSON.parse) : [];
  if (samples.length !== manifest.sample_count) fail('HOLDOUT_CORRUPTED');
  return { manifest, samples };
}

// --- inference over dataset/holdout samples ------------------------------
async function inferOne(layaClient, laya, sample, { timeoutMs = 30000, env = process.env, signal } = {}) {
  const request = validateRequest({ purpose: sample.purpose, risk: 'routine', state: sample.state, questions: { [sample.question_id]: sample.question } }, DEFAULTS);
  const payload = wireRequest(request, laya.model);
  const raw = await layaClient.infer(payload, { laya }, { timeoutMs, env, signal });
  const relaxed = { ...DEFAULTS, minConfidence: 0, minChoiceProbability: 0, noulCertainty: 0 };
  const n = normalizeInference('laya', raw, request, relaxed, { laya });
  const answer = n.answers[sample.question_id];
  const correct = answer.value === sample.target.value;
  // Threshold mapping: choice questions gate on BOTH selected probability and confidence (the
  // minChoiceProbability/minConfidence pair); noul gates on max(p,1-p) i.e. certainty away from 0.5;
  // score gates on confidence alone. A single grid value t is compared against whichever metric applies.
  const metric = sample.question.type === 'noul' ? Math.max(answer.probabilityTrue, 1 - answer.probabilityTrue)
    : sample.question.type === 'choice' ? Math.min(answer.confidence, answer.selectedProbability)
    : answer.confidence;
  return { purpose: sample.purpose, correct, metric };
}
async function inferAll(layaClient, laya, samples, opts) {
  const out = [];
  for (const sample of samples) out.push(await inferOne(layaClient, laya, sample, opts));
  return out;
}
function groupByPurpose(records) {
  const out = Object.create(null);
  for (const r of records) (out[r.purpose] ??= []).push(r);
  return out;
}
function wilsonLowerBound(successes, n) {
  if (n === 0) return 0;
  const z = 1.959963985;
  const p = successes / n, denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}
function evalSplit(records, threshold) {
  const covered = records.filter(r => r.metric >= threshold);
  const successes = covered.filter(r => r.correct).length;
  return { n: covered.length, coverage: records.length ? covered.length / records.length : 0,
    accuracy: covered.length ? successes / covered.length : 0, lowerBound: wilsonLowerBound(successes, covered.length) };
}
// Grid search 0.50..0.99 step 0.01: lowest threshold meeting selective accuracy and coverage floors.
function selectThreshold(records, { targetAccuracy, minCoverage, minCalibration }) {
  if (records.length < minCalibration) return null;
  for (let step = 50; step <= 99; step++) {
    const threshold = step / 100;
    const ev = evalSplit(records, threshold);
    if (ev.n > 0 && ev.coverage >= minCoverage && ev.accuracy >= targetAccuracy) return threshold;
  }
  return null;
}

// --- qualify --------------------------------------------------------------
export function loadCandidate(home, candidateHash) {
  if (!HASH.test(candidateHash)) fail('INVALID_CANDIDATE_HASH');
  const file = path.join(candidatesDir(home), `${candidateHash}.json`);
  let laya; try { laya = JSON.parse(readText(file, { privateFile: true, maxBytes: 8192 })); } catch { fail('LAYA_CANDIDATE_NOT_FOUND'); }
  validateLayaSettings(laya);
  if (laya.checkpoint !== candidateHash) fail('LAYA_CANDIDATE_MISMATCH');
  return laya;
}
export async function qualifyCandidate(home, { candidateHash, datasetVersion, holdoutName, layaClient = createLayaClient(), store,
  timeoutMs = 30000, env = process.env, signal,
  targetAccuracy = 0.9, minCoverage = 0.2, minCalibration = 30, minTest = 30, minLowerBound = 0.8 } = {}) {
  if (!Number.isFinite(targetAccuracy) || targetAccuracy < 0.5 || targetAccuracy > 1) fail('INVALID_QUALIFY_PARAMS');
  if (!Number.isFinite(minCoverage) || minCoverage <= 0 || minCoverage > 1) fail('INVALID_QUALIFY_PARAMS');
  if (!Number.isInteger(minCalibration) || minCalibration < 1) fail('INVALID_QUALIFY_PARAMS');
  if (!Number.isInteger(minTest) || minTest < 1) fail('INVALID_QUALIFY_PARAMS');
  if (!Number.isFinite(minLowerBound) || minLowerBound < 0 || minLowerBound > 1) fail('INVALID_QUALIFY_PARAMS');
  const laya = loadCandidate(home, candidateHash);
  const s = store ?? createTrainingStore({ home });
  const { samples } = readDataset(s, datasetVersion);
  const { manifest: holdoutManifest, samples: holdoutSamples } = readHoldout(home, holdoutName);
  const opts = { timeoutMs, env, signal };
  const calibrationByPurpose = groupByPurpose(await inferAll(layaClient, laya, samples.filter(x => x.split === 'calibration'), opts));
  const testByPurpose = groupByPurpose(await inferAll(layaClient, laya, samples.filter(x => x.split === 'test'), opts));
  const holdoutByPurpose = groupByPurpose(await inferAll(layaClient, laya, holdoutSamples, opts));
  const evidence = {}, qualifiedPurposes = [];
  let globalThreshold = null;
  for (const purpose of PURPOSES) {
    const calib = calibrationByPurpose[purpose] || [];
    const threshold = selectThreshold(calib, { targetAccuracy, minCoverage, minCalibration });
    const entry = { calibration: { n: calib.length, threshold } };
    if (threshold != null) {
      entry.test = evalSplit(testByPurpose[purpose] || [], threshold);
      entry.holdout = evalSplit(holdoutByPurpose[purpose] || [], threshold);
      entry.passes = entry.test.n >= minTest && entry.holdout.n >= minTest &&
        entry.test.accuracy >= targetAccuracy && entry.holdout.accuracy >= targetAccuracy &&
        entry.test.lowerBound >= minLowerBound && entry.holdout.lowerBound >= minLowerBound;
      if (entry.passes) { qualifiedPurposes.push(purpose); globalThreshold = globalThreshold == null ? threshold : Math.max(globalThreshold, threshold); }
    }
    evidence[purpose] = entry;
  }
  const params = { targetAccuracy, minCoverage, minCalibration, minTest, minLowerBound };
  // Must fit the provider contract's 80-character calibrationVersion limit.
  const calibrationVersion = `${datasetVersion.slice(0, 32)}:q-${digest(params).slice(0, 32)}`;
  const result = { checkpoint: candidateHash, qualified: qualifiedPurposes.length > 0, purposes: qualifiedPurposes,
    minConfidence: globalThreshold ?? 1, minChoiceProbability: globalThreshold ?? 1, noulCertainty: globalThreshold ?? 1,
    calibrationVersion, dataset_version: datasetVersion, holdout: holdoutManifest.name, holdout_sha256: holdoutManifest.sha256,
    params, evidence, generated_at: new Date().toISOString() };
  ensureDir(layaRoot(home), true); ensureDir(qualificationsDir(home), true);
  atomicWrite(path.join(qualificationsDir(home), `${candidateHash}.json`), JSON.stringify(result, null, 2) + '\n');
  return result;
}
export function loadQualification(home, candidateHash) {
  const file = path.join(qualificationsDir(home), `${candidateHash}.json`);
  const text = readText(file, { optional: true, privateFile: true, maxBytes: 1048576 });
  return text === null ? null : JSON.parse(text);
}

// --- compare ----------------------------------------------------------
// An invalid providers.json must fail loudly here, not look like "no active checkpoint".
function activeLayaOf(home) { return loadProviderConfig(home).laya ?? null; }
export async function compareCandidate(home, { candidateHash, holdoutName, layaClient = createLayaClient(),
  noActiveBaseline = false, timeoutMs = 30000, env = process.env, signal } = {}) {
  const candidate = loadCandidate(home, candidateHash);
  const active = activeLayaOf(home);
  if (!active && !noActiveBaseline) fail('ACTIVE_BASELINE_REQUIRED');
  const { manifest: holdoutManifest, samples: holdoutSamples } = readHoldout(home, holdoutName);
  const opts = { timeoutMs, env, signal };
  const candidateQual = loadQualification(home, candidateHash);
  // raw = every holdout answer (threshold 0): comparable across checkpoints and the basis of the forgetting check.
  // selective = the checkpoint's own qualified threshold; only comparable when BOTH sides are qualified for the purpose.
  const side = (records, qual, purpose) => {
    const qualified = Boolean(qual?.purposes?.includes(purpose));
    return { qualified, raw: evalSplit(records, 0), selective: qualified ? evalSplit(records, qual.minConfidence) : null };
  };
  const candidateByPurpose = groupByPurpose(await inferAll(layaClient, candidate, holdoutSamples, opts));
  const purposes = {};
  for (const purpose of PURPOSES) purposes[purpose] = { candidate: side(candidateByPurpose[purpose] || [], candidateQual, purpose) };
  if (active) {
    const activeByPurpose = groupByPurpose(await inferAll(layaClient, active, holdoutSamples, opts));
    for (const purpose of PURPOSES) purposes[purpose].active = side(activeByPurpose[purpose] || [], active.qualification, purpose);
  }
  const report = { active: active?.checkpoint ?? null, candidate: candidateHash, holdout: holdoutManifest.name,
    holdout_sha256: holdoutManifest.sha256, purposes, generated_at: new Date().toISOString() };
  ensureDir(layaRoot(home), true); ensureDir(comparisonsDir(home), true);
  const file = path.join(comparisonsDir(home), `${active?.checkpoint ?? 'none'}__${candidateHash}__${holdoutManifest.name}.json`);
  atomicWrite(file, JSON.stringify(report, null, 2) + '\n');
  return report;
}
function loadComparison(home, activeHash, candidateHash, holdoutName) {
  const file = path.join(comparisonsDir(home), `${activeHash ?? 'none'}__${candidateHash}__${holdoutName}.json`);
  const text = readText(file, { optional: true, privateFile: true, maxBytes: 1048576 });
  return text === null ? null : JSON.parse(text);
}

// --- history (append-only; each entry can invert the previous providers.json laya block) --
function appendHistory(home, entry) {
  ensureDir(layaRoot(home), true);
  const file = historyFile(home);
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readHistory(home) {
  const text = readText(historyFile(home), { optional: true, privateFile: true, maxBytes: 10 * 1024 * 1024 });
  if (text === null) return [];
  return text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
}

// --- promote / rollback ------------------------------------------------
export function promoteCandidate(home, { candidateHash, holdoutName, maxRegression = 0.02 } = {}) {
  if (!HASH.test(candidateHash)) fail('INVALID_CANDIDATE_HASH');
  if (!Number.isFinite(maxRegression) || maxRegression < 0 || maxRegression > 1) fail('INVALID_PROMOTE_PARAMS');
  const qualification = loadQualification(home, candidateHash);
  if (!qualification) return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['QUALIFICATION_NOT_FOUND'] };
  if (qualification.checkpoint !== candidateHash) return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['QUALIFICATION_CHECKPOINT_MISMATCH'] };
  if (!qualification.qualified || !qualification.purposes.length) return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['NOT_QUALIFIED'] };
  const currentActive = activeLayaOf(home);
  const comparison = loadComparison(home, currentActive?.checkpoint ?? null, candidateHash, holdoutName);
  if (!comparison) return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['COMPARISON_NOT_FOUND'] };
  if (comparison.candidate !== candidateHash || comparison.active !== (currentActive?.checkpoint ?? null) || comparison.holdout !== holdoutName) {
    return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['COMPARISON_MISMATCH'] };
  }
  if (qualification.holdout !== holdoutName) return { promoted: false, reason: 'PROMOTION_REFUSED', violations: ['QUALIFICATION_HOLDOUT_MISMATCH'] };
  const violations = [];
  for (const purpose of qualification.purposes) {
    const row = comparison.purposes[purpose];
    if (!row?.candidate?.raw || !row.candidate.raw.n) { violations.push(`${purpose}:MISSING_CANDIDATE_RESULT`); continue; }
    if (row.active) {
      // Forgetting check on the same answers for both checkpoints.
      if (row.candidate.raw.accuracy < row.active.raw.accuracy - maxRegression) violations.push(`${purpose}:ACCURACY_REGRESSION`);
      if (row.active.qualified && row.active.selective && row.candidate.selective) {
        if (row.candidate.selective.accuracy < row.active.selective.accuracy - maxRegression) violations.push(`${purpose}:SELECTIVE_ACCURACY_REGRESSION`);
        if (row.candidate.selective.coverage < row.active.selective.coverage - maxRegression) violations.push(`${purpose}:COVERAGE_REGRESSION`);
      }
    }
  }
  if (violations.length) return { promoted: false, reason: 'PROMOTION_REFUSED', violations };
  const candidate = loadCandidate(home, candidateHash);
  const file = providersFile(home);
  const old = readText(file, { optional: true, privateFile: true });
  const currentConfig = old === null ? { version: 1, provider: 'jev', laya: null } : JSON.parse(old);
  const nextLaya = { ...candidate,
    startupTimeoutMs: currentConfig.laya?.startupTimeoutMs ?? 120000, idleTimeoutMs: currentConfig.laya?.idleTimeoutMs ?? 60000,
    qualification: { checkpoint: qualification.checkpoint, calibrationVersion: qualification.calibrationVersion, purposes: qualification.purposes,
      minConfidence: qualification.minConfidence, minChoiceProbability: qualification.minChoiceProbability, noulCertainty: qualification.noulCertainty } };
  const nextConfig = { ...currentConfig, laya: nextLaya }; // provider selection (jev/laya) is never changed here
  validateProviderConfig(structuredClone(nextConfig));
  atomicWrite(file, JSON.stringify(nextConfig, null, 2) + '\n', { expected: old });
  appendHistory(home, { action: 'promote', candidate: candidateHash, before: currentConfig.laya ?? null, after: nextLaya });
  return { promoted: true, checkpoint: candidateHash, previous: currentConfig.laya ?? null };
}
export function rollbackLaya(home) {
  // Promotes form a stack; each rollback pops one. A rollback never re-applies a checkpoint it removed,
  // so it cannot become a gate-free re-promotion.
  const stack = [];
  for (const entry of readHistory(home)) {
    if (entry.action === 'promote') stack.push(entry);
    else if (entry.action === 'rollback') stack.pop();
  }
  if (!stack.length) fail('NO_HISTORY_TO_ROLLBACK');
  const last = stack[stack.length - 1];
  const restored = last.before ?? null;
  const file = providersFile(home);
  const old = readText(file, { optional: true, privateFile: true });
  const currentConfig = old === null ? { version: 1, provider: 'jev', laya: null } : JSON.parse(old);
  if ((currentConfig.laya?.checkpoint ?? null) !== (last.after?.checkpoint ?? null)) fail('ROLLBACK_STATE_MISMATCH');
  const nextConfig = { ...currentConfig, laya: restored };
  atomicWrite(file, JSON.stringify(nextConfig, null, 2) + '\n', { expected: old });
  appendHistory(home, { action: 'rollback', candidate: null, before: currentConfig.laya ?? null, after: restored });
  return { rolledBack: true, restored };
}

// --- status ------------------------------------------------------------
export function layaStatus(home) {
  const active = activeLayaOf(home);
  const dir = candidatesDir(home);
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const c = JSON.parse(readText(path.join(dir, f), { privateFile: true, maxBytes: 8192 }));
    const q = loadQualification(home, c.checkpoint);
    return { checkpoint: c.checkpoint, model: c.model, device: c.device, qualified: q?.qualified ?? null, purposes: q?.purposes ?? [] };
  }) : [];
  return { active_checkpoint: active?.checkpoint ?? null, candidates, holdouts: listHoldouts(home) };
}
