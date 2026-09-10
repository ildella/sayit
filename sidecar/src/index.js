import { createServer } from './server.js';
import { getToken, removeOwnPidfile } from './config.js';

// Started by the Tauri app (or standalone via `npm start` / systemd user unit).
const token = getToken();
createServer();

// Clean shutdowns remove our pidfile; kill -9 / OOM leave it stale, which
// recovery code tolerates by checking the pid is alive before trusting it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    removeOwnPidfile();
    process.exit(0);
  });
}
process.on('uncaughtException', (err) => {
  removeOwnPidfile();
  console.error(err);
  process.exit(1);
});

if (process.argv.includes('--print-token')) {
  console.log(token);
}
