// v3.0.0 3D 재생 파일 분석 — 정책(PPO)과 규칙 경로를 같은 시드로 비교해 "어디서 지는지" 숫자로 본다 (2026-11-07 사용자 요청:
// "크게 지는 시드 3D 재생으로 원인 확인"). 재생 파일(.rsim.json.gz)의 라벨·입자 위치만 읽는다(시뮬레이션을 다시 돌리지 않음).
// 실행: node tools/replay-analyze.mjs --dir results/<날짜>/<시각>_ppo-eval_…  [--seeds 11,12,…(기본: 폴더의 ppo-alone-s*.rsim.json.gz 전부)] [--name 이름]
// 결과: results/<날짜>/<시각>_replay-analysis_<이름>/ — report.md(시드별 표·사이클 표), data.json(사이클·남은 드로스 위치), run.json
// 보는 것:
//   - 사이클 = '스쿱 하강' 라벨부터 다음 '스쿱 하강' 전까지. '담은 채 돌리기' 라벨이 있으면 스나우트 쪽 쓸기(열린 면이 스나우트를 봄, 물러나 돌려 운반)
//   - 사이클마다 걸린 시간, 스윕 시간, 새로 박스에 들어간 드로스 수와 그 드로스가 사이클 시작 때 있던 X·Y 범위
//   - 끝날 때 작업 영역에 남은 드로스 위치(로봇 쪽 벽 띠·스나우트 쪽 띠·좌우 벽 띠·가운데, 띠 폭 350 mm)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const dirRel = arg('dir');
if (!dirRel) {
  console.error('--dir <ppo-eval 또는 ppo-train 결과 폴더> 가 필요합니다.');
  process.exit(1);
}
const dir = /^([A-Za-z]:|\/)/.test(dirRel) ? dirRel : `${root}/${dirRel}`;
const seeds = arg('seeds') ? arg('seeds').split(',').map(Number)
  : readdirSync(dir).map((f) => f.match(/^ppo-alone-s(\d+)\.rsim\.json\.gz$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);

const HIDDEN = -99999;
const WORK = { x0: 1100, x1: 2300, y0: -900, y1: 900 }; // js/dross.js WORK_ZONE (포트 안쪽 x0 ~ 스나우트 x0)
const BAND = 350; // 벽 띠 폭 (드로스 배치의 벽 근처 띠와 같은 값)
const inWork = (x, y) => x >= WORK.x0 && x <= WORK.x1 && y >= WORK.y0 && y <= WORK.y1;
const inBin = (p) => p[2] !== HIDDEN && p[0] < 1000 && p[2] < 700; // 대형 드로스 박스(x 250~950)
const REGIONS = ['로봇 쪽 벽 띠', '스나우트 쪽 띠', '좌우 벽 띠', '가운데'];
const region = (x, y) => (x - WORK.x0 < BAND ? REGIONS[0] : WORK.x1 - x < BAND ? REGIONS[1] : (y - WORK.y0 < BAND || WORK.y1 - y < BAND) ? REGIONS[2] : REGIONS[3]);

function analyze(file) {
  const e = JSON.parse(gunzipSync(readFileSync(file)));
  const n = e.radii.length;
  const pos = new Float64Array(n * 3).fill(NaN);
  const snap = () => Array.from({ length: n }, (_, i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  let start = null, cur = null, prev = null;
  const cycles = [];
  for (const f of e.frames) {
    for (let a = 0; a < f.p.length; a += 4) {
      const i = f.p[a];
      pos[i * 3] = f.p[a + 1]; pos[i * 3 + 1] = f.p[a + 2]; pos[i * 3 + 2] = f.p[a + 3];
    }
    if (!start) start = snap().map((p, i) => (p[2] !== HIDDEN && inWork(p[0], p[1]) ? i : -1)).filter((i) => i >= 0);
    if (f.label !== prev) {
      if (f.label === '스쿱 하강') {
        if (cur) cycles.push(cur);
        cur = { t0: f.t, before: snap(), snout: false, sweepS: null };
      } else if (cur && f.label === '담은 채 돌리기') cur.snout = true;
      else if (cur && f.label === '스윕') cur.sweepAt = f.t;
      else if (cur && f.label === '스쿱 상승' && cur.sweepAt != null) cur.sweepS = f.t - cur.sweepAt;
      prev = f.label;
    }
    if (cur) cur.t1 = f.t;
  }
  if (cur) cycles.push(cur);
  const end = snap();
  const rows = cycles.map((c, k) => {
    const after = k + 1 < cycles.length ? cycles[k + 1].before : end;
    const got = start.filter((i) => !inBin(c.before[i]) && inBin(after[i]));
    const xs = got.map((i) => c.before[i][0]), ys = got.map((i) => c.before[i][1]);
    const rg = (a) => (a.length ? [Math.round(Math.min(...a)), Math.round(Math.max(...a))] : null);
    return { k: k + 1, t0: +c.t0.toFixed(1), durS: +(c.t1 - c.t0).toFixed(1), sweepS: c.sweepS == null ? null : +c.sweepS.toFixed(1), snout: c.snout, got: got.length, x: rg(xs), y: rg(ys), complete: c.t1 - c.t0 > 20 };
  });
  const left = start.filter((i) => end[i][2] !== HIDDEN && inWork(end[i][0], end[i][1]) && Math.abs(end[i][2] - 700) < 150);
  const leftBy = Object.fromEntries(REGIONS.map((r) => [r, 0]));
  for (const i of left) leftBy[region(end[i][0], end[i][1])]++;
  const startBy = Object.fromEntries(REGIONS.map((r) => [r, 0]));
  const p0 = analyzeStart(e);
  for (const i of start) startBy[region(p0[i][0], p0[i][1])]++;
  const full = rows.filter((r) => r.complete);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return {
    rate: e.summary.rateCount, cycles: full.length, snoutCycles: full.filter((r) => r.snout).length,
    cycleS: { robot: mean(full.filter((r) => !r.snout).map((r) => r.durS)), snout: mean(full.filter((r) => r.snout).map((r) => r.durS)) },
    gotPer: { robot: mean(full.filter((r) => !r.snout).map((r) => r.got)), snout: mean(full.filter((r) => r.snout).map((r) => r.got)) },
    reachedRobotBand: full.filter((r) => r.x && r.x[0] < WORK.x0 + BAND).length,
    total: start.length, left: left.length, leftBy, startBy, rows,
    leftXY: left.map((i) => [Math.round(end[i][0]), Math.round(end[i][1])]),
  };
}

/** 첫 프레임(키 프레임)의 입자 위치 */
function analyzeStart(e) {
  const f = e.frames[0];
  const out = [];
  for (let a = 0; a < f.p.length; a += 4) out[f.p[a]] = [f.p[a + 1], f.p[a + 2]];
  return out;
}

const run = makeRunDir(root, 'replay-analysis', arg('name', dirRel.replace(/\\/g, '/').split('/').pop().replace(/^\d{4}_/, '')));
const res = {};
for (const s of seeds) {
  res[s] = {};
  for (const k of ['ppo', 'rule']) res[s][k] = analyze(`${dir}/${k}-alone-s${s}.rsim.json.gz`);
  console.log(`시드 ${s}: PPO ${res[s].ppo.rate}% (스나우트 쪽 ${res[s].ppo.snoutCycles}/${res[s].ppo.cycles}) · 규칙 ${res[s].rule.rate}% (${res[s].rule.snoutCycles}/${res[s].rule.cycles})`);
}
const f1 = (v) => (v == null ? '—' : v.toFixed(1));
const L = [];
L.push(`# 3D 재생 분석 — ${run.t.local}`, '');
L.push(`- 명령: \`node tools/replay-analyze.mjs --dir ${dirRel.replace(/\\/g, '/')}\``);
L.push(`- 대상: \`${dirRel.replace(/\\/g, '/')}\`의 \`ppo-alone-s<시드>\`·\`rule-alone-s<시드>.rsim.json.gz\` (시드 ${seeds.join('·')})`);
L.push('- 사이클 = \'스쿱 하강\'부터 다음 \'스쿱 하강\' 전까지(마지막 20초 미만 사이클은 시간 초과로 빼고 셈). 스나우트 쪽 = 그 사이클에 \'담은 채 돌리기\'(물러나 돌려 운반)가 있음.');
L.push(`- 남은 위치: 작업 영역(x ${WORK.x0}~${WORK.x1}, y ±900)을 띠 폭 ${BAND} mm로 나눔 — 로봇 쪽 벽 띠(x < ${WORK.x0 + BAND}) · 스나우트 쪽 띠(x > ${WORK.x1 - BAND}) · 좌우 벽 띠 · 가운데`, '');
L.push('## 시드별 요약', '');
L.push('| 시드 | PPO | 규칙 | 차이 | PPO 스나우트 쪽 / 사이클 | 규칙 스나우트 쪽 / 사이클 | PPO 로봇 쪽 벽 띠에 닿은 사이클 | 규칙 같은 값 | 남은 수 PPO / 규칙 | PPO 남은 로봇 쪽 벽 띠 / 규칙 |');
L.push('|---|---|---|---|---|---|---|---|---|---|');
for (const s of seeds) {
  const p = res[s].ppo, r = res[s].rule;
  L.push(`| ${s} | **${p.rate}%** | ${r.rate}% | ${(p.rate - r.rate).toFixed(1)}%p | ${p.snoutCycles} / ${p.cycles} | ${r.snoutCycles} / ${r.cycles} | ${p.reachedRobotBand} | ${r.reachedRobotBand} | ${p.left} / ${r.left} | ${p.leftBy[REGIONS[0]]} / ${r.leftBy[REGIONS[0]]} |`);
}
const all = (k, f) => seeds.flatMap((s) => res[s][k].rows.filter((x) => x.complete && f(x)));
const m = (a, key) => (a.length ? a.reduce((t, x) => t + x[key], 0) / a.length : null);
L.push('', '## 사이클 종류별 평균 (모든 시드)', '', '| 누가 | 종류 | 사이클 수 | 사이클 시간 | 스윕 시간 | 사이클당 회수 | 1분당 회수 |', '|---|---|---|---|---|---|---|');
for (const k of ['ppo', 'rule']) for (const [nm, f] of [['로봇 쪽', (x) => !x.snout], ['스나우트 쪽', (x) => x.snout]]) {
  const a = all(k, f), t = m(a, 'durS'), g = m(a, 'got');
  L.push(`| ${k === 'ppo' ? 'PPO' : '규칙'} | ${nm} | ${a.length} | ${f1(t)} s | ${f1(m(a.filter((x) => x.sweepS != null), 'sweepS'))} s | ${f1(g)} | ${t ? f1((60 * g) / t) : '—'} |`);
}
L.push('', '## 시드별 사이클 (회수한 드로스 위치 = 그 사이클 시작 때 있던 곳)', '');
for (const s of seeds) for (const k of ['ppo', 'rule']) {
  const a = res[s][k];
  L.push(`### 시드 ${s} — ${k === 'ppo' ? 'PPO' : '규칙'} ${a.rate}%`, '', '| # | 시작 s | 길이 s | 스윕 s | 쓸기 | 회수 | x 범위 | y 범위 |', '|---|---|---|---|---|---|---|---|');
  for (const c of a.rows) L.push(`| ${c.k} | ${c.t0} | ${c.durS} | ${c.sweepS ?? '—'} | ${c.snout ? '스나우트 쪽' : '로봇 쪽'} | ${c.got} | ${c.x ? c.x.join('~') : '—'} | ${c.y ? c.y.join('~') : '—'} |`);
  L.push('', `남은 ${a.left}/${a.total}: ${REGIONS.map((r) => `${r} ${a.leftBy[r]}`).join(' · ')}`, '');
}
writeFileSync(`${run.dir}/report.md`, L.join('\n') + '\n');
writeFileSync(`${run.dir}/data.json`, JSON.stringify({ schema: 'robosim-replay-analysis/1', source: dirRel.replace(/\\/g, '/'), work: WORK, band: BAND, seeds: res }));
const lose = seeds.filter((s) => res[s].ppo.rate < res[s].rule.rate);
finishRun(root, run, { summary: `시드 ${seeds.length}개 · PPO 스나우트 쪽 사이클 비율 ${(100 * seeds.reduce((t, s) => t + res[s].ppo.snoutCycles, 0) / seeds.reduce((t, s) => t + res[s].ppo.cycles, 0)).toFixed(0)}% (규칙 ${(100 * seeds.reduce((t, s) => t + res[s].rule.snoutCycles, 0) / seeds.reduce((t, s) => t + res[s].rule.cycles, 0)).toFixed(0)}%) · PPO가 진 시드 ${lose.join('·') || '없음'}`, detail: { source: dirRel, seeds } });
console.log(`\n저장: ${run.rel}/report.md`);
