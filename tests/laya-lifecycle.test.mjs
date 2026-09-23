import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readText } from '../src/storage.mjs';
import { digest } from '../src/training/schema.mjs';
import { buildDataset } from '../src/training/dataset.mjs';
import { fixture as trainingFixture, trace, outcome, REF } from './training-helpers.mjs';
import { registerCheckpoint, activateCandidate, freezeHoldout, listHoldouts, qualifyCandidate, compareCandidate,
  promoteCandidate, rollbackLaya, layaStatus, loadQualification } from '../src/training/laya-lifecycle.mjs';

// --- synthetic checkpoint fixture -------------------------------------------------
function makeCheckpointDir(root) {
  const dir = fs.mkdtempSync(path.join(root, 'ckpt-'));
  fs.writeFileSync(path.join(dir, 'model.safetensors'), 'weights');
  fs.writeFileSync(path.join(dir, 'rl_agent_config.json'), '{}');
  fs.mkdirSync(path.join(dir, 'encoder'));
  fs.writeFileSync(path.join(dir, 'encoder', 'config.json'), '{}');
  fs.mkdirSync(path.join(dir, 'tokenizer'));
  fs.writeFileSync(path.join(dir, 'tokenizer', 'tokenizer_config.json'), '{}');
  return dir;
}
// Deterministic stand-in for the offline `python -I workers/laya_worker.py --fingerprint`
// hashing step: hash the sorted file list, same shape contract (64-hex sha256), no python needed.
function fakeFingerprint(_python, dir) {
  const records = [];
  const walk = d => { for (const name of fs.readdirSync(d).sort()) { const p = path.join(d, name); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else records.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]); } };
  walk(dir);
  return digest(records);
}

// --- synthetic dataset fixture ----------------------------------------------------
// Splits are computed from digest('input:'+request_hash) for an isolated single-sample group,
// mirroring dataset.mjs groupedSplits(); reproduces the training-helpers.mjs splitFor() rule.
const splitFor = requestHash => { const n = parseInt(digest('input:' + requestHash).slice(0, 8), 16) % 100; return n < 80 ? 'train' : n < 90 ? 'calibration' : 'test'; };
function buildRequest(i, want, conf) {
  return { purpose: 'route', risk: 'routine', state: { task: `synthetic laya case ${i}`, want, conf },
    questions: { worker: { type: 'choice', instructions: 'Choose the worker for this bounded task.', criteria: { light: 'Narrow known scope', strong: 'Unclear or broad scope' } } } };
}
function findIndex(target, want, conf, cursor) {
  for (let i = cursor.n; i < cursor.n + 20000; i++) if (splitFor(digest(buildRequest(i, want, conf))) === target) { cursor.n = i + 1; return i; }
  throw new Error('NO_INDEX_FOUND');
}
// Builds a dataset with `count` (want, conf, truth) samples placed in `split`.
function addSamples(f, cursor, split, rows) {
  for (const { want, conf, truth } of rows) {
    const i = findIndex(split, want, conf, cursor);
    const r = buildRequest(i, want, conf);
    const d = { decision_id: randomUUID(), trace: trace(), arm: 'active', request: r, request_hash: digest(r),
      provenance: { provider: 'jev', model: 'jev-1.13.0', model_version: 'jev-1.13.0', checkpoint: 'jev-1.13.0',
        runtime_version: 'systemone-v1', preprocessing_version: 'wire-request-v1', confidence_semantics: 'reported-statistic' },
      answers: { worker: { type: 'choice', value: want, confidence: .9, selectedProbability: .9, probabilities: { light: want === 'light' ? .9 : .1, strong: want === 'strong' ? .9 : .1 } } },
      mode: 'on', apply: true, latency_ms: 10, usage: { inputTokens: 10, outputTokens: 0 },
      inference_calls: 1, network_calls: 1, capture_policy_version: 'minimal-state-v1' };
    f.save(d);
    f.store.outcome(outcome(d, { labels: [{ question_id: 'worker', value: truth, source: 'objective', label_confidence: .95, evidence_ref: REF }] }));
  }
}
// 5 correct@.95 + 5 incorrect@.55 in calibration: t=0.50 gives accuracy .5 (fails 0.75 target),
// t=0.56 excludes the .55 batch giving accuracy 1.0 (passes) -- exercises real grid search, not the t=0.50 edge.
function calibrationRows() {
  const rows = [];
  for (let k = 0; k < 5; k++) rows.push({ want: 'light', conf: .95, truth: 'light' });
  for (let k = 0; k < 5; k++) rows.push({ want: 'light', conf: .55, truth: 'strong' });
  return rows;
}
// 6 confident-correct + 2 low-confidence (excluded from coverage either way) per split.
function evalRows(strongAccuracy = true) {
  const rows = [];
  for (let k = 0; k < 6; k++) rows.push({ want: 'light', conf: .95, truth: strongAccuracy ? 'light' : 'strong' });
  for (let k = 0; k < 2; k++) rows.push({ want: 'light', conf: .3, truth: 'strong' });
  return rows;
}
function buildRouteDataset(f) {
  const cursor = { n: 0 };
  addSamples(f, cursor, 'calibration', calibrationRows());
  addSamples(f, cursor, 'test', evalRows(true));
  addSamples(f, cursor, 'test', [{ want: 'strong', conf: .99, truth: 'strong' }]); // filler for other purposes/type mix, ignored
  const built = buildDataset(f.store, { allowSmall: true });
  assert.equal(built.built, undefined, JSON.stringify(built));
  return built.dataset_version;
}

// --- fake Laya worker (deterministic; no python/network/training) -----------------
function fakeLayaClient() {
  let calls = 0;
  return {
    calls: () => calls,
    status: () => ({ running: false }), close: () => {}, prepare: async () => ({}),
    async infer(payload, settings) {
      calls++;
      const laya = settings.laya;
      const [qid, q] = Object.entries(payload.questions)[0];
      const want = payload.state.want, conf = payload.state.conf;
      const other = Object.keys(q.criteria).find(k => k !== want);
      // `confidence` and the choice distribution are independent fields in the real contract
      // (contracts.mjs normalizeResponse): pin the distribution's max share on the picked choice
      // (a valid distribution) and drive the calibration grid purely through `confidence`.
      return {
        identity: { model: laya.model, checkpoint: laya.checkpoint, runtime_version: laya.runtimeVersion, device: laya.device,
          precision: laya.precision === 'fp16' ? 'torch.float16' : 'torch.float32' },
        answers: { [qid]: { type: 'choice', choice: want, confidence: conf, probabilities: { [want]: .99, [other]: .01 } } },
        usage: { input_tokens: 5, output_tokens: 0 },
      };
    },
  };
}

function holdoutFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeProviders(home, config) { atomicWrite(path.join(home, 'providers.json'), JSON.stringify(config, null, 2) + '\n'); }

// ============================== register ==============================

test('register copies a checkpoint, fingerprints it, and never touches providers.json', t => {
  const root = holdoutFixture(t);
  const ckpt = makeCheckpointDir(root);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const before = fs.existsSync(path.join(home, 'providers.json')) ? readText(path.join(home, 'providers.json'), { optional: true }) : null;
  const r = registerCheckpoint(home, { checkpointDir: ckpt, model: 'laya/test', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  assert.match(r.checkpoint, /^[0-9a-f]{64}$/);
  assert.equal(r.reused, false);
  assert.ok(fs.existsSync(r.modelPath));
  assert.ok(fs.existsSync(path.join(r.modelPath, 'model.safetensors')));
  const candidate = JSON.parse(fs.readFileSync(r.candidate, 'utf8'));
  assert.equal(candidate.checkpoint, r.checkpoint);
  assert.equal(candidate.model, 'laya/test');
  assert.equal(candidate.device, 'cpu');
  assert.equal(candidate.runtimeVersion, '0.3.4');
  const after = fs.existsSync(path.join(home, 'providers.json')) ? readText(path.join(home, 'providers.json'), { optional: true }) : null;
  assert.equal(after, before);
});

test('register reuses an existing checkpoint copy after verifying the fingerprint matches', t => {
  const root = holdoutFixture(t);
  const ckpt = makeCheckpointDir(root);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const first = registerCheckpoint(home, { checkpointDir: ckpt, model: 'laya/one', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const second = registerCheckpoint(home, { checkpointDir: ckpt, model: 'laya/one', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  assert.equal(second.checkpoint, first.checkpoint);
  assert.equal(second.reused, true);
  assert.equal(second.modelPath, first.modelPath);
});

test('register refuses a symlinked checkpoint directory and requires configured python/device', t => {
  const root = holdoutFixture(t);
  const ckpt = makeCheckpointDir(root);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const link = path.join(root, 'ckpt-link');
  fs.symlinkSync(ckpt, link);
  assert.throws(() => registerCheckpoint(home, { checkpointDir: link, model: 'x', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint }), /UNSAFE_SYMLINK|LAYA_MODEL_SYMLINK_REFUSED/);
  assert.throws(() => registerCheckpoint(home, { checkpointDir: ckpt, model: 'x', device: 'cpu', fingerprintImpl: fakeFingerprint }), /LAYA_PYTHON_NOT_CONFIGURED/);
  assert.throws(() => registerCheckpoint(home, { checkpointDir: ckpt, model: 'x', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint }), /LAYA_DEVICE_REQUIRED/);
});

test('register falls back to the active providers.json python/device when not given explicitly', t => {
  const root = holdoutFixture(t);
  const ckpt = makeCheckpointDir(root);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  writeProviders(home, { version: 1, provider: 'laya', laya: { python: '/usr/bin/python3', modelPath: home, model: 'laya/base', checkpoint: 'a'.repeat(64), runtimeVersion: '0.3.4', device: 'mps' } });
  const r = registerCheckpoint(home, { checkpointDir: ckpt, model: 'laya/new', fingerprintImpl: fakeFingerprint });
  const candidate = JSON.parse(fs.readFileSync(r.candidate, 'utf8'));
  assert.equal(candidate.python, '/usr/bin/python3');
  assert.equal(candidate.device, 'mps');
});

test('register defaults precision to fp32, accepts an explicit --precision, and falls back to the active config otherwise', t => {
  const root = holdoutFixture(t);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const noConfig = registerCheckpoint(home, { checkpointDir: makeCheckpointDir(root), model: 'laya/p1', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  assert.equal(JSON.parse(fs.readFileSync(noConfig.candidate, 'utf8')).precision, 'fp32');
  const explicit = registerCheckpoint(home, { checkpointDir: makeCheckpointDir(root), model: 'laya/p2', device: 'cpu', python: '/usr/bin/python3', precision: 'fp16', fingerprintImpl: fakeFingerprint });
  assert.equal(JSON.parse(fs.readFileSync(explicit.candidate, 'utf8')).precision, 'fp16');
  writeProviders(home, { version: 1, provider: 'laya', laya: { python: '/usr/bin/python3', modelPath: home, model: 'laya/base', checkpoint: 'a'.repeat(64), runtimeVersion: '0.3.4', device: 'cpu', precision: 'fp16' } });
  const fromActive = registerCheckpoint(home, { checkpointDir: makeCheckpointDir(root), model: 'laya/p3', fingerprintImpl: fakeFingerprint });
  assert.equal(JSON.parse(fs.readFileSync(fromActive.candidate, 'utf8')).precision, 'fp16');
  assert.throws(() => registerCheckpoint(home, { checkpointDir: makeCheckpointDir(root), model: 'laya/p4', device: 'cpu', python: '/usr/bin/python3', precision: 'int8', fingerprintImpl: fakeFingerprint }), /INVALID_PROVIDER_CONFIG/);
});

// ============================== holdout ==============================

test('holdout freeze is immutable and content-hashed; freezing twice under the same name is refused', t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const first = freezeHoldout(f.home, { datasetVersion: version, name: 'shared' });
  assert.equal(first.sample_count, 9); // 8 evalRows() + 1 filler, all placed in the test split
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => freezeHoldout(f.home, { datasetVersion: version, name: 'shared' }), /HOLDOUT_ALREADY_EXISTS/);
  const list = listHoldouts(f.home);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shared');
  assert.equal(list[0].sample_count, first.sample_count);
  assert.equal(Object.keys(list[0]).includes('state') || Object.keys(list[0]).includes('samples'), false);
});

// ============================== qualify ==============================

test('qualify passes a purpose whose calibration threshold clears test+holdout, with no raw state in evidence', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const home = f.home;
  const reg = registerCheckpoint(home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/q', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const layaClient = fakeLayaClient();
  const result = await qualifyCandidate(home, { candidateHash: reg.checkpoint, datasetVersion: version, holdoutName: holdout.name, layaClient,
    targetAccuracy: .75, minCoverage: .3, minCalibration: 5, minTest: 5, minLowerBound: .5 });
  assert.equal(result.checkpoint, reg.checkpoint);
  assert.equal(result.qualified, true);
  assert.deepEqual(result.purposes, ['route']);
  assert.equal(result.minConfidence, .56);
  assert.equal(result.minChoiceProbability, .56);
  assert.equal(result.noulCertainty, .56);
  assert.equal(result.evidence.route.test.n, 7); // 6 confident correct + the confident filler, both >= 0.56
  assert.equal(result.evidence.route.test.accuracy, 1);
  assert.equal(result.evidence.route.holdout.n, 7);
  const raw = JSON.stringify(result);
  assert.ok(!raw.includes('synthetic laya case'));
  const stored = loadQualification(home, reg.checkpoint);
  assert.deepEqual(stored, result);
});

test('qualify fails a purpose when calibration sample count is below the minimum', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/q2', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const result = await qualifyCandidate(f.home, { candidateHash: reg.checkpoint, datasetVersion: version, holdoutName: holdout.name, layaClient: fakeLayaClient(),
    targetAccuracy: .75, minCoverage: .3, minCalibration: 999, minTest: 5, minLowerBound: .5 });
  assert.equal(result.qualified, false);
  assert.deepEqual(result.purposes, []);
  assert.equal(result.evidence.route.calibration.threshold, null);
});

test('qualify fails when the worker predicts wrong: accuracy never clears the target', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/bad', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const alwaysWrong = { ...fakeLayaClient(), async infer(payload, settings) {
    const laya = settings.laya; const [qid, q] = Object.entries(payload.questions)[0];
    const wrong = Object.keys(q.criteria).find(k => k !== payload.state.want);
    return { identity: { model: laya.model, checkpoint: laya.checkpoint, runtime_version: laya.runtimeVersion, device: laya.device, precision: 'torch.float32' },
      answers: { [qid]: { type: 'choice', choice: wrong, confidence: .95, probabilities: { [wrong]: .95, [payload.state.want]: .05 } } }, usage: { input_tokens: 1, output_tokens: 0 } };
  } };
  const result = await qualifyCandidate(f.home, { candidateHash: reg.checkpoint, datasetVersion: version, holdoutName: holdout.name, layaClient: alwaysWrong,
    targetAccuracy: .75, minCoverage: .3, minCalibration: 5, minTest: 5, minLowerBound: .5 });
  assert.equal(result.qualified, false);
});

// ============================== compare + promote ==============================

async function qualifiedCandidate(f, version, holdoutName, model = 'laya/promote-me') {
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model, device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const qual = await qualifyCandidate(f.home, { candidateHash: reg.checkpoint, datasetVersion: version, holdoutName, layaClient: fakeLayaClient(),
    targetAccuracy: .75, minCoverage: .3, minCalibration: 5, minTest: 5, minLowerBound: .5 });
  assert.equal(qual.qualified, true, JSON.stringify(qual));
  return { reg, qual };
}

test('qualify records the candidate precision, and promote carries it into providers.json laya + qualification', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))),
    model: 'laya/fp16', device: 'cpu', python: '/usr/bin/python3', precision: 'fp16', fingerprintImpl: fakeFingerprint });
  const qual = await qualifyCandidate(f.home, { candidateHash: reg.checkpoint, datasetVersion: version, holdoutName: holdout.name, layaClient: fakeLayaClient(),
    targetAccuracy: .75, minCoverage: .3, minCalibration: 5, minTest: 5, minLowerBound: .5 });
  assert.equal(qual.qualified, true, JSON.stringify(qual));
  assert.equal(qual.precision, 'fp16');
  await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  const promoted = promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  assert.equal(promoted.promoted, true, JSON.stringify(promoted));
  const providers = JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8'));
  assert.equal(providers.laya.precision, 'fp16');
  assert.equal(providers.laya.qualification.precision, 'fp16');
});

test('compare + promote (no active baseline) swaps providers.json laya, keeps provider selection, and logs history', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg, qual } = await qualifiedCandidate(f, version, holdout.name);
  const cmp = await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  assert.equal(cmp.active, null);
  assert.equal(cmp.candidate, reg.checkpoint);
  assert.equal(cmp.purposes.route.candidate.selective.accuracy, 1);
  assert.ok(cmp.purposes.route.candidate.raw.accuracy < 1); // low-confidence answers are included in raw
  const promoted = promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  assert.equal(promoted.promoted, true);
  const providers = JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8'));
  assert.equal(providers.provider, 'jev'); // provider selection is never changed by promote
  assert.equal(providers.laya.checkpoint, reg.checkpoint);
  assert.equal(providers.laya.qualification.checkpoint, reg.checkpoint);
  assert.deepEqual(providers.laya.qualification.purposes, qual.purposes);
  const history = fs.readFileSync(path.join(f.home, 'laya', 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'promote');
  assert.equal(history[0].before, null);
});

test('promote is refused without qualification, without a matching comparison report, or on checkpoint mismatch', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/unqualified', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const noQual = promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  assert.equal(noQual.promoted, false);
  assert.equal(noQual.reason, 'PROMOTION_REFUSED');
  assert.ok(noQual.violations.includes('QUALIFICATION_NOT_FOUND'));

  const { reg: reg2 } = await qualifiedCandidate(f, version, holdout.name);
  const noComparison = promoteCandidate(f.home, { candidateHash: reg2.checkpoint, holdoutName: holdout.name });
  assert.equal(noComparison.promoted, false);
  assert.ok(noComparison.violations.includes('COMPARISON_NOT_FOUND'));
});

test('promote is refused when the candidate regresses holdout accuracy past maxRegression vs. the active checkpoint', async t => {
  // Unit-level: hand-construct the qualification/comparison artifacts promote() reads, so the
  // regression gate is exercised directly instead of through a second full inference scenario.
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const activeReg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/active', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const activeQualification = { checkpoint: activeReg.checkpoint, calibrationVersion: 'v1', purposes: ['route'], minConfidence: .9, minChoiceProbability: .9, noulCertainty: .9 };
  writeProviders(f.home, { version: 1, provider: 'laya', laya: { ...JSON.parse(fs.readFileSync(activeReg.candidate, 'utf8')), qualification: activeQualification } });
  const reg2 = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/regressive', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  const qualPath = path.join(f.home, 'laya', 'qualifications', `${reg2.checkpoint}.json`);
  atomicWrite(qualPath, JSON.stringify({ checkpoint: reg2.checkpoint, qualified: true, purposes: ['route'], holdout: holdout.name,
    calibrationVersion: 'v1', minConfidence: .9, minChoiceProbability: .9, noulCertainty: .9 }, null, 2) + '\n');
  const comparisonPath = path.join(f.home, 'laya', 'comparisons', `${activeReg.checkpoint}__${reg2.checkpoint}__${holdout.name}.json`);
  atomicWrite(comparisonPath, JSON.stringify({ active: activeReg.checkpoint, candidate: reg2.checkpoint, holdout: holdout.name,
    purposes: { route: { active: { qualified: true, raw: { n: 10, coverage: 1, accuracy: .95 }, selective: { n: 10, coverage: 1, accuracy: .95 } },
      candidate: { qualified: true, raw: { n: 10, coverage: 1, accuracy: .5 }, selective: { n: 10, coverage: 1, accuracy: .5 } } } } }, null, 2) + '\n');
  const promoted = promoteCandidate(f.home, { candidateHash: reg2.checkpoint, holdoutName: holdout.name, maxRegression: .02 });
  assert.equal(promoted.promoted, false);
  assert.equal(promoted.reason, 'PROMOTION_REFUSED');
  assert.ok(promoted.violations.includes('route:ACCURACY_REGRESSION'));
  // providers.json must be unchanged after a refusal.
  const providers = JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8'));
  assert.equal(providers.laya.checkpoint, activeReg.checkpoint);
});

// ============================== rollback ==============================

test('rollback restores the laya block active before the last promote/rollback; refuses with no history', async t => {
  const f = trainingFixture(t);
  assert.throws(() => rollbackLaya(f.home), /NO_HISTORY_TO_ROLLBACK/);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg } = await qualifiedCandidate(f, version, holdout.name);
  await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  const rolled = rollbackLaya(f.home);
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.restored, null);
  const providers = JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8'));
  assert.equal(providers.laya, null);
  assert.equal(providers.provider, 'jev');
});

// ============================== status ==============================

test('status reports active checkpoint, candidate qualification state, and holdout metadata without sample content', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const { reg } = await qualifiedCandidate(f, version, holdout.name);
  const status = layaStatus(f.home);
  assert.equal(status.active_checkpoint, null);
  assert.equal(status.candidates.length, 1);
  assert.equal(status.candidates[0].checkpoint, reg.checkpoint);
  assert.equal(status.candidates[0].qualified, true);
  assert.equal(status.holdouts.length, 1);
  assert.equal(status.holdouts[0].name, 'h1');
});

test('rollback walks back promotes like a stack and can never re-apply a rolled-back checkpoint', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg: a } = await qualifiedCandidate(f, version, holdout.name, 'laya/a');
  await compareCandidate(f.home, { candidateHash: a.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  assert.equal(promoteCandidate(f.home, { candidateHash: a.checkpoint, holdoutName: holdout.name }).promoted, true);
  const { reg: b } = await qualifiedCandidate(f, version, holdout.name, 'laya/b');
  await compareCandidate(f.home, { candidateHash: b.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient() });
  assert.equal(promoteCandidate(f.home, { candidateHash: b.checkpoint, holdoutName: holdout.name }).promoted, true);
  const active = () => JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8')).laya?.checkpoint ?? null;
  assert.equal(active(), b.checkpoint);
  rollbackLaya(f.home); assert.equal(active(), a.checkpoint);
  rollbackLaya(f.home); assert.equal(active(), null);
  // A third rollback must not "undo the rollback" and silently re-promote a checkpoint without its gates.
  assert.throws(() => rollbackLaya(f.home), /NO_HISTORY_TO_ROLLBACK/);
  assert.equal(active(), null);
});
test('rollback refuses when providers.json no longer holds the checkpoint the last promote installed', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg } = await qualifiedCandidate(f, version, holdout.name);
  await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  assert.throws(() => rollbackLaya(f.home), /ROLLBACK_STATE_MISMATCH/);
});
test('promote requires the qualification and the comparison to use the same fixed holdout', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const h1 = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const h2 = freezeHoldout(f.home, { datasetVersion: version, name: 'h2' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg } = await qualifiedCandidate(f, version, h1.name);
  await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: h2.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  const r = promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: h2.name });
  assert.equal(r.promoted, false);
  assert.ok(r.violations.includes('QUALIFICATION_HOLDOUT_MISMATCH'));
});
test('an unqualified active checkpoint is compared on raw holdout accuracy, not on an incomparable coverage', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  const baseReg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/base', device: 'cpu', python: '/usr/bin/python3', fingerprintImpl: fakeFingerprint });
  // Active base checkpoint without any qualification block (the usual first-fine-tune situation).
  writeProviders(f.home, { version: 1, provider: 'jev', laya: JSON.parse(fs.readFileSync(baseReg.candidate, 'utf8')) });
  const { reg } = await qualifiedCandidate(f, version, holdout.name, 'laya/first-finetune');
  const cmp = await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient() });
  assert.equal(cmp.purposes.route.active.qualified, false);
  assert.ok(cmp.purposes.route.active.raw.n > 0);
  const r = promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name });
  assert.equal(r.promoted, true, JSON.stringify(r));
});

test('a promoted providers.json is loadable by the runtime provider loader', async t => {
  const f = trainingFixture(t);
  const version = buildRouteDataset(f);
  const holdout = freezeHoldout(f.home, { datasetVersion: version, name: 'h1' });
  writeProviders(f.home, { version: 1, provider: 'jev' });
  const { reg } = await qualifiedCandidate(f, version, holdout.name);
  await compareCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name, layaClient: fakeLayaClient(), noActiveBaseline: true });
  assert.equal(promoteCandidate(f.home, { candidateHash: reg.checkpoint, holdoutName: holdout.name }).promoted, true);
  const { loadProviderConfig } = await import('../src/inference.mjs');
  const c = loadProviderConfig(f.home);
  assert.equal(c.laya.checkpoint, reg.checkpoint);
  assert.ok(c.laya.qualification.calibrationVersion.length <= 80);
});

test('CLI laya register accepts --python so the first checkpoint can be registered before providers.json has a laya block', t => {
  const f = trainingFixture(t);
  const ckpt = makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-'))));
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const bin = fileURLToPath(new URL('../bin/jev-control.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'laya', 'register', '--checkpoint', ckpt, '--python', python, '--device', 'cpu', '--precision', 'fp16', '--home', f.home],
    { encoding: 'utf8', env: { ...process.env, HOME: f.home, JEV_HOME: f.home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const candidate = JSON.parse(fs.readFileSync(out.candidate, 'utf8'));
  assert.equal(candidate.python, python);
  assert.equal(candidate.precision, 'fp16');
  assert.equal(fs.existsSync(path.join(f.home, 'providers.json')), false); // register never activates
  const bad = spawnSync(process.execPath, [bin, 'laya', 'register', '--checkpoint', ckpt, '--python', 'relative/python', '--device', 'cpu', '--home', f.home],
    { encoding: 'utf8', env: { ...process.env, HOME: f.home, JEV_HOME: f.home } });
  assert.notEqual(bad.status, 0);
});

test('laya activate installs an unqualified candidate for shadow/data collection only and is undone by rollback', t => {
  const f = trainingFixture(t);
  const reg = registerCheckpoint(f.home, { checkpointDir: makeCheckpointDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-')))), model: 'laya/base', device: 'cpu', python: '/usr/bin/python3', precision: 'fp16', fingerprintImpl: fakeFingerprint });
  const r = activateCandidate(f.home, { candidateHash: reg.checkpoint });
  assert.equal(r.activated, true); assert.equal(r.qualified, false);
  const providers = JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8'));
  assert.equal(providers.provider, 'jev'); // provider selection is a separate explicit command
  assert.equal(providers.laya.checkpoint, reg.checkpoint);
  assert.equal(providers.laya.precision, 'fp16');
  assert.equal(providers.laya.qualification, undefined); // never applied in ON without a qualification
  // An active qualified checkpoint is never silently replaced by an unqualified one.
  writeProviders(f.home, { ...providers, laya: { ...providers.laya, qualification: { checkpoint: reg.checkpoint, calibrationVersion: 'v1', purposes: ['route'], minConfidence: .9, minChoiceProbability: .9, noulCertainty: .9 } } });
  assert.throws(() => activateCandidate(f.home, { candidateHash: reg.checkpoint }), /ACTIVE_CHECKPOINT_QUALIFIED/);
  writeProviders(f.home, providers);
  rollbackLaya(f.home);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'providers.json'), 'utf8')).laya, null);
});
