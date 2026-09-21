#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { errorCode } from '../src/constants.mjs';
try { await main(); }
catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: errorCode(error) }) + '\n');
  process.exitCode = 2;
}
