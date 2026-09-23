#!/usr/bin/env node
// L1 real-weights end-to-end reproduction script (see docs/plan/2026-09-23-laya-local-performance.md).
// Offline, no network, no writes outside a throwaway temp JEV_HOME. Never touches the real
// JEV_HOME/~/.codex/~/.claude and never modifies the checkpoint directory it is pointed at.
//
//   <laya-venv>/bin/python scripts/laya-bench.py is the load-time/agreement micro-benchmark;
//   this script instead drives the real jev-agent-control decision engine end to end (engine.prepare
//   for the resident worker + cold start, engine.decide for warm route decisions) against a real
//   checkpoint, so it exercises the exact code path Codex/Claude would use, not a standalone harness.
//
// Usage:
//   node scripts/laya-e2e.mjs --python /abs/laya-venv/bin/python --model-path /abs/checkpoint-dir \
//     [--precision fp32|fp16] [--device mps|cpu|cuda] [--warm 10]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDecisionEngine } from '../src/engine.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// jev route questions (src/routing.mjs ROUTE_QUESTIONS), identical wording to scripts/laya-bench.py.
const ROUTE_QUESTIONS = {
  intent: { type: 'choice', instructions: 'Classify the work actually required. Use other when the request is unclear or outside these categories.', criteria: {
    explain: 'Explain or locate existing code; do not change behavior', edit: 'Write or change a bounded piece of code or documentation',
    debug: 'Investigate the cause of a failure', operate: 'Operate infrastructure, deploy, or modify live data',
    research: 'Research information outside the repository', architecture: 'Cross-module design, whole-repository audit or major refactoring',
    other: 'Insufficient evidence or none of these intents' } },
  difficulty: { type: 'score', instructions: 'Estimate the reasoning needed to finish, not prompt length. Account for unresolved dependencies and unknown scope. Do not infer that a short request is easy.', criteria: [
    '1: Mechanical, exact edit with explicit location and no behavioral change', '2: Small local change with explicit requirements and known validation',
    '3: Moderate implementation requiring several related steps', '4: Difficult debugging or interacting components needing substantial investigation',
    '5: Deep reasoning, unknown repository-wide impact, architecture or long-horizon planning'] },
  risk: { type: 'choice', instructions: 'Classify consequence and uncertainty, not permission. Safe requires evidence of local, reversible impact. Missing context is unknown. Risk is independent of difficulty.', criteria: {
    safe: 'Known local, reversible work with no security, production, payment or financial impact',
    caution: 'Material uncertainty or changes needing additional review',
    high: 'Irreversible operation, production, credentials, permissions, financial or payment consequences',
    unknown: 'Not enough context to assess impact' } },
};
const TASKS = [
  "Fix the typo 'teh' -> 'the' in README.md line 12. No code changes.",
  'Explain where the retry policy for HTTP requests is implemented.',
  'Add a --dry-run flag to the export command and a unit test for it.',
  'The nightly build fails with a segfault in the image decoder; find the cause.',
  'Rotate the production database credentials and redeploy all services.',
  'Redesign the plugin system so modules can be loaded lazily across the whole repo.',
  "README.md 12번째 줄의 오타 'teh'를 'the'로 고쳐줘. 코드는 바꾸지 않음.",
  'HTTP 요청 재시도 정책이 어디에 구현돼 있는지 설명해줘.',
  'export 명령에 --dry-run 옵션과 단위 테스트를 추가해줘.',
  '야간 빌드가 이미지 디코더에서 segfault로 실패해. 원인을 찾아줘.',
  '운영 DB 비밀번호를 교체하고 모든 서비스를 재배포해줘.',
  '플러그인 시스템을 저장소 전체에서 지연 로딩되도록 재설계해줘.',
];
const stateFor = task => ({ task, context: { complete: true, scope: 'local', previousFailures: 0, highImpact: false, modelLocked: false, exhaustive: false } });
const requestFor = task => ({ purpose: 'route', risk: 'routine', state: stateFor(task), questions: ROUTE_QUESTIONS });
const summarize = ts => {
  const sorted = [...ts].sort((a, b) => a - b);
  const n = sorted.length;
  return { n, p50: sorted[Math.floor(0.5 * n)], p95: sorted[Math.min(n - 1, Math.floor(0.95 * n))], min: sorted[0], max: sorted[n - 1] };
};
const topAnswer = a => (a.value !== undefined ? a.value : null);

async function main() {
  const { values } = parseArgs({ options: {
    python: { type: 'string' }, 'model-path': { type: 'string' }, precision: { type: 'string', default: 'fp32' },
    device: { type: 'string', default: 'mps' }, warm: { type: 'string', default: '10' },
  } });
  if (!values.python || !values['model-path']) {
    process.stderr.write('usage: node scripts/laya-e2e.mjs --python /abs/path --model-path /abs/checkpoint-dir [--precision fp32|fp16] [--device mps|cpu|cuda] [--warm 10]\n');
    process.exitCode = 2; return;
  }
  if (!['fp32', 'fp16'].includes(values.precision)) { process.stderr.write('--precision must be fp32 or fp16\n'); process.exitCode = 2; return; }
  const python = path.resolve(values.python), modelPath = path.resolve(values['model-path']);

  const fp = spawnSync(python, ['-I', path.join(ROOT, 'workers/laya_worker.py'), '--fingerprint', modelPath], { encoding: 'utf8', timeout: 60000 });
  if (fp.status !== 0) { process.stderr.write(`fingerprint failed: ${fp.stderr}\n`); process.exitCode = 1; return; }
  const checkpoint = JSON.parse(fp.stdout.trim().split('\n').pop()).checkpoint;

  // storage.mjs refuses any symlink component; os.tmpdir() itself is a symlink on macOS (/var -> private/var).
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-e2e-')));
  try {
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ version: 1, provider: 'laya', laya: {
      python, modelPath, model: 'laya/e2e', checkpoint, runtimeVersion: '0.3.4', device: values.device,
      startupTimeoutMs: 60000, idleTimeoutMs: 60000, precision: values.precision } }, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, mode: 'on', model: 'jev-latest', timeoutMs: 10000,
      maxInputBytes: 24000, maxQuestions: 8, minConfidence: 0.85, minChoiceProbability: 0.8, noulCertainty: 0.95,
      maxCallsPerMinute: 60, maxInFlight: 4, circuitFailureThreshold: 3, circuitCooldownMs: 30000, telemetry: true }, null, 2) + '\n', { mode: 0o600 });

    const env = { ...process.env, JEV_HOME: home, HOME: home };
    const engine = createDecisionEngine({ home, env });
    try {
      const t0 = Date.now();
      const identity = await engine.prepare({ timeoutMs: 60000, resident: true, env });
      const coldMs = Date.now() - t0;

      const warmCount = Number(values.warm);
      const latencies = []; let firstMs = null; const answersByTask = [];
      for (let i = 0; i < warmCount + 1; i++) {
        const task = TASKS[i % TASKS.length];
        const t = Date.now();
        let captured = null;
        const result = await engine.decide(requestFor(task), { onEvaluated: n => { captured = n; } });
        const ms = Date.now() - t;
        if (result.reason === 'OFF' || result.answers === undefined) throw new Error(`unexpected decide() reason: ${result.reason}`);
        if (i === 0) { firstMs = ms; } else { latencies.push(ms); }
        if (i < TASKS.length) answersByTask.push({ task, answers: Object.fromEntries(Object.entries(captured.answers).map(([q, a]) => [q, topAnswer(a)])) });
      }
      process.stdout.write(JSON.stringify({
        python, modelPath, checkpoint, precision: values.precision, device: values.device,
        cold_ms: coldMs, first_decide_ms: firstMs, warm_latency_ms: summarize(latencies),
        identity, answers: answersByTask,
      }, null, 2) + '\n');
    } finally { engine.close(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
await main();
