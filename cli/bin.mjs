#!/usr/bin/env node
import { runCli } from './main.mjs';

runCli(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
