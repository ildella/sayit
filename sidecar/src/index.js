import { createServer } from './server.js';
import { getToken, getSettings } from './config.js';

// Started by the Tauri app (or standalone via `npm start` / systemd user unit).
const token = getToken();
createServer();

if (process.argv.includes('--print-token')) {
  console.log(token);
}
