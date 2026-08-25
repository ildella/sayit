import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { MPV_SOCKET } from './config.js';
import { EventEmitter } from 'node:events';

/**
 * Playback via mpv's JSON IPC (pause / resume / seek / speed / position),
 * falling back to fire-and-forget aplay when mpv is unavailable.
 */
class Player extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ipc = null;
    this.reqId = 0;
    this.pending = new Map();
    this.state = {
      playing: false, paused: false, position: 0, duration: 0,
      speed: 1.0, volume: 1.0, file: null, controllable: false,
    };
    this._hasMpv = null;
  }

  async detectMpv() {
    if (this._hasMpv !== null) return this._hasMpv;
    this._hasMpv = await new Promise((resolve) => {
      const p = spawn('mpv', ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
    return this._hasMpv;
  }

  async play(file, { speed = 1.0, volume = 1.0 } = {}) {
    await this.stop();
    this.state = { ...this.state, playing: true, paused: false, position: 0, speed, volume, file };

    if (await this.detectMpv()) {
      try { fs.unlinkSync(MPV_SOCKET); } catch { /* stale socket */ }
      this.proc = spawn('mpv', [
        '--no-terminal', '--really-quiet', '--idle=no',
        `--input-ipc-server=${MPV_SOCKET}`,
        // Software amplification up to 200%, so volume can span silence (0) to 2x.
        '--volume-max=200',
        `--speed=${speed}`,
        `--volume=${Math.round(volume * 100)}`,
        file,
      ], { stdio: 'ignore' });
      this.proc.on('error', () => this._fallback(file));
      this.proc.on('close', () => {
        if (this.state.file === file) {
          this.state.playing = false;
          this.emit('state', this.state);
          this.emit('finished');
        }
      });
      this.state.controllable = true;
      this._connectIpc();
    } else {
      this._fallback(file);
    }
    this.emit('state', this.state);
  }

  _fallback(file) {
    this.state.controllable = false;
    this.proc = spawn('aplay', ['-q', file], { stdio: 'ignore' });
    this.proc.on('error', () => {
      this.state.playing = false;
      this.emit('error', new Error('Neither mpv nor aplay is available'));
    });
    this.proc.on('close', () => {
      this.state.playing = false;
      this.emit('state', this.state);
      this.emit('finished');
    });
  }

  _connectIpc() {
    // mpv creates the socket asynchronously; retry briefly.
    let attempts = 0;
    const tryConnect = () => {
      const sock = net.createConnection(MPV_SOCKET);
      sock.on('connect', () => {
        this.ipc = sock;
        let buf = '';
        sock.on('data', (d) => {
          buf += d.toString();
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) this._onIpcMessage(line);
          }
        });
        // Observe the properties the UI needs.
        for (const prop of ['time-pos', 'duration', 'pause', 'volume']) {
          this._send('observe_property', [this.reqId, prop]);
        }
      });
      sock.on('error', () => {
        if (++attempts < 20) setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  }

  _onIpcMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.request_id && this.pending.has(msg.request_id)) {
      this.pending.get(msg.request_id)(msg);
      this.pending.delete(msg.request_id);
      return;
    }
    if (msg.event === 'property-change') {
      if (msg.name === 'time-pos') this.state.position = msg.data ?? 0;
      if (msg.name === 'duration') this.state.duration = msg.data ?? 0;
      if (msg.name === 'pause') this.state.paused = Boolean(msg.data);
      if (typeof msg.data === 'number' && msg.name === 'volume') {
        this.state.volume = msg.data / 100;
      }
      this.emit('state', this.state);
    }
  }

  _send(command, args = []) {
    return new Promise((resolve) => {
      if (!this.ipc) return resolve(null);
      const id = ++this.reqId;
      this.pending.set(id, resolve);
      this.ipc.write(JSON.stringify({ command: [command, ...args], request_id: id }) + '\n');
    });
  }

  async pause() {
    await this._send('set_property', ['pause', true]);
  }

  async resume() {
    await this._send('set_property', ['pause', false]);
  }

  async seek(seconds) {
    await this._send('seek', [seconds, 'relative']);
  }

  async setSpeed(speed) {
    speed = Math.min(4, Math.max(0.5, speed));
    this.state.speed = speed;
    await this._send('set_property', ['speed', speed]);
    this.emit('state', this.state);
  }

  /**
   * Volume in the 0–2 range (0 = silence), mirroring Say It on macOS.
   * mpv stores volume as a percentage; --volume-max=200 allows >100%.
   */
  async setVolume(volume) {
    if (!Number.isFinite(volume)) return;
    volume = Math.min(2, Math.max(0, volume));
    this.state.volume = volume;
    await this._send('set_property', ['volume', Math.round(volume * 100)]);
    this.emit('state', this.state);
  }

  async stop() {
    if (this.ipc) { try { this.ipc.destroy(); } catch { /* ignore */ } this.ipc = null; }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
    this.state.playing = false;
    this.state.paused = false;
    this.state.position = 0;
    this.emit('state', this.state);
  }
}

export const player = new Player();
