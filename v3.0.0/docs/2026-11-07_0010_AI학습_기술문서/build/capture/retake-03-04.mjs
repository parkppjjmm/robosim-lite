// 개정 5판(2026-11-07): 학습 진행률 막대가 들어간 학습 화면(s03·s04)만 다시 찍는 스크립트. 사용법은 shots.mjs와 같음
// node retake-03-04.mjs <images 폴더>   (v3.0.0 서버 python serve.py 8300 --no-browser 필요)
// 사용: v3.0.0 서버(python serve.py 8300 --no-browser)를 켠 뒤 node shots.mjs <출력 폴더> <policy-best.json 절대 경로>
import { open } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2];
const POLICY = process.argv[3];
mkdirSync(OUT, { recursive: true });
const H = 1700;
const b = await open('http://localhost:8300/?debug', { port: 9405, width: 1600, height: H });
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

try {
  await b.until('!!window.__robosim', 30000);
  await q(`window.__robosim.setState({ selectedMaker: 'KUKA', selectedRobotId: 'kuka-kr210-r2700' })`);
  await b.wait(800);
  await q(`location.reload()`); await b.wait(3000); await b.until('!!window.__robosim', 30000);
  await b.wait(2000);
  await q(`document.querySelector('#dross-toggle').click()`); await b.wait(4000);
  await q(`document.querySelector('[data-dr=view]').click()`); await b.wait(1500);
  await only(['lab']);
  // 진화 탐색을 앱에서 짧게 (120 s 과제, 후보 6 × 1세대) — 4판 s03과 같은 설정
  await q(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('[data-lab=method]', 'cem'); set('[data-lab=population]', 6); set('[data-lab=iterations]', 1); set('[data-lab=workers]', 6); set('[data-lab-task=timeLimitS]', 120); })()`);
  await q(`document.querySelector('[data-lab-act=start]').click()`);
  // 진행률이 0이 아닐 때(결정 2번 이상) 찍는다
  await b.until(`document.querySelectorAll('.lab-decisions tr').length >= 3 && /학습 중/.test(document.querySelector('.lab-status').textContent) && parseFloat(document.querySelector('.lab-run i').style.width) > 20`, 600000, 1000);
  await b.wait(1000);
  await scroll('.lab-status');
  await mark([['.lab-status', '1'], ['.lab-run', '2'], ['.lab-rate', '3'], ['.lab-chart', '4'], ['.lab-decisions', '5']]);
  await clip('.lab-status', 's03_lab_running', ['.lab-progress']);
  await unmark();
  await b.until(`/완료|중지됨|오류/.test(document.querySelector('.lab-status').textContent)`, 900000, 2000);
  log('cem done', await q(`document.querySelector('.lab-status').textContent`));
  await scroll('.lab-status');
  await mark([['.lab-run', '1'], ['[data-lab-act=replay-lab]', '2'], ['[data-lab-act=replay-rule]', '3'], ['[data-lab-act=save]', '4']]);
  await clip('.lab-status', 's04_lab_done', ['.lab-progress', '.lab-result', '.lab-summary']);
  await unmark();
  console.log('errors', JSON.stringify(b.logs.filter((l) => /error|exception/i.test(l)).slice(0, 5)));
} catch (e) {
  console.log('ERR', e.stack);
  await b.shot(`${OUT}/zz_error.png`).catch(() => {});
} finally {
  b.close();
}
