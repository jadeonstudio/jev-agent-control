#!/usr/bin/env node
import { errorCode } from '../src/constants.mjs';
import { featureMain, FEATURE_HELP } from '../src/features-cli.mjs';
try {
  if (!await featureMain()) {
    const { main } = await import('../src/cli.mjs');
    await main();
    if (process.argv.length === 2 || process.argv.includes('help') || process.argv.includes('--help')) process.stdout.write(FEATURE_HELP);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: errorCode(error) }) + '\n');
  process.exitCode = 2;
}
