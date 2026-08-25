#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sayit');
const token = fs.readFileSync(path.join(CONFIG_DIR, 'token'), 'utf8').trim();
const settings = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf8')); }
  catch { return {}; }
})();
const BASE = `http://${settings.host || '127.0.0.1'}:${settings.port || 7878}`;

async function api(method, pathName, body) {
  const res = await fetch(BASE + pathName, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

const CACHE_DIR = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const DATA_DIR = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const SIDECAR_LOG = path.join(CACHE_DIR, 'sayit', 'sidecar.log');

function listenSockets(file) {
  const out = [];
  try {
    const data = fs.readFileSync(file, 'utf8');
    for (const line of data.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      out.push({ port: parseInt(p[1].split(':')[1], 16), state: p[3], inode: p[9] });
    }
  } catch { /* missing file */ }
  return out;
}

/** Find the pid listening on `port` (Linux, pure Node via /proc). */
function findListeningPid(port) {
  const listeners = [...listenSockets('/proc/net/tcp'), ...listenSockets('/proc/net/tcp6')]
    .filter((s) => s.port === port && s.state === '0A');
  for (const { inode } of listeners) {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const fdDir = `/proc/${entry}/fd`;
      let fds;
      try { fds = fs.readdirSync(fdDir); } catch { continue; }
      for (const fd of fds) {
        try {
          if (fs.readlinkSync(path.join(fdDir, fd)) === `socket:[${inode}]`) return Number(entry);
        } catch { /* stale fd */ }
      }
    }
  }
  return null;
}

function findSidecarDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.SAYIT_SIDECAR_DIR,
    path.join(DATA_DIR, 'sayit', 'sidecar'),
    path.resolve(here, '..', 'sidecar'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'src', 'index.js'))) return dir;
  }
  return null;
}

async function isServiceUp() {
  await api('GET', '/v1/status');
  return true;
}

const USAGE = `sayit — local text-to-speech

Usage:
  sayit <text...>          Speak text
  echo "text" | sayit      Speak standard input
  sayit status             Player and engine status
  sayit pause | resume | stop
  sayit seek <seconds>     Seek relative (e.g. -10, +30)
  sayit speed <0.5-4>      Set playback speed
  sayit volume <0-2>       Set volume (0 = silence, 1 = normal)
  sayit voices             List voices
  sayit models             List models
  sayit models install <id> [--use]
  sayit models select <id>
  sayit models rm <id>
  sayit history            Show history
  sayit replay <id>        Replay a history entry
  sayit rm <id>            Delete a history entry
  sayit service status     Is the sidecar daemon running?
  sayit service start      Start the sidecar daemon (detached)
  sayit service stop       Stop the sidecar daemon
`;

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case undefined:
      if (!process.stdin.isTTY) {
        const text = (await readStdin()).trim();
        if (text) { await api('POST', '/v1/speak', { text }); break; }
      }
      console.log(USAGE);
      break;

    case '-h':
    case '--help':
      console.log(USAGE);
      break;

    case 'status': {
      const s = await api('GET', '/v1/status');
      const p = s.player;
      console.log(`state:    ${p.playing ? (p.paused ? 'paused' : 'speaking') : 'idle'}`);
      if (p.playing) console.log(`position: ${p.position.toFixed(1)}s / ${p.duration.toFixed(1)}s @ ${p.speed}x`);
      console.log(`engine:   ${s.engine.loaded ? 'loaded' : s.engine.loading ? 'loading…' : 'unloaded'} (${s.engine.model})`);
      break;
    }

    case 'pause': case 'resume': case 'stop':
      await api('POST', `/v1/${cmd}`);
      console.log('ok');
      break;

    case 'seek':
      await api('POST', '/v1/seek', { seconds: Number(args[0]) });
      console.log('ok');
      break;

    case 'speed':
      await api('POST', '/v1/speed', { speed: Number(args[0]) });
      console.log('ok');
      break;

    case 'volume':
      await api('POST', '/v1/volume', { volume: Number(args[0]) });
      console.log('ok');
      break;

    case 'voices': {
      for (const v of await api('GET', '/v1/voices')) {
        console.log(`${v.id.padEnd(14)} ${v.name.padEnd(10)} ${v.lang} ${v.gender}`);
      }
      break;
    }

    case 'models': {
      const sub = args[0];
      if (!sub) {
        const listed = await api('GET', '/v1/models');
        if (!Array.isArray(listed)) {
          console.error('error: sidecar returned a legacy models payload. Update it with scripts/setup-sidecar.sh');
          process.exitCode = 1;
          break;
        }
        for (const m of listed) {
          const flag = m.active ? 'active' : m.state;
          const size = Math.round((m.estimatedDiskBytes || 0) / 1e6);
          console.log(`${m.id.padEnd(14)} ${m.displayName.padEnd(16)} ${flag.padEnd(14)} ${size}MB`);
        }
        break;
      }
      const id = args[1];
      if (sub === 'install') {
        const use = args.includes('--use');
        await api('POST', `/v1/models/${id}/install`, { selectAfterInstall: use });
        console.log('ok');
      } else if (sub === 'select') {
        await api('POST', `/v1/models/${id}/select`);
        console.log('ok');
      } else if (sub === 'rm') {
        await api('DELETE', `/v1/models/${id}`);
        console.log('ok');
      } else {
        console.log('Usage: sayit models [install|select|rm] <id>');
        process.exitCode = 1;
      }
      break;
    }

    case 'history': {
      for (const e of await api('GET', '/v1/history')) {
        const preview = e.text.length > 60 ? e.text.slice(0, 60) + '…' : e.text;
        console.log(`${e.id.slice(0, 8)}  ${e.at.slice(0, 19)}  ${preview}`);
      }
      break;
    }

    case 'replay':
      await api('POST', '/v1/history/replay', { id: args[0] });
      console.log('ok');
      break;

    case 'rm':
      await api('DELETE', `/v1/history/${args[0]}`);
      console.log('ok');
      break;

    case 'service': {
      const sub = args[0];
      const port = settings.port || 7878;
      if (sub === 'status') {
        try {
          await isServiceUp();
          const pid = findListeningPid(port);
          console.log(`running${pid ? ` (pid ${pid})` : ''}`);
        } catch (err) {
          if (err.cause?.code === 'ECONNREFUSED') {
            console.log('stopped');
            process.exitCode = 1;
          } else {
            throw err;
          }
        }
      } else if (sub === 'start') {
        try {
          await isServiceUp();
          console.log('already running');
        } catch (err) {
          if (err.cause?.code !== 'ECONNREFUSED') throw err;
          const dir = findSidecarDir();
          if (!dir) {
            console.error('sidecar not found. Install it with: npm run setup  (or set $SAYIT_SIDECAR_DIR)');
            process.exitCode = 1;
            break;
          }
          fs.mkdirSync(path.dirname(SIDECAR_LOG), { recursive: true });
          const log = fs.openSync(SIDECAR_LOG, 'a');
          const child = spawn(process.execPath, ['src/index.js'], {
            cwd: dir,
            detached: true,
            stdio: ['ignore', log, log],
            env: process.env,
          });
          child.unref();
          let up = false;
          for (let i = 0; i < 20 && !up; i++) {
            await new Promise((r) => setTimeout(r, 150));
            try { await isServiceUp(); up = true; } catch { /* not up yet */ }
          }
          console.log(`started (pid ${child.pid})${up ? '' : ` — not responding yet; log: ${SIDECAR_LOG}`}`);
        }
      } else if (sub === 'stop') {
        const pid = findListeningPid(port);
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
          console.log(`stopped (pid ${pid})`);
        } else {
          console.log('not running');
          process.exitCode = 1;
        }
      } else {
        console.log('Usage: sayit service status|start|stop');
        process.exitCode = 1;
      }
      break;
    }

    default: {
      // Bare text (or "-"), or stdin when piped with no args.
      let text;
      if (cmd === '-') {
        text = (await readStdin()).trim();
      } else {
        text = [cmd, ...args].join(' ').trim();
      }
      if (!text) { console.log(USAGE); process.exit(1); }
      await api('POST', '/v1/speak', { text });
      break;
    }
  }
  process.exit(process.exitCode || 0);
} catch (err) {
  if (err.cause?.code === 'ECONNREFUSED') {
    console.error('sayit service is not running. Start it with: sayit service start');
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exit(1);
}
