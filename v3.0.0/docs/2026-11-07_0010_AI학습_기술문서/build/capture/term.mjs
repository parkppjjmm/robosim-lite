// launcher 실제 출력(파이프 입력이라 입력값이 안 보임)에 사용자가 친 값을 다시 넣어 콘솔 모양 HTML로 만든 뒤 촬영
import { readFileSync, writeFileSync } from 'node:fs';
import { open } from './cdp.mjs';
// 사용: printf '2\n1\n10\n14\nrun3\ny\nn\nn\n5\n0\n' | node tools/launcher.mjs > <작업 폴더>/launcher-out.txt → node term.mjs <작업 폴더> (<작업 폴더>/shots/에 PNG)
const S = (process.argv[2] ?? '.').replace(/\\/g, '/');
const raw = readFileSync(`${S}/launcher-out.txt`, 'utf8');
const answers = ['2', '1', '10', '14', 'run3', 'y', 'n', 'n', '5', '0'];
let k = 0;
// 프롬프트 끝(": ")마다 입력값과 줄바꿈을 넣는다
const prompts = /(번호를 고르세요 \[0\]: |번호 \[1\]: |\[10\]: |\[14\]: |\[run3\]: |\(y\/n\) \[y\]: )/g;
let text = raw.replace(prompts, (m) => `${m}\u0001${answers[k++] ?? ''}\u0002\n`).replace(/\n\n+/g, '\n\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = (body, title) => (title = title.replace(/\\/g, '&#92;'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0c0c0c}.win{width:1180px;margin:0;border:1px solid #333;font:14.5px/1.45 Consolas,'Malgun Gothic',monospace;color:#cccccc}
.bar{background:#1f1f1f;color:#ddd;font:13px 'Malgun Gothic',system-ui;padding:7px 12px}
pre{margin:0;padding:12px 14px;white-space:pre-wrap;font:inherit}.in{color:#f9f1a5;font-weight:bold}</style>
<div class="win"><div class="bar">${title}</div><pre>${body}</pre></div>`);
const toHtml = (t) => esc(t).replace(/\u0001(.*?)\u0002/g, '<span class="in">$1</span>');
const parts = text.split(/(?=^─+\n RoboSim)/m);
// parts[0]=''?, [1]=메뉴+2번 질문, [2]=메뉴+5번 결과, [3]=메뉴+0
const p = parts.filter((x) => x.trim());
const a = p[0].replace(/\n시작할까요\?.*$/s, (m) => m.split('\n').slice(0, 2).join('\n'));
const bb = p[1].replace(/(·  [^\n]{0,150})[^\n]*/g, '$1');
writeFileSync(`${S}/term-a.html`, html(toHtml(a), 'C:\\Windows\\system32\\cmd.exe — train.bat'));
writeFileSync(`${S}/term-b.html`, html(toHtml(bb), 'C:\\Windows\\system32\\cmd.exe — train.bat (메뉴 5)'));
for (const [n, f] of [['10_trainbat_menu2', 'term-a.html'], ['11_trainbat_menu5', 'term-b.html']]) {
  const br = await open(`file:///${S}/${f}`, { port: 9380 + n.length + (n.includes('menu5') ? 7 : 0), width: 1182, height: 900 });
  const h = await br.eval(`document.querySelector('.win').getBoundingClientRect().height`);
  const r = await br.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1182, height: Math.ceil(h) + 2, scale: 1 } });
  writeFileSync(`${S}/shots/${n}.png`, Buffer.from(r.data, 'base64'));
  br.close();
  await new Promise((r) => setTimeout(r, 800));
}
console.log('ok', k);
