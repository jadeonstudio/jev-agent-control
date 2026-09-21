import { parseArgs } from 'node:util';
import { resolveHome } from '../storage.mjs';
import { fail } from '../constants.mjs';
import { createTrainingStore } from './store.mjs';
import { recordHost } from './host.mjs';
import { evaluateStore } from './evaluate.mjs';
import { buildDataset, exportDataset, validateDatasetSource, datasetStats } from './dataset.mjs';
import { selectProvider } from '../inference.mjs';
import { createDecisionEngine } from '../engine.mjs';

export const TRAINING_COMMANDS = ['training', 'dataset', 'provider', 'compare'];
export const TRAINING_HELP = `\nProvider and offline dataset commands:\n  provider status|jev|laya       Select an explicitly configured provider; no download\n  training capture status|on|off  Content capture is OFF by default and separate from telemetry\n  training outcome|host          Read minimal evidence/baseline JSON from stdin\n  training evaluate              Append derived evaluations without changing raw evidence\n  dataset stats|validate|build    Local metadata, validation and reproducible dataset build\n  dataset export --version HASH [--format laya|canonical]\n  compare --live                 Explicitly authorize Jev/Laya comparison; only one active arm\nNo command trains, promotes a model, reads keys into output, or uploads a dataset.\n`;
const output = x => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
async function stdin() {
  if (process.stdin.isTTY) fail('PIPE_JSON_TO_STDIN');
  const chunks = []; let bytes = 0;
  for await (const b of process.stdin) { bytes += b.length; if (bytes > 49152) fail('INPUT_TOO_LARGE'); chunks.push(b); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('INVALID_JSON'); }
}
export async function trainingMain(argv, env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    home: { type: 'string' }, version: { type: 'string' }, format: { type: 'string' }, live: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command, sub, action] = positionals;
  if (!TRAINING_COMMANDS.includes(command) || positionals.length > 3) fail('INVALID_TRAINING_COMMAND');
  if (values.help) { process.stdout.write(TRAINING_HELP); return; }
  const allowed = command === 'dataset' && sub === 'export' ? ['home', 'version', 'format'] : command === 'compare' ? ['home', 'live'] : ['home'];
  if (Object.keys(values).some(k => !allowed.includes(k))) fail('UNEXPECTED_OPTION');
  const home = resolveHome({ ...env, ...(values.home ? { JEV_HOME: values.home } : {}) });
  const store = createTrainingStore({ home });
  if (command === 'training') {
    if (sub === 'capture' && ['on', 'off', 'status'].includes(action)) {
      output(action === 'status' ? store.status() : store.setCapture(action === 'on')); return;
    }
    if (action) fail('INVALID_TRAINING_COMMAND');
    if (sub === 'outcome') { output(store.outcome(await stdin())); return; }
    if (sub === 'host') { output(recordHost(store, await stdin())); return; }
    if (sub === 'evaluate') { output(evaluateStore(store)); return; }
  }
  if (command === 'dataset' && !action) {
    if (sub === 'stats') { output(datasetStats(store)); return; }
    if (sub === 'validate') { const r = validateDatasetSource(store); output(r); if (!r.ok) process.exitCode = 2; return; }
    if (sub === 'build') { output(buildDataset(store)); return; }
    if (sub === 'export') { if (!values.version) fail('DATASET_VERSION_REQUIRED'); output(exportDataset(store, values.version, values.format ?? 'laya')); return; }
  }
  if (command === 'provider' && !action) {
    if (sub === 'status') { const e = createDecisionEngine({ home, env }); try { output(e.status()); } finally { e.close(); } return; }
    if (['jev', 'laya'].includes(sub)) { output(selectProvider(home, sub)); return; }
  }
  if (command === 'compare' && !sub && !action) {
    if (!values.live) fail('EXPLICIT_REMOTE_COMPARISON_CONSENT_REQUIRED');
    const engine = createDecisionEngine({ home, env });
    try { output(await engine.compare(await stdin(), { remoteConsent: true })); } finally { engine.close(); }
    return;
  }
  fail('INVALID_TRAINING_COMMAND');
}
