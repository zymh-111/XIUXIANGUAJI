/**
 * 无头截图（CDP 驱动 Edge）
 *
 * 用法：
 *   node _tools/shot.js <输出png> ["js表达式"] [--w 440] [--h 800] [--wait 900]
 *
 * 例：
 *   node _tools/shot.js %TEMP%/a.png "openFacility('hall')"      # 打开议事堂面板
 *   node _tools/shot.js %TEMP%/b.png "switchTo('zong')"          # 切到「宗」页
 *
 * 说明：起一个 headless Edge，连 CDP，先把页面跑一会儿（等资源），
 *       再执行表达式、等指定毫秒、整页截图。截图仅作内部校验，不要提交进仓库。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const out = process.argv[2] || path.join(os.tmpdir(), 'shot.png');
const expr = process.argv[3] || '';
const W = +arg('w', 440);
const H = +arg('h', 800);
const WAIT = +arg('wait', 900);
const BOOT = +arg('boot', 1600);
const PORT = +arg('port', 9333);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=' + W + ',' + H,
  url,
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const j = await r.json();
      const t = j.find(v => v.type === 'page' && /index\.html/.test(v.url));
      if (t) return t;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  const target = await listTargets();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(BOOT);
  if (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('表达式报错: ' + JSON.stringify(r.exceptionDetails));
  }
  await sleep(WAIT);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + out + '  (' + fs.statSync(out).size + ' B)');
  ws.close();
  child.kill();
  process.exit(0);
})().catch(e => {
  console.error('FAIL ' + e.message);
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
