import { randomUUID } from 'node:crypto';
import { POLICY_VERSION, encode, digest, validateTarget } from './schema.mjs';

export const EVALUATION_POLICY = Object.freeze({ version: POLICY_VERSION, minLabelConfidence: .9,
  labelSources: ['objective', 'human'], agreementIsAccuracy: false, hostIsOracle: false,
  qualityRule: 'explicit task success AND required task-scoped checks passed AND no rollback/regression/runtime error/timeout',
});
const PURPOSE_SIGNALS = Object.freeze({
  route: ['task_succeeded', 'retry_count', 'escalated', 'latency_ms', 'token_usage', 'cost_usd', 'regression'],
  select: ['task_succeeded', 'artifact_created', 'runtime_error', 'retry_count'],
  retry: ['retry_needed', 'retry_count', 'task_succeeded', 'timeout'],
  review: ['serious_review_issue', 'regression', 'human_override', 'task_succeeded'],
  judge: ['tests_passed', 'build_passed', 'lint_passed', 'typecheck_passed', 'runtime_error', 'artifact_created'],
  escalate: ['escalated', 'human_override', 'additional_agent_calls', 'task_succeeded', 'retry_count'],
});
export function indexEvents(snapshot) {
  const decisions = new Map(), excluded = new Set(), outcomes = new Map();
  let duplicateDecisions = 0, orphanOutcomes = 0, orphanEvaluations = 0;
  for (const e of snapshot.events.filter(e => e.kind === 'decisions')) {
    const key = e.data.decision_id;
    if (decisions.has(key)) { excluded.add(key); duplicateDecisions++; }
    else decisions.set(key, e);
  }
  for (const e of snapshot.events.filter(e => e.kind === 'outcomes')) {
    const key = e.data.decision_id;
    if (!decisions.has(key) || excluded.has(key)) { orphanOutcomes++; continue; }
    if (!outcomes.has(key)) outcomes.set(key, []);
    outcomes.get(key).push(e);
  }
  const eventIds = new Set(snapshot.events.map(e => e.event_id));
  for (const e of snapshot.events.filter(e => e.kind === 'evaluations')) {
    if (!decisions.has(e.data.decision_id) || e.data.outcome_ids.some(k => !eventIds.has(k))) orphanEvaluations++;
  }
  for (const key of excluded) decisions.delete(key);
  return { decisions, outcomes, report: { invalidEvents: snapshot.invalid.length, duplicateDecisions, orphanOutcomes, orphanEvaluations } };
}
export function evaluateDecision(decisionEvent, outcomeEvents = []) {
  const d = decisionEvent.data;
  // Repeated transmission of identical outcome content is not another execution.
  const distinct = new Map(outcomeEvents.filter(e => e.data.final).map(e => [digest(e.data), e]));
  const final = [...distinct.values()];
  const base = { decision_id: d.decision_id, policy_version: POLICY_VERSION,
    outcome_ids: outcomeEvents.map(e => e.event_id).sort(), purpose: d.request.purpose,
    quality_observed: null, quality_is_global_correctness: false, labels: [], signals: {},
    utility: null, issues: [], evidence_sources: [], metrics: null, executed: false };
  if (final.length !== 1) return { ...base, state: final.length ? 'AMBIGUOUS_OUTCOME' : 'AWAITING_OUTCOME' };
  const o = final[0].data;
  base.metrics = o.metrics; base.executed = o.executed;
  base.evidence_sources = [...new Set([o.source, ...o.labels.map(a => a.source)])].sort();
  if (!o.executed) return { ...base, state: 'NOT_EXECUTED' };
  // A production outcome must not be copied to the other shadow arms.
  if (d.arm === 'shadow') return { ...base, state: 'SHADOW_HAS_NO_COUNTERFACTUAL_OUTCOME' };
  for (const [name, value] of Object.entries(o.executed_answers)) {
    const q = d.request.questions[name];
    if (!q || (q.type === 'score' ? !Number.isFinite(value) || value < 0 || value >= q.criteria.length : (() => { try { validateTarget(q, value); return false; } catch { return true; } })())) {
      return { ...base, state: 'INVALID_EXECUTION_LINK' };
    }
  }
  const required = o.checks.filter(c => c.required && c.scope === 'task' && c.kind !== 'label');
  const m = o.metrics;
  const negative = ['runtime_error', 'rollback', 'timeout', 'regression'].some(k => m[k] === true) || required.some(c => !c.passed);
  base.quality_observed = negative || m.task_succeeded === false ? false :
    (m.task_succeeded === true && required.length && required.every(c => c.passed) ? true : null);
  for (const key of PURPOSE_SIGNALS[d.request.purpose]) base.signals[key] = m[key] ?? null;
  if (d.request.purpose === 'route') base.utility = { quality: base.quality_observed,
    latency_ms: m.latency_ms ?? null, token_usage: m.token_usage ?? null, cost_usd: m.cost_usd ?? null,
    retry_count: m.retry_count ?? null, escalated: m.escalated ?? null,
    note: 'Observed dimensions only; success does not prove this route was cheapest or optimal.' };
  if (d.request.purpose === 'retry' && m.retry_needed === true) base.issues.push('RETRY_WAS_NEEDED');
  if (d.request.purpose === 'review' && m.serious_review_issue === true) base.issues.push('SERIOUS_ISSUE_FOUND');
  if (d.request.purpose === 'escalate' && m.escalated === true) base.issues.push('ESCALATION_OCCURRED');
  if (d.request.purpose === 'judge' && negative) base.issues.push('OBJECTIVE_FAILURE_OBSERVED');
  if (d.request.purpose === 'select' && m.artifact_created === false) base.issues.push('REQUESTED_ARTIFACT_MISSING');
  if (m.human_override === true) base.issues.push('HUMAN_OVERRIDE_RECORDED');
  for (const a of o.labels) {
    if (!EVALUATION_POLICY.labelSources.includes(a.source) || a.label_confidence < EVALUATION_POLICY.minLabelConfidence) continue;
    const q = d.request.questions[a.question_id];
    try { if (!q) continue; validateTarget(q, a.value); } catch { base.issues.push('INVALID_LABEL'); continue; }
    // A successful build cannot label intent, difficulty, or the optimal worker. An objective target
    // needs a separate, question-specific labelled assertion from a trusted runner.
    if (a.source === 'objective' && (o.source !== 'runner' || !o.checks.some(c => c.kind === 'label' && c.passed && c.required &&
        c.scope === 'task' && c.question_id === a.question_id && c.evidence_ref === a.evidence_ref))) continue;
    if (a.source === 'human' && o.source !== 'human') continue;
    base.labels.push({ ...a, outcome_id: final[0].event_id, reliability_is_calibrated_probability: false });
  }
  return { ...base, state: base.labels.length ? 'LABEL_CANDIDATE' : 'EVIDENCE_ONLY' };
}
export function evaluateStore(store) {
  if (!store.config().trainingCapture) return { stored: false, reason: 'CAPTURE_OFF' };
  return store.lock(() => {
    const snapshot = store.scanUnlocked(), index = indexEvents(snapshot);
    const existing = new Set(snapshot.events.filter(e => e.kind === 'evaluations').map(e => digest(e.data)));
    let written = 0;
    for (const [key, d] of index.decisions) {
      const derived = evaluateDecision(d, index.outcomes.get(key));
      const data = { decision_id: key, outcome_ids: derived.outcome_ids, policy_version: POLICY_VERSION, derived };
      if (!existing.has(digest(data))) { store.appendUnlocked('evaluations', data, randomUUID()); written++; }
    }
    return { stored: true, evaluationsWritten: written, policyVersion: POLICY_VERSION, ...index.report };
  });
}
export function pairedPreferences(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j], x = a.decision.data, y = b.decision.data;
    if (x.request.purpose !== 'route' || x.request_hash !== y.request_hash ||
        !x.trace.task_id || x.trace.task_id !== y.trace.task_id || !x.trace.snapshot_id || x.trace.snapshot_id !== y.trace.snapshot_id ||
        a.evaluation.quality_observed !== true || b.evaluation.quality_observed !== true ||
        encode(a.outcome?.executed_answers) === encode(b.outcome?.executed_answers)) continue;
    const am = a.evaluation.metrics, bm = b.evaluation.metrics;
    if (![am.latency_ms, bm.latency_ms, am.token_usage, bm.token_usage, am.retry_count, bm.retry_count].every(Number.isFinite)) continue;
    const dominates = (u, v) => u.latency_ms <= v.latency_ms && u.token_usage <= v.token_usage && u.retry_count <= v.retry_count &&
      (u.latency_ms < v.latency_ms || u.token_usage < v.token_usage || u.retry_count < v.retry_count) && !u.escalated;
    const chosen = dominates(am, bm) ? a : dominates(bm, am) ? b : null;
    if (chosen) pairs.push({ chosen_decision_id: chosen.decision.data.decision_id,
      rejected_decision_id: (chosen === a ? b : a).decision.data.decision_id,
      relation: 'observed_success_pareto_dominance', is_ground_truth: false, policy_version: POLICY_VERSION });
  }
  return pairs.sort((a, b) => encode(a).localeCompare(encode(b)));
}
export function summarizeComparisons(snapshot) {
  const index = indexEvents(snapshot), groups = new Map(), execution = new Map(), calibration = new Map();
  for (const [key, event] of index.decisions) {
    const d = event.data, e = evaluateDecision(event, index.outcomes.get(key));
    const identity = encode({ ...d.provenance, purpose: d.request.purpose });
    if (!execution.has(identity)) execution.set(identity, { provider: d.provenance.provider, model: d.provenance.model,
      checkpoint: d.provenance.checkpoint, purpose: d.request.purpose, decisions: 0, executed: 0, measuredSuccesses: 0,
      measuredFailures: 0, unknownQuality: 0, baselineCallsActuallySkipped: 0, inferenceLatencyMs: [] });
    const stats = execution.get(identity); stats.decisions++; stats.inferenceLatencyMs.push(d.latency_ms);
    if (e.executed && d.arm !== 'shadow') {
      stats.executed++; if (e.quality_observed === true) stats.measuredSuccesses++;
      else if (e.quality_observed === false) stats.measuredFailures++; else stats.unknownQuality++;
      if (e.metrics?.baseline_call_skipped === true) stats.baselineCallsActuallySkipped++;
    }
    if (d.trace.comparison_id) {
      const group = `${d.trace.comparison_id}:${d.request_hash}`;
      if (!groups.has(group)) groups.set(group, []); groups.get(group).push(d);
    }
    for (const label of e.labels) {
      const q = d.request.questions[label.question_id], p = d.answers[label.question_id];
      const probs = q.type === 'noul' && p.probabilityTrue != null ? { false: 1 - p.probabilityTrue, true: p.probabilityTrue } : p.probabilities;
      if (!probs) continue;
      const calKey = `${identity}:${q.type}`;
      if (!calibration.has(calKey)) calibration.set(calKey, { provider: d.provenance.provider, model: d.provenance.model,
        checkpoint: d.provenance.checkpoint, purpose: d.request.purpose, primitive: q.type, samples: [] });
      const selected = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      calibration.get(calKey).samples.push({ confidence: selected[1], correct: selected[0] === String(label.value),
        brier: Object.entries(probs).reduce((s, [k, v]) => s + (v - (k === String(label.value) ? 1 : 0)) ** 2, 0) });
    }
  }
  let matched = 0, compared = 0;
  for (const values of groups.values()) for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    if (values[i].provenance.provider === values[j].provenance.provider && values[i].provenance.checkpoint === values[j].provenance.checkpoint) continue;
    for (const name of Object.keys(values[i].answers)) { compared++; if (encode(values[i].answers[name].value) === encode(values[j].answers[name]?.value)) matched++; }
  }
  const percentile = (arr, p) => arr.length ? [...arr].sort((a, b) => a - b)[Math.ceil(arr.length * p) - 1] : null;
  return { ...index.report, agreement: { matched, compared, isAccuracy: false },
    arms: [...execution.values()].map(({ inferenceLatencyMs, ...s }) => ({ ...s, latencyMs: { p50: percentile(inferenceLatencyMs, .5), p95: percentile(inferenceLatencyMs, .95) } })),
    calibration: [...calibration.values()].map(({ samples, ...s }) => {
      let ece = 0;
      for (let i = 0; i < 10; i++) { const bin = samples.filter(x => Math.min(9, Math.floor(x.confidence * 10)) === i);
        if (bin.length) ece += Math.abs(bin.reduce((v, x) => v + Number(x.correct) - x.confidence, 0)) / samples.length; }
      return { ...s, count: samples.length, brier: samples.reduce((v, x) => v + x.brier, 0) / samples.length, ece,
        confidenceBasis: 'top-class probability, NOT entropy confidence or task success probability' };
    }), note: 'Reported evidence is not independently attested. Shadow agreement supplies no counterfactual task success.' };
}
