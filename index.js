// dsh-autostart — host half.
//
// Owns one Windows per-user login item and nothing else:
//
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run  →  "…\wscript.exe" //nologo "…\launch.vbs"
//
// By default the value starts the generated hidden launcher (see launcher.js) rather
// than the executable itself: the Desktop shell bootstraps on a `--port 0` port, and
// the rare bootstrap port that fetch calls blocked aborts startup with a dialog. The
// launcher holds those ports during one bootstrap and retries a failed start.
// `launchMode: "direct"` puts the executable back in the value for troubleshooting.
//

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { ensureLauncher, expectedCommand, launcherPaths, wscriptPath } from './launcher.js';

export const name = 'dsh-autostart';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'DeepSeek Harness';
const CONFIG_FILE_NAME = 'dsh-autostart.config.json';
const ROUTES = '/plugins/dsh-autostart';
const MAX_BODY_BYTES = 64 * 1024;

/** Code defaults. The patch row's `config` (second apply argument) and the config file override these in that order. */
export const DEFAULTS = Object.freeze({ enabled: true, exePath: '', launchMode: 'launcher' });

// ─────────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────────

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown';
  if (typeof error === 'string') return error;
  const message = error.message ?? String(error);
  return message || 'unknown';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only known keys with known types; never throw, never invent keys. */
export function clampConfig(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.exePath === 'string') {
    const trimmed = raw.exePath.trim();
    if (trimmed) out.exePath = trimmed;
  }
  if (raw.launchMode === 'launcher' || raw.launchMode === 'direct') out.launchMode = raw.launchMode;
  return out;
}

/** Where the preference lives: inside the profile when it exists, otherwise beside DSH_HOME. */
export function resolveConfigFile(env = process.env) {
  const explicit = env.DSH_PROFILE_DIR;
  if (explicit) return join(explicit, CONFIG_FILE_NAME);
  const home = env.DSH_HOME || (env.USERPROFILE ? join(env.USERPROFILE, '.dsh') : '');
  if (!home) return '';
  const profileDir = join(home, 'profiles', env.DSH_PROFILE || 'desktop');
  try {
    if (statSync(profileDir).isDirectory()) return join(profileDir, CONFIG_FILE_NAME);
  } catch {
    /* no such profile directory — fall back to the home root */
  }
  return join(home, CONFIG_FILE_NAME);
}

export function loadFileConfig(file) {
  if (!file || !existsSync(file)) return {};
  try {
    return clampConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {}; // a corrupt preference file must never break activation
  }
}

function saveFileConfig(file, next) {
  if (!file) throw new Error('preference file location is unknown');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** DEFAULTS < patch config < config file. */
export function effectiveConfig(patchConfig, file = resolveConfigFile()) {
  return { ...DEFAULTS, ...clampConfig(patchConfig), ...loadFileConfig(file) };
}

/**
 * The command the login item should launch.
 *
 * The Desktop host runs *as* the shipped Electron executable, so `process.execPath`
 * is exactly what a login item has to start. An explicit `exePath` still wins.
 */
export function resolveExe(eff, execPath = process.execPath) {
  const configured = typeof eff.exePath === 'string' ? eff.exePath.trim() : '';
  if (configured) return resolvePath(configured);
  if (typeof execPath === 'string' && /\.exe$/i.test(execPath) && basename(execPath).toLowerCase() !== 'node.exe') {
    return execPath;
  }
  return '';
}

const stripQuotes = (value) => String(value ?? '').trim().replace(/^"(.*)"$/s, '$1').trim();

/** Compare two login-item commands the way Windows would: quotes are decoration, case does not matter. */
export function sameCommand(a, b) {
  return stripQuotes(a).toLowerCase() === stripQuotes(b).toLowerCase();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// request fence
//
// The switch is a browser fetch, so the only thing worth defending against is a
// foreign web origin (CSRF / DNS rebinding). Same rules as the desktop ecosystem:
// the peer must be loopback, a present Host must be a loopback authority, and a
// present Origin must match it. The Desktop build's stripping proxy removes some
// headers, so absent headers are tolerated rather than refused.
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function loopbackAuthority(host) {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  const hostname = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function inspectRequest(req) {
  const headers = req.headers ?? {};
  const peer = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK_PEERS.has(peer)) return { trusted: false, reason: 'peer-not-loopback' };
  const host = headers.host;
  if (host !== undefined && !loopbackAuthority(host)) return { trusted: false, reason: 'host-not-loopback' };
  const origin = headers.origin;
  if (origin === undefined) return { trusted: true, reason: '' }; // stripping proxy form
  let ok = false;
  try {
    const url = new URL(origin);
    ok = (url.protocol === 'http:' || url.protocol === 'https:')
      && (host !== undefined ? url.host === host : loopbackAuthority(url.host));
  } catch {
    ok = false; // `Origin: null` or malformed
  }
  return ok ? { trusted: true, reason: '' } : { trusted: false, reason: 'origin-mismatch' };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(isPlainObject(parsed) ? parsed : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows login item
// ─────────────────────────────────────────────────────────────────────────────

function runReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** Current login item command, or null when the value does not exist. */
export async function readLoginItem() {
  if (process.platform !== 'win32') return null;
  const result = await runReg(['query', RUN_KEY, '/v', VALUE_NAME]);
  if (!result.ok) return null; // `reg query` exits 1 when the value is absent
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.includes(VALUE_NAME));
  if (!line) return null;
  const match = /REG_SZ\s+(.+?)\s*$/.exec(line);
  return match ? match[1].trim() : null;
}

async function writeLoginItem(command) {
  const result = await runReg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  if (!result.ok) throw new Error(result.stderr.trim() || `reg add failed (exit ${result.code})`);
  // Read back: a value stored with mangled quotes would otherwise only fail at the next login.
  const stored = await readLoginItem();
  if (!sameCommand(stored, command)) {
    throw new Error(`the login item did not read back as written (stored: ${stored ?? 'nothing'})`);
  }
}

async function deleteLoginItem() {
  const result = await runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  if (!result.ok) {
    const stored = await readLoginItem();
    if (stored !== null) throw new Error(result.stderr.trim() || `reg delete failed (exit ${result.code})`);
  }
}

/**
 * Make the registry match the preference. Idempotent: a matching value is left alone,
 * and turning the switch off removes the value only when it exists.
 */
export async function applyDesired(eff, configFile = resolveConfigFile()) {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  if (eff.enabled) {
    const exe = resolveExe(eff);
    if (!exe) return { ok: false, reason: 'executable-unknown' };
    if (!existsSync(exe)) return { ok: false, reason: 'executable-missing' };
    let mode = eff.launchMode === 'direct' ? 'direct' : 'launcher';
    let launchError = '';
    if (mode === 'launcher') {
      try {
        ensureLauncher(exe, configFile);
      } catch (error) {
        // A broken launcher must not cost the user autostart: fall back to the executable.
        launchError = errorMessage(error);
        mode = 'direct';
      }
    }
    const command = expectedCommand({ launchMode: mode }, exe, configFile);
    const current = await readLoginItem();
    if (!sameCommand(current, command)) await writeLoginItem(command);
    return launchError
      ? { ok: true, enabled: true, command, mode, launcherError: launchError }
      : { ok: true, enabled: true, command, mode };
  }
  const current = await readLoginItem();
  if (current !== null) await deleteLoginItem();
  return { ok: true, enabled: false, command: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// state / routes
// ─────────────────────────────────────────────────────────────────────────────

async function describeState(eff, configFile, extra = {}) {
  const supported = process.platform === 'win32';
  const exe = supported ? resolveExe(eff) : '';
  const exeExists = Boolean(exe) && existsSync(exe);
  const current = supported ? await readLoginItem() : null;
  const want = supported && exe ? expectedCommand(eff, exe, configFile) : '';
  const active = Boolean(eff.enabled && exeExists && current !== null && sameCommand(current, want));
  const paths = launcherPaths(configFile);
  return {
    ok: true,
    platform: process.platform,
    supported,
    config: eff,
    configFile: configFile || '',
    executable: exe,
    executableExists: exeExists,
    loginItem: current,
    /** The command the preference asks the registry to hold (launcher or executable). */
    expectedLoginItem: want,
    /** Generated launcher paths; `ready` means both files exist on disk. */
    launcher: {
      mode: eff.launchMode === 'direct' ? 'direct' : 'launcher',
      directory: paths.dir,
      script: paths.script,
      trampoline: paths.vbs,
      log: paths.log,
      ready: Boolean(paths.vbs) && existsSync(paths.vbs) && existsSync(paths.script),
    },
    /** The registry really holds an entry pointing at what we would launch. */
    active,
    ...extra,
  };
}

function handleState(req, res, patchConfig) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' });
    res.end();
    return;
  }
  const verdict = inspectRequest(req);
  if (!verdict.trusted) return sendJson(res, 403, { ok: false, reason: 'untrusted', detail: verdict.reason });
  const configFile = resolveConfigFile();
  return describeState(effectiveConfig(patchConfig, configFile), configFile).then(
    (state) => sendJson(res, 200, state),
    (error) => sendJson(res, 500, { ok: false, reason: 'state-failed', detail: errorMessage(error) }),
  );
}

async function handleConfig(req, res, patchConfig, enqueue) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  const verdict = inspectRequest(req);
  if (!verdict.trusted) return sendJson(res, 403, { ok: false, reason: 'untrusted', detail: verdict.reason });
  const body = await readJsonBody(req);
  if (body === undefined) return sendJson(res, 400, { ok: false, reason: 'bad-json' });

  const patch = clampConfig(body);
  if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, reason: 'no-known-keys' });
  if (patch.exePath !== undefined) {
    const resolved = resolvePath(patch.exePath);
    let isFile = false;
    try {
      isFile = existsSync(resolved);
    } catch {
      isFile = false;
    }
    if (!isFile) return sendJson(res, 400, { ok: false, reason: 'exe-invalid', detail: patch.exePath });
  }

  const configFile = resolveConfigFile();
  try {
    saveFileConfig(configFile, { ...effectiveConfig(patchConfig, configFile), ...patch });
  } catch (error) {
    return sendJson(res, 500, { ok: false, reason: 'save-failed', detail: errorMessage(error) });
  }

  const eff = effectiveConfig(patchConfig, configFile);
  const applied = await enqueue(() => applyDesired(eff, configFile));
  if (applied && applied.ok === false) {
    const state = await describeState(eff, configFile, { saved: true, reason: applied.reason });
    return sendJson(res, 409, state);
  }
  const state = await describeState(eff, configFile, { saved: true });
  return sendJson(res, 200, state);
}

// ─────────────────────────────────────────────────────────────────────────────
// plugin entry
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const patchConfig = isPlainObject(config) ? config : {};
  const configFile = resolveConfigFile();

  // Serialize registry work: a rapid on/off/on from the switch must not interleave
  // two reg.exe invocations, and the last write has to be the last preference.
  let tail = Promise.resolve();
  const lastError = { message: '' };
  function enqueue(job) {
    const run = tail.then(async () => {
      try {
        const value = await job();
        lastError.message = '';
        return value;
      } catch (error) {
        lastError.message = errorMessage(error);
        return { ok: false, reason: 'apply-failed', detail: lastError.message };
      }
    });
    tail = run.then(() => {}, () => {});
    return run;
  }

  // Installed ⇒ enabled: every activation reconciles the login item with the stored
  // preference, so a plugin reinstalled over an old config reports the truth instead
  // of silently keeping a stale entry.
  void enqueue(() => applyDesired(effectiveConfig(patchConfig, configFile), configFile));

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const registrations = [
        hostCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTES}/state`,
          handler: (req, res) => handleState(req, res, patchConfig),
        }),
        hostCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTES}/config`,
          handler: (req, res) => handleConfig(req, res, patchConfig, enqueue),
        }),
      ];
      return () => {
        for (const dispose of registrations) {
          try {
            dispose?.();
          } catch {
            /* already gone */
          }
        }
      };
    }, 'dsh-autostart: http routes');
  });
}

/** Exposed for the plugin's own smoke test (`test/smoke.mjs`). */
export const __test = {
  RUN_KEY,
  VALUE_NAME,
  clampConfig,
  effectiveConfig,
  resolveExe,
  resolveConfigFile,
  sameCommand,
  inspectRequest,
  loadFileConfig,
  readLoginItem,
  applyDesired,
  wscriptPath,
  launcherPaths,
  expectedCommand,
};
