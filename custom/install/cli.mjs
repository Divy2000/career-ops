#!/usr/bin/env node
// Entry point for install.sh's helper commands (see main() in lib.mjs). It is a
// separate file so lib.mjs stays importable without a main-module guard: the
// installer can run from a standalone copy where the repo's
// lib/is-main-module.mjs does not exist.
import { main } from './lib.mjs';

process.exitCode = main(process.argv.slice(2));
