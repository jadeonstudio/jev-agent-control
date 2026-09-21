import fs from 'node:fs';
import path from 'node:path';
import { readText, noSymlinks } from './storage.mjs';
import { fail } from './constants.mjs';
const percentile = (array, p) => array.length ? [...array].sort((a, b) => a - b)[Math.ceil(array.length * p) - 1] : null;
export function readMetrics(home, days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 30) fail('INVALID_DAYS');
  const dir = path.join(home, 'logs'); noSymlinks(dir);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^events-\d{4}-\d\d-\d\d\.jsonl$/.test(n)) : [];
  const cutoff = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const events = []; let skipped = 0, cappedFiles = 0;
  for (const name of files.filter(n => n.slice(7, 17) >= cutoff)) {
    const text = readText(path.join(dir, name), { privateFile: true, maxBytes: 11 * 1024 * 1024 });
    if (Buffer.byteLength(text) >= 10 * 1024 * 1024) cappedFiles++;
    for (const line of text.split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); if (!['decision', 'feedback', 'route', 'filter', 'observation'].includes(row.kind)) throw new Error(); events.push(row); }
      catch { skipped++; }
    }
  }
  const decisions = events.filter(e => e.kind === 'decision'), feedback = events.filter(e => e.kind === 'feedback');
  const latency = decisions.filter(e => e.networkCalls === 1).map(e => e.elapsedMs).filter(Number.isFinite);
  const tokens = (rows, field, key) => rows.reduce((sum, e) => sum + (Number.isSafeInteger(e[field]?.[key]) ? e[field][key] : 0), 0);
  const featureActivity = Object.fromEntries(['route', 'filter'].map(kind => {
    const rows = events.filter(e => e.kind === kind);
    return [kind, { requests: rows.length, applied: rows.filter(e => e.apply).length,
      reasons: rows.reduce((o, r) => { o[r.reason] = (o[r.reason] || 0) + 1; return o; }, Object.create(null)),
      elapsedMs: { p50: percentile(rows.map(e => e.elapsedMs).filter(Number.isFinite), 0.5), p95: percentile(rows.map(e => e.elapsedMs).filter(Number.isFinite), 0.95) } }];
  }));
  const jevDecisions = decisions.filter(e => (e.provider ?? 'jev') === 'jev');
  const providerActivity = Object.fromEntries(['jev', 'laya'].map(provider => {
    const rows = decisions.filter(e => (e.provider ?? 'jev') === provider);
    const inference = rows.filter(e => (e.inferenceCalls ?? e.networkCalls ?? 0) > 0);
    const normal = ['ACCEPTED','LOW_CONFIDENCE','UNQUALIFIED_PROVIDER','SHADOW','MODE_CHANGED','POLICY_CHANGED','PROVIDER_CHANGED','CANCELLED'];
    return [provider, { requests:rows.length, inferenceCalls:inference.reduce((s,e)=>s+(e.inferenceCalls ?? e.networkCalls),0), networkCalls:rows.reduce((s,e)=>s+(e.networkCalls||0),0),
      accepted:rows.filter(e=>e.apply).length, hostFallbacks:rows.filter(e=>e.mode==='on' && !e.apply).length, errors:inference.filter(e=>!normal.includes(e.reason)).length,
      inputTokens:tokens(rows,'usage','inputTokens'), outputTokens:tokens(rows,'usage','outputTokens'), missingUsageCalls:inference.filter(e=>e.usage?.inputTokens==null||e.usage?.outputTokens==null).length,
      latencyMs:{p50:percentile(inference.map(e=>e.elapsedMs).filter(Number.isFinite),.5),p95:percentile(inference.map(e=>e.elapsedMs).filter(Number.isFinite),.95)} }];
  }));
  const observations = events.filter(e => e.kind === 'observation');
  return { days, decisions: decisions.length, networkCalls: decisions.reduce((s, e) => s + (e.networkCalls || 0), 0),
    inferenceCalls: decisions.reduce((s,e)=>s+(e.inferenceCalls ?? e.networkCalls ?? 0),0), providerActivity,
    accepted: decisions.filter(e => e.apply).length,
    byMode: Object.fromEntries(['off', 'shadow', 'on'].map(mode => [mode, decisions.filter(e => e.mode === mode).length])),
    reasons: decisions.reduce((out, row) => { out[row.reason] = (out[row.reason] || 0) + 1; return out; }, Object.create(null)),
    networkDecisionLatencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    jevReportedTokens: { input: tokens(jevDecisions, 'usage', 'inputTokens'), output: tokens(jevDecisions, 'usage', 'outputTokens'),
      missingUsageCalls: jevDecisions.filter(e => e.networkCalls && (e.usage?.inputTokens == null || e.usage?.outputTokens == null)).length },
    baselineReportedTokens: { input: tokens(feedback, 'baselineUsage', 'inputTokens'), output: tokens(feedback, 'baselineUsage', 'outputTokens') },
    baselineAgreement: { matched: feedback.reduce((s, e) => s + (e.matched || 0), 0), total: feedback.reduce((s, e) => s + (e.total || 0), 0), isAccuracy: false },
    featureActivity,
    routeAgreement: { observed: observations.filter(e => e.feature === 'route').length,
      matched: observations.filter(e => e.feature === 'route' && e.matched === true).length, isTaskAccuracy: false },
    filterLabels: { relevant: observations.filter(e => e.feature === 'filter').reduce((n, e) => n + (e.relevant || 0), 0),
      missed: observations.filter(e => e.feature === 'filter').reduce((n, e) => n + (e.missed || 0), 0), suppliedLabelsOnly: true },
    tokenSavings: null, costSavings: null, skippedLines: skipped, cappedFiles,
    note: 'OFF requests are not logged. API counts use decision events only, not wrapper events. Accepted primitives are not executed model routes. Missing usage is unknown, not zero. Host tokens and Jev tokens are not directly interchangeable. Whole-task savings require matched A/B runs. Logs are local best-effort metadata only.' };
}
