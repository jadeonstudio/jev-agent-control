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
      try { const row = JSON.parse(line); if (!['decision', 'feedback'].includes(row.kind)) throw new Error(); events.push(row); }
      catch { skipped++; }
    }
  }
  const decisions = events.filter(e => e.kind === 'decision'), feedback = events.filter(e => e.kind === 'feedback');
  const latency = decisions.filter(e => e.networkCalls === 1).map(e => e.elapsedMs).filter(Number.isFinite);
  const tokens = (rows, field, key) => rows.reduce((sum, e) => sum + (Number.isSafeInteger(e[field]?.[key]) ? e[field][key] : 0), 0);
  return { days, decisions: decisions.length, networkCalls: decisions.reduce((s, e) => s + (e.networkCalls || 0), 0),
    accepted: decisions.filter(e => e.apply).length,
    byMode: Object.fromEntries(['off', 'shadow', 'on'].map(mode => [mode, decisions.filter(e => e.mode === mode).length])),
    reasons: decisions.reduce((out, row) => { out[row.reason] = (out[row.reason] || 0) + 1; return out; }, Object.create(null)),
    networkDecisionLatencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    jevReportedTokens: { input: tokens(decisions, 'usage', 'inputTokens'), output: tokens(decisions, 'usage', 'outputTokens'),
      missingUsageCalls: decisions.filter(e => e.networkCalls && (e.usage?.inputTokens == null || e.usage?.outputTokens == null)).length },
    baselineReportedTokens: { input: tokens(feedback, 'baselineUsage', 'inputTokens'), output: tokens(feedback, 'baselineUsage', 'outputTokens') },
    baselineAgreement: { matched: feedback.reduce((s, e) => s + (e.matched || 0), 0), total: feedback.reduce((s, e) => s + (e.total || 0), 0), isAccuracy: false },
    tokenSavings: null, costSavings: null, skippedLines: skipped, cappedFiles,
    note: 'OFF requests are not logged. Missing usage is unknown, not zero. Host tokens and Jev tokens are not directly interchangeable. Whole-task savings require matched A/B runs. Logs are local best-effort metadata only.' };
}
