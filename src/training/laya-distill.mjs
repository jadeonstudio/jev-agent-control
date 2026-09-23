// Teacher (Jev/TypeSafe) distillation + human-review pipeline for Laya route training (2026-09-23 owner decision).
// Teacher labels ground ONLY the train split; calibration/test/holdout accept human review only. Only
// synthetic (owner-authored) task sentences are ever sent to the remote teacher; captured shadow task
// text is imported with egress:'forbidden' and never leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { noSymlinks, ensureDir, readText } from '../storage.mjs';
import { ID, fail, errorCode } from '../constants.mjs';
import { validateRequest, wireRequest, normalizeResponse, containsSensitiveData } from '../contracts.mjs';
import { callTypeSafe } from '../provider.mjs';
import { getCredential, loadConfig } from '../storage.mjs';
import { loadFeaturePolicy } from '../feature-policy.mjs';
import { ROUTE_QUESTIONS } from '../routing.mjs';
import { createTrainingStore } from './store.mjs';
import { POLICY_VERSION, digest, encode, only, text, safeContent, targetDistribution, validateTarget } from './schema.mjs';
import { EVALUATION_POLICY } from './evaluate.mjs';

// route requests always use this fixed context so routeGuard would let a real spawn reach the model;
// teacher/train/inference inputs for distillation must match that exact shape (see plan doc "핵심 사실").
export const FIXED_ROUTE_CONTEXT = Object.freeze({ complete: true, scope: 'local', previousFailures: 0, highImpact: false, modelLocked: false, exhaustive: false });
export const TEACHER_LABEL_CONFIDENCE = EVALUATION_POLICY.minLabelConfidence; // trust-in-source floor for unreviewed teacher output, not the model's own probability
const MIN_CALL_INTERVAL_MS = 1200; // <=50 calls/minute

export function validateRunName(run) { if (typeof run !== 'string' || !ID.test(run)) fail('INVALID_DISTILL_RUN'); }

function distillRoot(home) { return path.join(home, 'laya', 'distill'); }
export function runDir(home, run) { validateRunName(run); return path.join(distillRoot(home), run); }
function ensureRunDir(home, run) {
  validateRunName(run);
  ensureDir(home, true);
  ensureDir(path.join(home, 'laya'), true);
  ensureDir(distillRoot(home), true);
  const dir = path.join(distillRoot(home), run);
  ensureDir(dir, true);
  return dir;
}
function withRunLock(dir, fn) {
  const lockDir = path.join(dir, '.lock');
  noSymlinks(lockDir);
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('DISTILL_LOCKED'); throw e; }
  try { return fn(); } finally { fs.rmdirSync(lockDir); }
}
function appendPrivateJsonl(file, obj) {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_FILE');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('WRONG_OWNER');
    if (stat.mode & 0o077) fail('PRIVATE_FILE_REQUIRED');
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function readPrivateJsonl(file, maxBytes = 64 * 1024 * 1024) {
  const t = readText(file, { optional: true, privateFile: true, maxBytes });
  if (t === null) return [];
  return t.trim() ? t.trim().split('\n').map(line => JSON.parse(line)) : [];
}
const tasksFile = dir => path.join(dir, 'tasks.jsonl');
const teacherFile = dir => path.join(dir, 'teacher.jsonl');
const teacherFailuresFile = dir => path.join(dir, 'teacher-failures.jsonl');
const reviewFile = dir => path.join(dir, 'review.jsonl');

function normalizeTaskText(s) { return s.trim().replace(/\s+/g, ' '); }
// No dependency on locale/ICU: a same-user local heuristic, adequate for splitting an owner-authored ko/en corpus.
function detectLang(s) { return /[가-힣]/.test(s) ? 'ko' : 'en'; }
function buildTaskRequest(task) {
  return { purpose: 'route', risk: 'routine', state: { task, context: structuredClone(FIXED_ROUTE_CONTEXT) }, questions: structuredClone(ROUTE_QUESTIONS) };
}

// --- import ---------------------------------------------------------------
export function distillImport(home, { run, inputFile, readFileImpl = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  validateRunName(run);
  if (typeof inputFile !== 'string' || !inputFile) fail('DISTILL_INPUT_REQUIRED');
  const dir = ensureRunDir(home, run);
  return withRunLock(dir, () => {
    const raw = readFileImpl(inputFile);
    if (Buffer.byteLength(raw) > 64 * 1024 * 1024) fail('DISTILL_INPUT_TOO_LARGE');
    const file = tasksFile(dir);
    const seen = new Set(readPrivateJsonl(file).map(t => t.task_id));
    let total = 0, added = 0, skippedSensitive = 0, skippedDuplicate = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      total++;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { fail('INVALID_DISTILL_TASK_LINE'); }
      only(parsed, ['lang', 'domain', 'task'], ['lang', 'task']);
      if (!['ko', 'en'].includes(parsed.lang)) fail('INVALID_DISTILL_TASK_LINE');
      if (typeof parsed.task !== 'string' || !parsed.task.trim() || parsed.task.length > 2000) fail('INVALID_DISTILL_TASK_LINE');
      if (parsed.domain !== undefined && parsed.domain !== null) text(parsed.domain, 80);
      if (containsSensitiveData(parsed)) { skippedSensitive++; continue; }
      const normalized = normalizeTaskText(parsed.task);
      const task_id = digest({ lang: parsed.lang, text: normalized });
      if (seen.has(task_id)) { skippedDuplicate++; continue; }
      seen.add(task_id);
      appendPrivateJsonl(file, { task_id, lang: parsed.lang, domain: parsed.domain ?? null, task: parsed.task,
        source: 'synthetic', egress: 'allowed', added_at: new Date().toISOString() });
      added++;
    }
    return { run, total, added, skippedSensitive, skippedDuplicate };
  });
}
export function distillImportShadow(home, { run, trainingStore } = {}) {
  validateRunName(run);
  const dir = ensureRunDir(home, run);
  const store = trainingStore ?? createTrainingStore({ home });
  return withRunLock(dir, () => {
    const snapshot = store.scan();
    const file = tasksFile(dir);
    const seen = new Set(readPrivateJsonl(file).map(t => t.task_id));
    let scannedDecisions = 0, added = 0, skippedSensitive = 0, skippedDuplicate = 0;
    for (const e of snapshot.events) {
      if (e.kind !== 'decisions' || e.data.request.purpose !== 'route') continue;
      scannedDecisions++;
      const task = e.data.request.state?.task;
      if (typeof task !== 'string' || !task.trim()) continue;
      if (containsSensitiveData({ task })) { skippedSensitive++; continue; }
      const lang = detectLang(task);
      const task_id = digest({ lang, text: normalizeTaskText(task) });
      if (seen.has(task_id)) { skippedDuplicate++; continue; }
      seen.add(task_id);
      appendPrivateJsonl(file, { task_id, lang, domain: null, task, source: 'shadow', egress: 'forbidden', added_at: new Date().toISOString() });
      added++;
    }
    return { run, scannedDecisions, added, skippedSensitive, skippedDuplicate };
  });
}

// --- label (teacher) -------------------------------------------------------
export async function distillLabel(home, { run, confirmEgress, limit, provider = callTypeSafe, key, model, timeoutMs, env = process.env,
  now = Date.now, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!confirmEgress) fail('EXPLICIT_REMOTE_TEACHER_CONSENT_REQUIRED');
  validateRunName(run);
  const dir = ensureRunDir(home, run);
  const tasks = readPrivateJsonl(tasksFile(dir));
  const labeled = new Set(readPrivateJsonl(teacherFile(dir)).map(l => l.task_id));
  const eligible = tasks.filter(t => t.egress === 'allowed' && !labeled.has(t.task_id));
  const batch = Number.isInteger(limit) ? eligible.slice(0, Math.max(0, limit)) : eligible;
  const resolvedKey = key ?? getCredential(home, env).key;
  if (!resolvedKey) fail('NO_API_KEY');
  const policy = loadFeaturePolicy(home);
  const resolvedModel = model ?? policy.router.expectedModel;
  const config = loadConfig(home, env);
  const resolvedTimeout = timeoutMs ?? config.timeoutMs;
  let lastCallAt = null, attempted = 0, succeeded = 0, failed = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const failureCodes = {};
  for (const task of batch) {
    if (lastCallAt !== null) {
      const wait = MIN_CALL_INTERVAL_MS - (now() - lastCallAt);
      if (wait > 0) await sleepImpl(wait);
    }
    lastCallAt = now();
    attempted++;
    try {
      const request = validateRequest(buildTaskRequest(task.task), config);
      const payload = wireRequest(request, resolvedModel);
      const raw = await provider(payload, resolvedKey, { timeoutMs: resolvedTimeout });
      const n = normalizeResponse(raw, request, { ...config, minConfidence: 0, minChoiceProbability: 0, noulCertainty: 0 });
      const answers = {};
      for (const qid of Object.keys(ROUTE_QUESTIONS)) answers[qid] = { probabilities: n.answers[qid].probabilities };
      appendPrivateJsonl(teacherFile(dir), { task_id: task.task_id, model: n.model, answers, usage: n.usage, at: new Date().toISOString() });
      succeeded++; usage.inputTokens += n.usage.inputTokens ?? 0; usage.outputTokens += n.usage.outputTokens ?? 0;
    } catch (e) {
      const code = errorCode(e);
      appendPrivateJsonl(teacherFailuresFile(dir), { task_id: task.task_id, code, at: new Date().toISOString() });
      failed++; failureCodes[code] = (failureCodes[code] ?? 0) + 1;
    }
  }
  return { run, eligible: eligible.length, attempted, succeeded, failed, failureCodes, usage };
}

// --- review (human TTY) -----------------------------------------------------
// TTY checks are a same-user local-authorship signal only, not proof of a human operator (see SECURITY.md).
export async function distillReview(home, { run, count = 200, isStdinTTY, isStdoutTTY, prompt, write = () => {} } = {}) {
  if (!isStdinTTY || !isStdoutTTY) fail('HUMAN_TTY_REQUIRED');
  validateRunName(run);
  if (!Number.isInteger(count) || count < 2) fail('INVALID_DISTILL_REVIEW_COUNT');
  const dir = ensureRunDir(home, run);
  const tasksById = new Map(readPrivateJsonl(tasksFile(dir)).map(t => [t.task_id, t]));
  const teacherById = new Map(readPrivateJsonl(teacherFile(dir)).map(l => [l.task_id, l]));
  const reviewedIds = new Set(readPrivateJsonl(reviewFile(dir)).map(l => l.task_id));
  const perLang = Math.floor(count / 2);
  const byLang = { ko: [], en: [] };
  for (const task_id of teacherById.keys()) {
    const t = tasksById.get(task_id);
    if (t && byLang[t.lang]) byLang[t.lang].push(task_id);
  }
  for (const lang of ['ko', 'en']) byLang[lang].sort();
  const selected = [...byLang.ko.slice(0, perLang), ...byLang.en.slice(0, perLang)];
  const pending = selected.filter(id => !reviewedIds.has(id));
  let reviewed = 0, skipped = 0, quit = false;
  for (const task_id of pending) {
    const task = tasksById.get(task_id), teacher = teacherById.get(task_id);
    write(`\ntask (${task.lang}): ${task.task}\n`);
    const labels = {};
    let taskSkipped = false, taskQuit = false;
    for (const [qid, q] of Object.entries(ROUTE_QUESTIONS)) {
      const teacherAnswer = teacher.answers[qid];
      const top = Object.entries(teacherAnswer.probabilities).sort((a, b) => b[1] - a[1])[0];
      const display = q.type === 'score' ? String(Number(top[0]) + 1) : top[0];
      write(`question ${qid}: ${q.instructions}\n  teacher: ${display} (p=${top[1].toFixed(3)})\n`);
      const answer = (await prompt(`value for "${qid}" (Enter=accept, s=skip task, q=save & quit): `)).trim();
      if (answer === 'q') { taskQuit = true; break; }
      if (answer === 's') { taskSkipped = true; break; }
      let value;
      if (answer === '') value = q.type === 'score' ? Number(top[0]) : top[0];
      else if (q.type === 'score') {
        const n = Number(answer);
        if (!Number.isInteger(n) || n < 1 || n > q.criteria.length) fail('INVALID_TRAINING_TARGET');
        value = n - 1;
      } else value = answer;
      validateTarget(q, value);
      labels[qid] = value;
    }
    if (taskQuit) { quit = true; break; }
    if (taskSkipped) { skipped++; continue; }
    appendPrivateJsonl(reviewFile(dir), { task_id, labels, reviewer: 'human-tty', at: new Date().toISOString() });
    reviewed++;
  }
  return { run, selected: selected.length, reviewed, skipped, remaining: pending.length - reviewed - skipped, quit };
}

// --- build (standard datasets/<version> layout) -----------------------------
function hashToUuid(hex) {
  const bytes = hex.slice(0, 32).padEnd(32, '0').match(/.{2}/g).map(h => parseInt(h, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function argmax(probabilities) { return Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]; }
function teacherProvenance(model) {
  return { provider: 'jev', model, model_version: model, checkpoint: model, runtime_version: 'systemone-v1', preprocessing_version: 'wire-request-v1', confidence_semantics: 'reported-statistic' };
}
const HOST_REVIEW_PROVENANCE = Object.freeze({ provider: 'host', model: 'human-review', model_version: 'human-review', checkpoint: 'human-review', runtime_version: 'host-reviewed', preprocessing_version: 'wire-request-v1', confidence_semantics: 'none' });

export function buildDistillDataset(home, { run, trainingStore } = {}) {
  validateRunName(run);
  const dir = ensureRunDir(home, run);
  const store = trainingStore ?? createTrainingStore({ home });
  const { tasks, teacherById, reviewById } = withRunLock(dir, () => ({
    tasks: readPrivateJsonl(tasksFile(dir)),
    teacherById: new Map(readPrivateJsonl(teacherFile(dir)).map(l => [l.task_id, l])),
    reviewById: new Map(readPrivateJsonl(reviewFile(dir)).map(l => [l.task_id, l])),
  }));
  return store.lock(() => {
    const snapshot_id = digest(`distill-run:${run}`);
    const samples = [];
    for (const task of [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))) {
      const teacher = teacherById.get(task.task_id);
      const reviewed = reviewById.get(task.task_id);
      let split, provenance, labelSource, labelConfidence, valueFor, probsFor;
      if (reviewed) {
        // Deterministic 50/50 calibration/test on the task's own id hash; reviewed tasks never enter train (no leakage).
        split = parseInt(task.task_id.slice(0, 8), 16) % 2 === 0 ? 'calibration' : 'test';
        provenance = teacher ? teacherProvenance(teacher.model) : HOST_REVIEW_PROVENANCE;
        labelSource = 'human'; labelConfidence = 1;
        valueFor = qid => reviewed.labels[qid];
        probsFor = (q, value) => targetDistribution(q, value);
      } else if (teacher && task.egress === 'allowed') {
        split = 'train';
        provenance = teacherProvenance(teacher.model);
        labelSource = 'teacher'; labelConfidence = TEACHER_LABEL_CONFIDENCE;
        valueFor = qid => { const top = argmax(teacher.answers[qid].probabilities); return ROUTE_QUESTIONS[qid].type === 'score' ? Number(top) : top; };
        probsFor = (q, value, qid) => teacher.answers[qid].probabilities;
      } else continue;
      const request = buildTaskRequest(task.task);
      const request_hash = digest(request);
      const task_uuid = hashToUuid(task.task_id);
      const group_id = digest({ distill_task: task.task_id });
      for (const [qid, q] of Object.entries(ROUTE_QUESTIONS)) {
        const value = valueFor(qid);
        validateTarget(q, value);
        const target = { value, probabilities: probsFor(q, value, qid) };
        const sample = { schema_version: 1, sample_id: digest({ request_hash, question_id: qid, target }),
          task_id: task_uuid, snapshot_id, task_ids: [task_uuid], snapshot_ids: [snapshot_id], request_hash,
          purpose: 'route', state: request.state, question_id: qid, question: structuredClone(q),
          target, label_source: labelSource, label_confidence: labelConfidence, label_confidence_is_calibrated: false,
          evaluation_policy_version: POLICY_VERSION, provenance: [provenance],
          raw_refs: { distill: { run, task_id: task.task_id } }, group_id, split };
        safeContent(sample);
        samples.push(sample);
      }
    }
    samples.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
    const data = samples.map(encode).join('\n') + (samples.length ? '\n' : '');
    const data_sha256 = digest(data);
    const version = digest({ kind: 'distill', run, data_sha256 });
    const counts = { split: {}, lang: {}, label_source: {} };
    for (const s of samples) {
      counts.split[s.split] = (counts.split[s.split] ?? 0) + 1;
      counts.label_source[s.label_source] = (counts.label_source[s.label_source] ?? 0) + 1;
    }
    for (const task of tasks) if (teacherById.has(task.task_id) || reviewById.has(task.task_id)) counts.lang[task.lang] = (counts.lang[task.lang] ?? 0) + 1;
    const teacherModels = [...new Set([...teacherById.values()].map(l => l.model))];
    const manifest = { schema_version: 1, dataset_version: version, kind: 'distill', run, generated_at: new Date().toISOString(),
      sample_count: samples.length, data_sha256, evaluation_policy_version: POLICY_VERSION,
      teacher_model: teacherModels.length <= 1 ? (teacherModels[0] ?? null) : teacherModels, counts,
      policy: 'teacher labels ground only the train split; calibration/test/holdout accept human review only; only synthetic tasks are ever sent to the remote teacher' };
    const manifestPath = path.join(store.root, 'manifests', `${version}.json`);
    const previous = readText(manifestPath, { optional: true, privateFile: true, maxBytes: 1048576 });
    store.writeDerived(`datasets/${version}/canonical.jsonl`, data);
    if (previous === null) store.writeDerived(`manifests/${version}.json`, encode(manifest) + '\n');
    else { const old = JSON.parse(previous); if (old.dataset_version !== version || old.data_sha256 !== data_sha256) fail('DATASET_MANIFEST_MISMATCH'); }
    return { dataset_version: version, sample_count: samples.length, manifest: manifestPath, counts };
  });
}

// --- status (content-free) --------------------------------------------------
export function distillStatus(home, { run } = {}) {
  validateRunName(run);
  const dir = runDir(home, run);
  const tasks = readPrivateJsonl(tasksFile(dir));
  const teacherLines = readPrivateJsonl(teacherFile(dir));
  const failures = readPrivateJsonl(teacherFailuresFile(dir));
  const reviewLines = readPrivateJsonl(reviewFile(dir));
  const bySourceLang = {};
  for (const t of tasks) { const k = `${t.source}:${t.lang}`; bySourceLang[k] = (bySourceLang[k] ?? 0) + 1; }
  const usage = teacherLines.reduce((acc, l) => ({ inputTokens: acc.inputTokens + (l.usage?.inputTokens ?? 0), outputTokens: acc.outputTokens + (l.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
  return { run, tasks: tasks.length, tasks_by_source_lang: bySourceLang, teacher_labels: teacherLines.length,
    teacher_label_failures: failures.length, reviewed: reviewLines.length, teacher_usage: usage };
}
