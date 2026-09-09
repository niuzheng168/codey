// Read-only admission check for tasks owned by the existing Codex app daemon.
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pid = execFileSync('systemctl', ['--user', 'show', 'codey-cloudcli.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('CloudCLI service is not running');
const directory = readlinkSync(`/proc/${pid}/cwd`);
const environment = new Map(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((item) => {
  const at = item.indexOf('=');
  return [item.slice(0, at), item.slice(at + 1)];
}));
// Only home selection is needed; model/SSO/TLS credentials never leave /proc.
for (const key of ['HOME', 'CODEX_HOME']) {
  if (environment.has(key)) process.env[key] = environment.get(key);
}
const { CodexDaemonClient } = await import(pathToFileURL(path.join(
  directory, 'dist-server/server/modules/providers/list/codex/codex-daemon.client.js',
)).href);
const client = await CodexDaemonClient.connect();
if (!client) {
  console.log(JSON.stringify({ available: false, loadedCount: 0, activeCount: 0 }));
} else {
  try {
    const ids = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const response = await client.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response.data)) throw new Error('Unexpected native loaded-thread response');
      for (const item of response.data) {
        const id = typeof item === 'string' ? item : item.id;
        if (typeof id !== 'string' || !id) throw new Error('Invalid native thread identity');
        ids.add(id);
      }
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error('Native task listing exceeded the admission limit');
    let activeCount = 0;
    for (const threadId of ids) {
      const response = await client.request('thread/read', { threadId, includeTurns: false });
      const status = response.thread?.status?.type;
      if (!['idle', 'active', 'notLoaded', 'systemError'].includes(status)) throw new Error('Unknown native task status');
      if (status === 'active' || status === 'systemError') activeCount++;
    }
    console.log(JSON.stringify({ available: true, loadedCount: ids.size, activeCount }));
    if (activeCount) process.exitCode = 2;
  } finally {
    client.close();
  }
}
