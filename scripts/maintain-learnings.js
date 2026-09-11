#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { Learnings } from '../src/learnings.js';
import { scrub } from '../src/scrub.js';

try {
  const result = new Learnings(loadConfig()).maintain();
  console.log(JSON.stringify(result));
  if (result.rejected?.length) process.exitCode = 1;
} catch (e) {
  console.error(scrub(`learnings maintenance failed: ${e.message}`));
  process.exitCode = 1;
}
