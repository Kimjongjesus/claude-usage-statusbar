'use strict';
// Runs every test/*.test.js in-process. No dependencies.
const fs = require('fs');
const path = require('path');
const { runAll } = require('./harness');

for (const f of fs.readdirSync(__dirname).sort()) if (f.endsWith('.test.js')) { console.log(f); require(path.join(__dirname, f)); }
runAll().then((failed) => { process.exitCode = failed ? 1 : 0; });
