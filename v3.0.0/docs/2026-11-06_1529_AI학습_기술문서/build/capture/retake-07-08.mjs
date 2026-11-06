// shots.mjs 뒤에 CSS를 고쳐 07·08만 다시 찍은 스크립트 (사용법은 shots.mjs와 같음)
// 앱 학습·재생 패널 사용법 스크린샷 (헤드리스 Chrome, swiftshader) — 기술 문서용
import { open } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2];
const POLICY = process.argv[3];
mkdirSync(OUT, { recursive: true });
const H = 1700;
const b = await open('http://localhost:8300/?debug', { port: 9403, width: 1600, height: H });
const q = (js) => b.eval(js);
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function full(name) {
  await b.wait(400);
  await b.shot(`${OUT}/${name}.png`);
  log('shot', name);
}
// sel 위쪽부터 ends 중 보이는 마지막 요소 아래까지 (없으면 sel 자체), 너비는 패널 섹션 너비
async function clip(sel, name, ends = [], maxH = H) {
  const r = await q(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    const b = e.getBoundingClientRect(); const sec = e.closest('.sec') ?? e; const sb = sec.getBoundingClientRect();
    let bottom = b.bottom; for (const s of ${JSON.stringify(ends)}) { const x = document.querySelector(s); if (x && x.offsetParent) bottom = Math.max(bottom, x.getBoundingClientRect().bottom); }
    return [sb.x, b.y, sb.width, bottom - b.y]; })()`);
  await b.wait(400);
  const [x, y, w, h] = r;
  const res = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: x - 2, y: Math.max(0, y - 2), width: w + 4, height: Math.min(h + 4, maxH - Math.max(0, y - 2)), scale: 1 } });
  (await import('node:fs')).writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.data, 'base64'));
  log('clip', name, Math.round(w), Math.round(h));
}
async function scroll(sel) {
  await q(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'start' }); const p = e.closest('.panel'); if (p) p.scrollTop -= 6; })()`);
  await b.wait(400);
}
// 버튼 표시: 빨간 테두리 + 번호 배지
async function mark(list) {
  await q(`(() => { document.querySelectorAll('.__mk').forEach((e) => e.remove()); document.querySelectorAll('[data-mk]').forEach((e) => { e.style.outline = ''; e.removeAttribute('data-mk'); });
    ${JSON.stringify(list)}.forEach(([sel, label]) => { const e = document.querySelector(sel); if (!e) return; e.setAttribute('data-mk', '1'); e.style.outline = '3px solid #e5484d'; e.style.outlineOffset = '1px';
      const r = e.getBoundingClientRect(); const s = document.createElement('div'); s.className = '__mk'; s.textContent = label;
      Object.assign(s.style, { position: 'fixed', left: Math.min(r.right - 10, window.innerWidth - 40) + 'px', top: (r.top - 12) + 'px', background: '#e5484d', color: '#fff', font: 'bold 13px system-ui', borderRadius: '11px', minWidth: '22px', height: '22px', lineHeight: '22px', textAlign: 'center', padding: '0 4px', zIndex: 9999, boxShadow: '0 1px 3px rgba(0,0,0,.5)' });
      document.body.appendChild(s); }); })()`);
}
const unmark = () => mark([]);
// 보이는 섹션만 펼치기
async function only(keys) {
  await q(`(() => { const ks = ${JSON.stringify(keys)}; document.querySelectorAll('.sec[data-sec]').forEach((s) => { const want = ks.includes(s.dataset.sec); if (s.classList.contains('collapsed') === want) s.querySelector('.sec-toggle').click(); }); })()`);
  await b.wait(300);
}
// 07·08만 다시 (CSS 수정 후)
try {
  await b.until('!!window.__robosim', 30000);
  await q(`window.__robosim.setState({ selectedMaker: 'KUKA', selectedRobotId: 'kuka-kr210-r2700' })`);
  await b.wait(800);
  await q(`location.reload()`); await b.wait(3000); await b.until('!!window.__robosim', 30000);
  await b.wait(1500);
  await q(`document.querySelector('#dross-toggle').click()`); await b.wait(4000);
  await only(['lab']);
  await b.send('DOM.enable');
  const doc = await b.send('DOM.getDocument', { depth: -1 });
  const node = await b.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[data-lab-act=policy-file]' });
  await b.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [POLICY] });
  await b.until(`/정책을 불러왔습니다/.test(document.querySelector('.lab-status').textContent)`, 20000, 500);
  await q(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }; set('[data-lab=workers]', 6); set('[data-lab-task=timeLimitS]', 120); })()`);
  await q(`document.querySelector('[data-lab-act=start]').click()`);
  await b.until(`/완료|중지됨|오류/.test(document.querySelector('.lab-status').textContent)`, 900000, 2000);
  log('policy done', await q(`document.querySelector('.lab-status').textContent`));
  await scroll('.lab-status');
  await mark([['.lab-decisions', '1'], ['.lab-summary', '2']]);
  await clip('.lab-status', '07_policy_done', ['.lab-progress', '.lab-result', '.lab-summary']);
  await unmark();
  await only(['replay']);
  await b.until(`document.querySelector('[data-rp=run]').options.length > 3`, 20000, 500);
  await q(`(() => { const r = document.querySelector('[data-rp=run]'); const o = [...r.options].find((x) => /13:11 · PPO 학습 · kr210-run2/.test(x.textContent)); if (o) { r.value = o.value; r.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await b.wait(1000);
  await q(`(() => { const r = document.querySelector('[data-rp=ep]'); const o = [...r.options].find((x) => /ppo-alone-s11/.test(x.value)); if (o) { r.value = o.value; r.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await scroll('.sec[data-sec=replay]');
  await mark([['[data-rp=run]', '1'], ['[data-rp=ep]', '2'], ['[data-rp=open-list]', '3'], ['[data-rp=reload-list]', '4'], ['[data-rp=open]', '5']]);
  await clip('.sec[data-sec=replay]', '08_results_list');
  console.log('errors', JSON.stringify(b.logs.filter((l) => /error|exception/i.test(l)).slice(0, 5)));
} catch (e) {
  console.log('ERR', e.stack);
} finally {
  b.close();
}
