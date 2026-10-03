#!/usr/bin/env node
// Test command for the run wrapper: prints lines, optionally sleeps, exits with a chosen code.
// usage: noisy.mjs [exitCode] [sleepMs]
const code = Number(process.argv[2] ?? 0);
const sleepMs = Number(process.argv[3] ?? 0);
console.log('line one');
console.log('line two');
console.error('warning line');
process.on('SIGTERM', () => {
  console.log('got SIGTERM');
  process.exit(143);
});
setTimeout(() => {
  console.log('line three');
  process.exit(code);
}, sleepMs);
