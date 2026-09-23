import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROUTE_QUESTIONS } from '../src/routing.mjs';
import { readDataset, exportDataset } from '../src/training/dataset.mjs';
import { freezeHoldout, qualifyCandidate } from '../src/training/laya-lifecycle.mjs';
import { createTrainingStore } from '../src/training/store.mjs';
import { digest, encode } from '../src/training/schema.mjs';
import { setMode, atomicWrite } from '../src/storage.mjs';
import {
  distillImport, distillImportShadow, distillLabel, distillReview, buildDistillDataset, distillStatus, runDir,
} from '../src/training/laya-distill.mjs';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-distill-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function writeInputFile(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-distill-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
function choiceProbs(criteria, picked) {
  const keys = Object.keys(criteria);
  const other = keys.length > 1 ? (1 - 0.82) / (keys.length - 1) : 0;
  return Object.fromEntries(keys.map(k => [k, k === picked ? 0.82 : other]));
}
function scoreProbs(pickIndex, n) {
  const other = n > 1 ? 0.2 / (n - 1) : 0;
  const probs = {};
  for (let i = 0; i < n; i++) probs[String(i)] = i === pickIndex ? 0.8 : other;
  return probs;
}
function teacherRaw(model, picks = { intent: 'edit', difficulty: 1, risk: 'safe' }) {
  const intentProbs = choiceProbs(ROUTE_QUESTIONS.intent.criteria, picks.intent);
  const riskProbs = choiceProbs(ROUTE_QUESTIONS.risk.criteria, picks.risk);
  const diffProbs = scoreProbs(picks.difficulty, ROUTE_QUESTIONS.difficulty.criteria.length);
  const diffScore = Object.entries(diffProbs).reduce((s, [k, p]) => s + Number(k) * p, 0);
  return {
    model, usage: { input_tokens: 12, output_tokens: 3},
    answers: {
      intent: { type: 'choice', choice: picks.intent, confidence: .9, probabilities: intentProbs },
      difficulty: { type: 'score', score: diffScore, confidence: .9, probabilities: diffProbs },
      risk: { type: 'choice', choice: picks.risk, confidence: .9, probabilities: riskProbs },
    },
  };
}
function fakeProvider(picks) {
  return async () => teacherRaw('jev-1.13.0', picks);
}

// ============================== import ==============================

test('distill import validates schema, screens sensitive lines, and deduplicates by normalized text', t => {
  const home = fixture(t);
  const file = writeInputFile(t, [
    { lang: 'en', task: 'Explain how the router chooses a tier' },
    { lang: 'en', task: 'Explain how the router chooses a tier' }, // duplicate (exact)
    { lang: 'en', task: '  Explain   how the router  chooses a tier ' }, // duplicate (normalized)
    { lang: 'ko', domain: 'billing', task: '결제 모듈의 실패 원인을 분석해줘' },
    { lang: 'en', task: 'api_key=sk-abcdefghijklmnop123456 leaked in logs' }, // sensitive
  ]);
  const r = distillImport(home, { run: 'run1', inputFile: file });
  assert.equal(r.total, 5);
  assert.equal(r.added, 2);
  assert.equal(r.skippedDuplicate, 2);
  assert.equal(r.skippedSensitive, 1);
  const lines = fs.readFileSync(path.join(runDir(home, 'run1'), 'tasks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.source === 'synthetic' && l.egress === 'allowed'));
  assert.match(lines[0].task_id, /^[0-9a-f]{64}$/);
});

test('distill import rejects malformed lines and out-of-range language/length', t => {
  const home = fixture(t);
  assert.throws(() => distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [{ lang: 'fr', task: 'x' }]) }), /INVALID_DISTILL_TASK_LINE/);
  assert.throws(() => distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [{ lang: 'en', task: '' }]) }), /INVALID_DISTILL_TASK_LINE/);
  assert.throws(() => distillImport(home, { run: 'not a valid run name', inputFile: writeInputFile(t, [{ lang: 'en', task: 'x' }]) }), /INVALID_DISTILL_RUN/);
});

test('distill import uses a UTF-8 byte limit of 8000 (matching the hook truncateUtf8 cap), not a character count', t => {
  const home = fixture(t);
  // Long owner-authored Korean prompts (~2,500 chars) are well over the old 2000-char cap but
  // comfortably under 8000 bytes; the hook (src/hooks.mjs truncateUtf8) uses the same 8000-byte cap.
  const koreanTask = '작업 지시문 한국어 문장입니다. '.repeat(150).trim().slice(0, 2500);
  assert.ok(Buffer.byteLength(koreanTask) > 2000 && Buffer.byteLength(koreanTask) <= 8000);
  const r = distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [{ lang: 'ko', task: koreanTask }]) });
  assert.equal(r.added, 1);
  const asciiUnder = 'x'.repeat(2001); // over the OLD char cap, well under the new byte cap
  const r2 = distillImport(home, { run: 'run2', inputFile: writeInputFile(t, [{ lang: 'en', task: asciiUnder }]) });
  assert.equal(r2.added, 1);
  const overByteLimit = 'x'.repeat(8001);
  assert.throws(() => distillImport(home, { run: 'run3', inputFile: writeInputFile(t, [{ lang: 'en', task: overByteLimit }]) }), /INVALID_DISTILL_TASK_LINE/);
  const koreanOverByteLimit = '작업'.repeat(3000); // multi-byte chars pushing well past 8000 bytes
  assert.throws(() => distillImport(home, { run: 'run4', inputFile: writeInputFile(t, [{ lang: 'ko', task: koreanOverByteLimit }]) }), /INVALID_DISTILL_TASK_LINE/);
});

test('distill import-shadow pulls captured route task text with forbidden egress and skips non-route captures', t => {
  const home = fixture(t);
  setMode(home, 'on', {});
  const store = createTrainingStore({ home });
  store.setCapture(true);
  const routeRequest = { purpose: 'route', risk: 'routine', state: { task: 'Investigate a flaky CI job', context: { complete: true, scope: 'local', previousFailures: 0, highImpact: false, modelLocked: false, exhaustive: false } }, questions: ROUTE_QUESTIONS };
  const otherRequest = { purpose: 'judge', risk: 'routine', state: { task: 'unrelated judge task' }, questions: { ok: { type: 'noul', instructions: 'ok?' } } };
  for (const [request, purpose] of [[routeRequest, 'route'], [otherRequest, 'judge']]) {
    const r = store.decision({
      decision_id: randomUUID(), trace: { task_id: randomUUID(), snapshot_id: digest('s') }, arm: 'active', request, request_hash: digest(request),
      provenance: { provider: 'jev', model: 'jev-1.13.0', model_version: 'jev-1.13.0', checkpoint: 'jev-1.13.0', runtime_version: 'systemone-v1', preprocessing_version: 'wire-request-v1', confidence_semantics: 'reported-statistic' },
      answers: purpose === 'route'
        ? { intent: { type: 'choice', value: 'debug', confidence: .9, selectedProbability: .82, probabilities: choiceProbs(ROUTE_QUESTIONS.intent.criteria, 'debug') },
            difficulty: { type: 'score', value: 2, confidence: .9, probabilities: scoreProbs(2, 5) },
            risk: { type: 'choice', value: 'safe', confidence: .9, selectedProbability: .82, probabilities: choiceProbs(ROUTE_QUESTIONS.risk.criteria, 'safe') } }
        : { ok: { type: 'noul', value: true, probabilityTrue: .9, confidence: null } },
      mode: 'on', apply: true, latency_ms: 5, usage: { inputTokens: 1, outputTokens: 1 }, inference_calls: 1, network_calls: 1, capture_policy_version: 'minimal-state-v1',
    });
    assert.ok(r.stored, JSON.stringify(r));
  }
  const result = distillImportShadow(home, { run: 'run1' });
  assert.equal(result.scannedDecisions, 1);
  assert.equal(result.added, 1);
  const lines = fs.readFileSync(path.join(runDir(home, 'run1'), 'tasks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source, 'shadow');
  assert.equal(lines[0].egress, 'forbidden');
  assert.equal(lines[0].task, 'Investigate a flaky CI job');
});

// ============================== label ==============================

test('distill label refuses without --confirm-egress and never calls the provider', async t => {
  const home = fixture(t);
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [{ lang: 'en', task: 'Add a unit test for the parser' }]) });
  let called = false;
  await assert.rejects(distillLabel(home, { run: 'run1', confirmEgress: false, key: 'k', provider: async () => { called = true; return teacherRaw('jev-1.13.0'); } }), /EXPLICIT_REMOTE_TEACHER_CONSENT_REQUIRED/);
  assert.equal(called, false);
});

test('distill label calls only egress-allowed unlabeled tasks, records probabilities and usage, and is idempotent', async t => {
  const home = fixture(t);
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [
    { lang: 'en', task: 'Add a unit test for the parser' },
    { lang: 'ko', task: '파서에 단위 테스트를 추가해줘' },
  ]) });
  distillImportShadow(home, { run: 'run1' }); // no captures yet; still exercises the egress:'forbidden' exclusion path once present
  let calls = 0;
  const r1 = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => { calls++; return teacherRaw('jev-1.13.0'); }, sleepImpl: async () => {} });
  assert.equal(r1.eligible, 2);
  assert.equal(r1.succeeded, 2);
  assert.equal(calls, 2);
  const teacherLines = fs.readFileSync(path.join(runDir(home, 'run1'), 'teacher.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(teacherLines.length, 2);
  assert.ok(teacherLines.every(l => l.answers.intent.probabilities && l.answers.difficulty.probabilities && l.answers.risk.probabilities));
  assert.equal(teacherLines[0].usage.inputTokens, 12);
  const r2 = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => { calls++; return teacherRaw('jev-1.13.0'); }, sleepImpl: async () => {} });
  assert.equal(r2.eligible, 0);
  assert.equal(calls, 2); // no re-labeling of already-labeled tasks
});

test('distill label spaces calls to respect <=50/minute and never retries a failed call automatically', async t => {
  const home = fixture(t);
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [
    { lang: 'en', task: 'task one' }, { lang: 'en', task: 'task two' }, { lang: 'en', task: 'task three' },
  ]) });
  let clock = 1000000;
  const calledAt = [];
  let callNumber = 0;
  const provider = async () => {
    callNumber++;
    calledAt.push(clock);
    if (callNumber === 2) fail_forcedProviderError();
    return teacherRaw('jev-1.13.0');
  };
  function fail_forcedProviderError() { throw new Error('PROVIDER_REJECTED'); }
  const sleeps = [];
  const r = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider,
    now: () => clock, sleepImpl: async ms => { sleeps.push(ms); clock += ms; } });
  assert.equal(r.attempted, 3);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  assert.ok(sleeps.length >= 2);
  assert.ok(sleeps.every(ms => ms >= 1199)); // >=1200ms spacing for <=50 calls/minute
  const failures = fs.readFileSync(path.join(runDir(home, 'run1'), 'teacher-failures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].code);
  assert.equal(Object.keys(failures[0]).includes('task'), false);
});

test('distill label resumes a failed task on the next run without re-attempting succeeded ones', async t => {
  const home = fixture(t);
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, [{ lang: 'en', task: 'flaky task' }]) });
  const r1 = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => { throw new Error('boom'); }, sleepImpl: async () => {} });
  assert.equal(r1.failed, 1);
  assert.equal(r1.succeeded, 0);
  const r2 = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  assert.equal(r2.eligible, 1); // the failed task is retried since no teacher label was written
  assert.equal(r2.succeeded, 1);
  const status = distillStatus(home, { run: 'run1' });
  assert.equal(status.teacher_labels, 1);
  assert.equal(status.teacher_label_failures, 1);
});

test('distill label stops the batch after 5 consecutive failures, keeps already-recorded results, and reports abortReason', async t => {
  const home = fixture(t);
  const lines = Array.from({ length: 8 }, (_, i) => ({ lang: 'en', task: `task ${i}` }));
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, lines) });
  let call = 0;
  // succeeds twice, then fails 5 times in a row (>= the breaker threshold), then would succeed again
  const provider = async () => {
    call++;
    if (call <= 2 || call > 7) return teacherRaw('jev-1.13.0');
    throw new Error('PROVIDER_DOWN');
  };
  const r = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider, sleepImpl: async () => {} });
  assert.equal(r.aborted, true);
  assert.ok(r.abortReason);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 5);
  assert.equal(r.attempted, 7); // stopped after the 5th consecutive failure, task 8 never attempted
  const status = distillStatus(home, { run: 'run1' });
  assert.equal(status.teacher_labels, 2); // already-recorded successes are preserved
  assert.equal(status.teacher_label_failures, 5);
  // rerun resumes: the 2 succeeded tasks are skipped, the 5 failed + 1 never-attempted are retried
  const r2 = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  assert.equal(r2.eligible, 6);
  assert.equal(r2.succeeded, 6);
  assert.equal(r2.aborted, false);
});

test('distill label does not abort when failures are not consecutive (a success resets the streak)', async t => {
  const home = fixture(t);
  const lines = Array.from({ length: 6 }, (_, i) => ({ lang: 'en', task: `task ${i}` }));
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, lines) });
  let call = 0;
  const provider = async () => {
    call++;
    if (call % 2 === 0) throw new Error('boom'); // fails on even calls, succeeds on odd: never 5 in a row
    return teacherRaw('jev-1.13.0');
  };
  const r = await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider, sleepImpl: async () => {} });
  assert.equal(r.aborted, false);
  assert.equal(r.abortReason, null);
  assert.equal(r.attempted, 6);
});

test('two concurrent distill label runs on the same run do not both call the teacher', async t => {
  const home = fixture(t);
  const lines = Array.from({ length: 4 }, (_, i) => ({ lang: 'en', task: `task ${i}` }));
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, lines) });
  let inFlight = 0, maxInFlight = 0;
  const provider = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 10));
    inFlight--;
    return teacherRaw('jev-1.13.0');
  };
  const run = () => distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider, sleepImpl: async () => {} });
  const [a, b] = await Promise.allSettled([run(), run()]);
  const outcomes = [a, b];
  const rejected = outcomes.filter(o => o.status === 'rejected');
  const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
  assert.equal(rejected.length, 1); // the second concurrent run is refused, not silently interleaved
  assert.match(rejected[0].reason.message, /DISTILL_LOCKED/);
  assert.equal(fulfilled.length, 1);
  assert.equal(maxInFlight, 1); // the teacher is never called from two runs at once
});

// ============================== review ==============================

function labeledFixture(t, count = 6) {
  const home = fixture(t);
  const lines = [];
  for (let i = 0; i < count; i++) lines.push({ lang: i % 2 === 0 ? 'ko' : 'en', task: `${i % 2 === 0 ? '한국어 작업' : 'english task'} number ${i}` });
  distillImport(home, { run: 'run1', inputFile: writeInputFile(t, lines) });
  return home;
}
function fakePromptQueue(answers) {
  let i = 0;
  return async () => answers[i++] ?? '';
}

test('review requires a TTY on both stdin and stdout', async t => {
  const home = labeledFixture(t, 2);
  await assert.rejects(distillReview(home, { run: 'run1', isStdinTTY: false, isStdoutTTY: true, prompt: async () => '' }), /HUMAN_TTY_REQUIRED/);
  await assert.rejects(distillReview(home, { run: 'run1', isStdinTTY: true, isStdoutTTY: false, prompt: async () => '' }), /HUMAN_TTY_REQUIRED/);
});

test('review accepts teacher defaults on Enter, overrides with a typed label, skips, and is stratified by language', async t => {
  const home = labeledFixture(t, 4); // 2 ko + 2 en
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0', { intent: 'edit', difficulty: 1, risk: 'safe' }), sleepImpl: async () => {} });
  const written = [];
  const result = await distillReview(home, { run: 'run1', count: 4, isStdinTTY: true, isStdoutTTY: true, write: t => written.push(t),
    prompt: fakePromptQueue(['', '', '', 'edit', '3', 'high', 's', '', '']) }); // task1: accept all; task2: override all; task3: skip; task4: accept all
  assert.equal(result.selected, 4);
  assert.ok(result.reviewed >= 2);
  const lines = fs.readFileSync(path.join(runDir(home, 'run1'), 'review.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.every(l => l.reviewer === 'human-tty'));
  const overridden = lines.find(l => l.labels.intent === 'edit' && l.labels.risk === 'high');
  assert.ok(overridden);
  assert.equal(overridden.labels.difficulty, 2); // typed "3" (1-based) -> 0-based 2
});

test('review is resumable: an interrupted (quit) session leaves unreviewed tasks pending for the next call', async t => {
  const home = labeledFixture(t, 4);
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  const first = await distillReview(home, { run: 'run1', count: 4, isStdinTTY: true, isStdoutTTY: true,
    prompt: fakePromptQueue(['', '', '', 'q']) }); // accept task1 fully, quit mid-task2
  assert.equal(first.reviewed, 1);
  assert.equal(first.quit, true);
  const second = await distillReview(home, { run: 'run1', count: 4, isStdinTTY: true, isStdoutTTY: true,
    prompt: fakePromptQueue(['', '', '', '', '', '', '']) });
  assert.equal(second.reviewed, 3); // the remaining 3 tasks, not re-reviewing the first
  const lines = fs.readFileSync(path.join(runDir(home, 'run1'), 'review.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(new Set(lines.map(l => l.task_id)).size, 4);
});

// ============================== build ==============================

test('build: teacher-only tasks ground train with soft targets; reviewed tasks ground calibration/test and are excluded from train', async t => {
  const home = labeledFixture(t, 8); // 4 ko + 4 en
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0', { intent: 'edit', difficulty: 2, risk: 'safe' }), sleepImpl: async () => {} });
  const written = [];
  await distillReview(home, { run: 'run1', count: 4, isStdinTTY: true, isStdoutTTY: true, write: t => written.push(t),
    prompt: fakePromptQueue(Array(2 * 3).fill('')) }); // review only the first 2 selected (1 ko + 1 en) worth of answers
  const built = buildDistillDataset(home, { run: 'run1' });
  assert.match(built.dataset_version, /^[0-9a-f]{64}$/);
  const store = createTrainingStore({ home });
  const { samples } = readDataset(store, built.dataset_version);
  assert.equal(samples.length, built.sample_count);
  const trainTasks = new Set(samples.filter(s => s.split === 'train').map(s => s.task_id));
  const evalTasks = new Set(samples.filter(s => s.split !== 'train').map(s => s.task_id));
  for (const id of evalTasks) assert.equal(trainTasks.has(id), false); // no leakage: a reviewed task never also appears in train
  const trainSample = samples.find(s => s.split === 'train');
  assert.equal(trainSample.label_source, 'teacher');
  const sum = Object.values(trainSample.target.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) <= 0.02);
  assert.notEqual(encode(trainSample.target.probabilities).includes('"1"') && Object.values(trainSample.target.probabilities).filter(v => v === 1).length, 1); // soft, not one-hot
  const evalSample = samples.find(s => s.split !== 'train');
  assert.equal(evalSample.label_source, 'human');
  assert.equal(evalSample.label_confidence, 1);
});

test('build is idempotent and writes into the shared training store root usable by export/holdout', async t => {
  const home = labeledFixture(t, 6);
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  await distillReview(home, { run: 'run1', count: 4, isStdinTTY: true, isStdoutTTY: true, prompt: fakePromptQueue(Array(6).fill('')) });
  const first = buildDistillDataset(home, { run: 'run1' });
  const second = buildDistillDataset(home, { run: 'run1' });
  assert.equal(first.dataset_version, second.dataset_version);
  const store = createTrainingStore({ home });
  const holdout = freezeHoldout(home, { datasetVersion: first.dataset_version, name: 'distill-holdout', store });
  assert.ok(holdout.sample_count >= 0);
  const laya = exportDataset(store, first.dataset_version, 'laya');
  assert.equal(laya.dataset_version, first.dataset_version);
});

test('distill status reports counts only, never task content', async t => {
  const home = labeledFixture(t, 3);
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  const status = distillStatus(home, { run: 'run1' });
  assert.equal(status.tasks, 3);
  assert.equal(status.teacher_labels, 3);
  assert.equal(JSON.stringify(status).match(/task/gi)?.length > 0, true); // only field NAMES like "tasks"/"teacher_labels", not sentence content
  assert.equal(JSON.stringify(status).includes('한국어'), false);
  assert.equal(JSON.stringify(status).includes('english task'), false);
});

// ============================== readDataset extension ==============================

test('readDataset rejects a teacher-sourced label placed outside the train split', async t => {
  const home = labeledFixture(t, 2);
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  const built = buildDistillDataset(home, { run: 'run1' });
  const store = createTrainingStore({ home });
  const canonicalPath = path.join(store.root, 'datasets', built.dataset_version, 'canonical.jsonl');
  const lines = fs.readFileSync(canonicalPath, 'utf8').trim().split('\n').map(JSON.parse);
  const tampered = lines.map(l => l.split === 'train' ? { ...l, split: 'test' } : l);
  const tamperedText = tampered.map(l => JSON.stringify(l)).join('\n') + '\n';
  atomicWrite(canonicalPath, tamperedText);
  const manifestPath = path.join(store.root, 'manifests', `${built.dataset_version}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.data_sha256 = digest(tamperedText);
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => readDataset(store, built.dataset_version), /TEACHER_LABEL_IN_EVAL_SPLIT/);
});

test('every readDataset consumer (freezeHoldout, qualify) refuses a dataset whose eval rows carry a teacher label', async t => {
  const home = labeledFixture(t, 2);
  await distillLabel(home, { run: 'run1', confirmEgress: true, key: 'k', provider: async () => teacherRaw('jev-1.13.0'), sleepImpl: async () => {} });
  const built = buildDistillDataset(home, { run: 'run1' });
  const store = createTrainingStore({ home });
  const canonicalPath = path.join(store.root, 'datasets', built.dataset_version, 'canonical.jsonl');
  const lines = fs.readFileSync(canonicalPath, 'utf8').trim().split('\n').map(JSON.parse);
  const tampered = lines.map(l => l.split === 'train' ? { ...l, split: 'calibration' } : l);
  const tamperedText = tampered.map(l => JSON.stringify(l)).join('\n') + '\n';
  atomicWrite(canonicalPath, tamperedText);
  const manifestPath = path.join(store.root, 'manifests', `${built.dataset_version}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.data_sha256 = digest(tamperedText);
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => freezeHoldout(home, { datasetVersion: built.dataset_version, name: 'h1', store }), /TEACHER_LABEL_IN_EVAL_SPLIT/);
  const checkpoint = 'a'.repeat(64);
  atomicWrite(path.join(home, 'laya', 'candidates', `${checkpoint}.json`),
    JSON.stringify({ python: '/usr/bin/python3', modelPath: home, model: 'laya/base', checkpoint, runtimeVersion: '0.3.4', device: 'cpu', precision: 'fp32' }, null, 2) + '\n');
  await assert.rejects(qualifyCandidate(home, { candidateHash: checkpoint, datasetVersion: built.dataset_version, holdoutName: 'h1',
    layaClient: { infer: async () => ({}) } }), /TEACHER_LABEL_IN_EVAL_SPLIT|HOLDOUT/);
});
