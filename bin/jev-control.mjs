#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { main } from '../src/cli.mjs';
import { featureMain, FEATURE_HELP } from '../src/features-cli.mjs';
import { trainingMain, TRAINING_COMMANDS, TRAINING_HELP } from '../src/training/cli.mjs';
import { errorCode, fail } from '../src/constants.mjs';
try {
  if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_22_REQUIRED');
  const args = process.argv.slice(2);
  const peek = parseArgs({ args, allowPositionals: true, strict: false, options: { home: { type: 'string' } } });
  const command = peek.positionals[0];
  if (TRAINING_COMMANDS.includes(command)) await trainingMain(args);
  else if (!(await featureMain(args))) {
    await main(args);
    if (!command || command === 'help' || args.includes('--help')) process.stdout.write(FEATURE_HELP + TRAINING_HELP);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: errorCode(error) }) + '\n');
  process.exitCode = 2;
}
