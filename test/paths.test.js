'use strict';
// Windows correctness: every rule is exercised with path.win32 (and posix for contrast),
// on any host OS, with injected env and home directory. No fs access.
const assert = require('assert');
const path = require('path');
const { test } = require('./harness');
const { resolveDirs, lastSegment, lastSegments } = require('../lib/paths');

const W = path.win32;
const win = (env, extra, home) => resolveDirs({ pathMod: W, env, homedir: home === undefined ? 'C:\\Users\\Alex' : home, extra });

test('win32: default %USERPROFILE%\\.claude\\projects', () => {
  const dirs = win({ USERPROFILE: 'C:\\Users\\Alex' });
  assert.strictEqual(dirs[0], 'C:\\Users\\Alex\\.claude\\projects');
  assert.ok(dirs.every((d) => !d.includes('/')), 'no POSIX separators leaked: ' + dirs.join(' | '));
});

test('win32: CLAUDE_CONFIG_DIR is honored, with trailing slash, forward slashes, quotes and any env-name case', () => {
  assert.ok(win({ CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude' }).includes('D:\\cfg\\claude\\projects'));
  assert.ok(win({ CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude\\' }).includes('D:\\cfg\\claude\\projects'));
  assert.ok(win({ CLAUDE_CONFIG_DIR: 'D:/cfg/claude/' }).includes('D:\\cfg\\claude\\projects'));
  assert.ok(win({ CLAUDE_CONFIG_DIR: '"D:\\My Config\\claude"' }).includes('D:\\My Config\\claude\\projects'));
  assert.ok(win({ claude_config_dir: 'E:\\x' }).includes('E:\\x\\projects'), 'Windows env names are case-insensitive');
});

test('win32: CLAUDE_CONFIG_DIR may hold several dirs separated by ";" (not ":")', () => {
  const dirs = win({ CLAUDE_CONFIG_DIR: 'D:\\a;E:\\b' });
  assert.ok(dirs.includes('D:\\a\\projects') && dirs.includes('E:\\b\\projects'), dirs.join(' | '));
  assert.ok(!dirs.some((d) => /^[A-Z]$/.test(d)), 'drive letters must not be split on ":"');
});

test('win32: UNC and drive-root locations', () => {
  assert.ok(win({ CLAUDE_CONFIG_DIR: '\\\\fileserver\\home\\alex\\claude' }).includes('\\\\fileserver\\home\\alex\\claude\\projects'));
  assert.ok(win({}, ['C:\\']).includes('C:\\'));
});

test('win32: %VAR% and ~ expand in user-provided dirs; unknown vars are left alone', () => {
  const env = { USERPROFILE: 'C:\\Users\\Alex', OneDrive: 'C:\\Users\\Alex\\OneDrive' };
  const dirs = win(env, ['%USERPROFILE%\\work\\.claude\\projects', '%onedrive%\\claude\\projects', '~\\extra\\projects']);
  assert.ok(dirs.includes('C:\\Users\\Alex\\work\\.claude\\projects'));
  assert.ok(dirs.includes('C:\\Users\\Alex\\OneDrive\\claude\\projects'), 'case-insensitive %var%');
  assert.ok(dirs.includes('C:\\Users\\Alex\\extra\\projects'));
  assert.ok(win(env, ['%NOPE%\\x']).includes('C:\\Users\\Alex\\%NOPE%\\x'), 'unknown %VAR% is not silently dropped');
});

test('win32: dedupes case-insensitively and normalizes separators', () => {
  const dirs = win({ USERPROFILE: 'C:\\Users\\Alex' }, ['c:\\users\\alex\\.CLAUDE\\projects', 'C:/Users/Alex/.claude/projects/']);
  assert.strictEqual(dirs.filter((d) => d.toLowerCase() === 'c:\\users\\alex\\.claude\\projects').length, 1);
});

test('win32: relative user dirs resolve under the home folder, never the process cwd', () => {
  assert.ok(win({}, ['logs\\claude']).includes('C:\\Users\\Alex\\logs\\claude'));
  assert.deepStrictEqual(resolveDirs({ pathMod: W, env: {}, homedir: '', extra: ['logs'] }), []);
});

test('win32: home falls back to USERPROFILE when homedir is unavailable', () => {
  assert.strictEqual(resolveDirs({ pathMod: W, env: { USERPROFILE: 'C:\\Users\\Bo' } })[0], 'C:\\Users\\Bo\\.claude\\projects');
});

test('posix still works: HOME, CLAUDE_CONFIG_DIR with ":" lists, $VAR and ~', () => {
  const P = path.posix;
  const dirs = resolveDirs({ pathMod: P, homedir: '/home/alex', env: { CLAUDE_CONFIG_DIR: '/a:/b/', HOME: '/home/alex', W: '/work' }, extra: ['$W/.claude/projects', '~/x/projects'] });
  assert.deepStrictEqual(dirs.slice(0, 2), ['/home/alex/.claude/projects', '/home/alex/.config/claude/projects']);
  for (const want of ['/a/projects', '/b/projects', '/work/.claude/projects', '/home/alex/x/projects']) assert.ok(dirs.includes(want), want + ' in ' + dirs.join(' | '));
});

test('last path segment handles Windows and POSIX cwd values on any host', () => {
  assert.strictEqual(lastSegment('C:\\Users\\Alex\\work\\payments-api'), 'payments-api');
  assert.strictEqual(lastSegment('C:\\Users\\Alex\\work\\payments-api\\'), 'payments-api');
  assert.strictEqual(lastSegment('/home/alex/app'), 'app');
  assert.strictEqual(lastSegment('C:\\'), 'C:');
  assert.strictEqual(lastSegments('D:\\play\\app', 2), 'play/app');
});
