import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encode, digest } from '../src/training/schema.mjs';
import { buildDataset, exportDataset } from '../src/training/dataset.mjs';
import { fixture, decision, outcome } from './training-helpers.mjs';

test('capture and export preserve nested state and option order used for inference', t => {
  const f = fixture(t);
  const d = decision();
  d.request.state = { zeta: [{ second: 2, first: 1 }], alpha: { y: 'later', b: 'earlier' } };
  d.request.questions.worker.criteria = { strong: 'Broad scope', light: 'Known scope' };
  d.request_hash = digest(d.request);
  const original = JSON.stringify(d.request.state);
  f.save(d); f.store.outcome(outcome(d));
  const stored = f.store.scan().events.find(e => e.kind === 'decisions').data;
  assert.equal(JSON.stringify(stored.request.state), original);
  assert.deepEqual(Object.keys(stored.request.questions.worker.criteria), ['strong', 'light']);
  const dataset = buildDataset(f.store), exported = exportDataset(f.store, dataset.dataset_version);
  const rows = exported.files.filter(p => p.endsWith('.jsonl')).flatMap(p => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, original);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].questions).worker.criteria), ['strong', 'light']);
  assert.equal(encode(JSON.parse(encode(d))), encode(d));
});
