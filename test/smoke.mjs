// test/smoke.mjs — pure-logic checks plus a throwaway registry round-trip that proves
// the `reg.exe` quoting used by the host half stores a quoted command intact.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __test } from '../index.js';
import {
  BLOCKED_PORTS,
  buildLaunchScript,
  buildLauncherVbs,
  expectedCommand,
  launcherPaths,
  wscriptPath,
} from '../launcher.js';

const RUN_KEY = __test.RUN_KEY;
const TEST_VALUE = 'dsh-autostart self test';
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? '') });
    });
  });
}

// ── pure logic ──────────────────────────────────────────────────────────────
check('defaults: enabled is true', __test.effectiveConfig({}, '').enabled === true);
check('clamp drops unknown keys', JSON.stringify(__test.clampConfig({ enabled: false, nope: 1 })) === '{"enabled":false}');
check('clamp drops wrong types', JSON.stringify(__test.clampConfig({ enabled: 'yes' })) === '{}');
check('clamp trims exePath', __test.clampConfig({ exePath: '  C:\\a b\\app.exe  ' }).exePath === 'C:\\a b\\app.exe');
check('clamp drops empty exePath', __test.clampConfig({ exePath: '   ' }).exePath === undefined);

const dir = mkdtempSync(join(tmpdir(), 'dsh-autostart-'));
const file = join(dir, 'dsh-autostart.config.json');
writeFileSync(file, JSON.stringify({ enabled: false }), 'utf8');
check('file overrides defaults', __test.effectiveConfig({}, file).enabled === false);
check('patch overrides defaults', __test.effectiveConfig({ enabled: false }, join(dir, 'missing.json')).enabled === false);
rmSync(dir, { recursive: true, force: true });
check('corrupt file falls back', __test.effectiveConfig({}, '').enabled === true);

check('resolveExe uses configured path', __test.resolveExe({ exePath: 'C:\\x\\app.exe' }) === 'C:\\x\\app.exe');
check('resolveExe uses the desktop executable', __test.resolveExe({}, 'E:\\Apps\\X\\X.exe') === 'E:\\Apps\\X\\X.exe');
check('resolveExe ignores node.exe', __test.resolveExe({}, 'C:\\node\\node.exe') === '');
check('sameCommand ignores quotes and case', __test.sameCommand('"C:\\A\\X.exe"', 'c:\\a\\x.exe') === true);
check('sameCommand rejects different paths', __test.sameCommand('"C:\\A\\X.exe"', '"C:\\A\\Y.exe"') === false);

check('fence rejects foreign peer',
  __test.inspectRequest({ headers: {}, socket: { remoteAddress: '10.0.0.2' } }).trusted === false);
check('fence accepts loopback without origin',
  __test.inspectRequest({ headers: { host: '127.0.0.1:2307' }, socket: { remoteAddress: '127.0.0.1' } }).trusted === true);
check('fence rejects foreign origin',
  __test.inspectRequest({
    headers: { host: '127.0.0.1:2307', origin: 'https://evil.example' },
    socket: { remoteAddress: '127.0.0.1' },
  }).trusted === false);
check('fence accepts same origin',
  __test.inspectRequest({
    headers: { host: '127.0.0.1:2307', origin: 'http://127.0.0.1:2307' },
    socket: { remoteAddress: '127.0.0.1' },
  }).trusted === true);

// ── launcher generation (pure; nothing is written or run) ───────────────────
const EXE = 'E:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe';
const launcherConfigFile = join(tmpdir(), 'dsh-autostart-profile', 'dsh-autostart.config.json');
const paths = launcherPaths(launcherConfigFile);
const script = buildLaunchScript({ exe: EXE, logPath: paths.log });

check('blocked ports are all inside the dynamic range',
  BLOCKED_PORTS.length === 17 && BLOCKED_PORTS.every((port) => port >= 1024 && port <= 15001));
check('launcher script targets the executable',
  script.includes(`[string]$ExePath = 'E:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe'`));
check('launcher script logs beside the preference',
  script.includes('launch.log') && !script.includes('__LOG__'));
check('launcher script reserves every blocked port',
  script.includes(BLOCKED_PORTS.join(',')));
check('launcher script retries a fetch-blocked-port crash',
  script.includes("$report -notmatch 'bad port'") && script.includes('$attempt -le $MaxAttempts'));
check('launcher script releases its reservations in a finally block',
  script.includes('} finally {') && script.includes('$listener.Stop()'));
check('launcher script needs an executable', throws(() => buildLaunchScript({ logPath: paths.log })));

const vbs = buildLauncherVbs(paths.script, EXE);
check('trampoline runs PowerShell without a window',
  vbs.includes('powershell.exe') && vbs.includes(', 0, False'));
check('trampoline quotes its command the way VBScript needs',
  vbs.includes('shell.Run """') && vbs.includes('""", 0, False'));
check('trampoline falls back to the executable when the script is gone',
  vbs.includes('fso.FileExists') && vbs.includes('Else'));
check('launcher lives in its own folder inside the profile',
  paths.dir === join(dirname(launcherConfigFile), 'dsh-autostart')
  && paths.script === join(paths.dir, 'launch.ps1'));
check('launcher command starts wscript with the trampoline',
  expectedCommand({ launchMode: 'launcher' }, EXE, launcherConfigFile).includes(wscriptPath())
  && expectedCommand({ launchMode: 'launcher' }, EXE, launcherConfigFile).includes(paths.vbs));
check('direct mode puts the executable itself in the registry',
  expectedCommand({ launchMode: 'direct' }, EXE, launcherConfigFile) === `"${EXE}"`);
check('no executable means no command',
  expectedCommand({ launchMode: 'launcher' }, '', launcherConfigFile) === '');
check('clamp keeps a known launch mode',
  __test.clampConfig({ launchMode: 'direct' }).launchMode === 'direct');
check('clamp drops an unknown launch mode',
  __test.clampConfig({ launchMode: 'magic' }).launchMode === undefined);
check('defaults launch through the launcher', __test.effectiveConfig({}, '').launchMode === 'launcher');

// ── registry round-trip (throwaway value name, never the real login item) ────
const command = '"C:\\Program Files\\Some App\\Some App.exe"';
const added = await reg(['add', RUN_KEY, '/v', TEST_VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
check('reg add succeeds', added.ok, added.stdout);
const queried = await reg(['query', RUN_KEY, '/v', TEST_VALUE]);
const line = queried.stdout.split(/\r?\n/).find((candidate) => candidate.includes(TEST_VALUE)) ?? '';
const stored = (/REG_SZ\s+(.+?)\s*$/.exec(line) ?? [])[1];
check('quoted command round-trips', stored !== undefined && __test.sameCommand(stored, command), { stored });
await reg(['delete', RUN_KEY, '/v', TEST_VALUE, '/f']);
const after = await reg(['query', RUN_KEY, '/v', TEST_VALUE]);
check('reg delete removes it', after.ok === false);

// Never call applyDesired({ enabled: false }) here: it removes the *real* login item,
// and this test also runs on the machine where the plugin is actually installed.
const noExe = await __test.applyDesired({ enabled: true, exePath: '' });
check('applyDesired(on) without executable is refused',
  noExe.ok === false && ['executable-unknown', 'executable-missing'].includes(noExe.reason));
const missing = await __test.applyDesired({ enabled: true, exePath: 'C:\\\\definitely\\\\missing\\\\app.exe' });
check('applyDesired(on) with a missing executable is refused',
  missing.ok === false && missing.reason === 'executable-missing');

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
