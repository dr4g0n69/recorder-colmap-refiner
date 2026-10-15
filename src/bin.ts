#!/usr/bin/env node

import { runRefinerCli } from './cli.js';

process.exitCode = await runRefinerCli(process.argv.slice(2), console.log);
