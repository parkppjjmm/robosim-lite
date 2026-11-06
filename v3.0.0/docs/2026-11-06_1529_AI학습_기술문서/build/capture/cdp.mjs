// 최소 CDP 드라이버: 헤드리스 Chrome을 띄워 페이지를 열고, JS 평가·스크린샷·콘솔 수집
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
import { tmpdir } from 'node:os';
const SCRATCH = tmpdir().replace(/\\/g, '/'); // 임시 Chrome 프로필 위치

export async function open(url, { width = 1600, height = 950, port = 9333 } = {}) {
  const profile = `${SCRATCH}/chrome-profile-${Date.now()}`;
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const page = ver.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  const handlers = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    handlers.forEach((h) => h(m));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((r) => handlers.push((m) => m.method === 'Page.loadEventFired' && r()));
  await send('Page.navigate', { url });
  await loaded;
  const api = {
    logs,
    send,
    async eval(expr, awaitPromise = true) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
    },
    async reload() {
      const l = new Promise((r) => handlers.push((m) => m.method === 'Page.loadEventFired' && r()));
      await send('Page.reload', { ignoreCache: true });
      await l;
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    async until(expr, timeoutMs = 30000, every = 250) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await api.eval(expr)) return true;
        await api.wait(every);
      }
      return false;
    },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
  return api;
}
