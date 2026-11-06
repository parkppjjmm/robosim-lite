// v3.0.0 [B] 단계: 진화 탐색(CEM) 시범 수집 — PPO 모방 학습의 교사 데이터 (2026-11-06)
// 여러 셀 구성 × 드로스 배치(시드)마다 tools/train.mjs(진화 탐색 10분 과제)를 차례로 실행하고,
// 결정마다 기록된 { 관측 obs(98), 최선 스트로크 u(정규화 9) }를 한 파일로 모은다.
//   - 시드는 평가 시드(11·12·13)와 겹치지 않게 (기본 단독 101~110, 모드 3 201~206)
//   - 비교 규칙 경로: 단독 = 번갈아(alternate, [A] 최고), 측면 셀 = 로봇 쪽
//   - 시범 수집에서는 대형이 막혀도 멈추지 않는다(--no-stop): 막힌 사이클만 버림
//   --collect: 새로 실행하지 않고 이미 끝난 train.mjs 실행 폴더(같은 구성·시드의 최신)를 찾아 모으기만 한다
//             (2026-11-06: 사용자가 측면 셀을 뒤로 미뤄 수집을 단독 10개에서 멈춘 뒤 사용)
// 실행: node tools/cem-demos.mjs [--alone 101-110] [--push 201-206] [--collect] [--population 32] [--iterations 4] [--workers 14] [--name 이름]
// 결과: results/<날짜>/<시각>_cem-demos_<이름>/demos.json(모든 시범) · report.md(에피소드별 CEM vs 규칙) · run.json
//       에피소드마다 results/<날짜>/<시각>_cem_<로봇>-<구성>-s<시드>/ (train.mjs 결과, demos.json 포함)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const range = (s) => {
  if (!s || s === 'none') return [];
  return s.split(',').flatMap((p) => {
    const [a, b] = p.split('-').map(Number);
    return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  });
};
const jobs = [
  ...range(arg('alone', '101-110')).map((seed) => ({ config: 'alone', seed, laneDir: 'alternate' })),
  ...range(arg('push', '201-206')).map((seed) => ({ config: 'push', seed, laneDir: 'robot' })),
];
const pop = arg('population', '32'), iters = arg('iterations', '4'), workers = arg('workers', '14');
const run = makeRunDir(root, 'cem-demos', `kr210-${arg('name', `alone${range(arg('alone', '101-110')).length}-push${range(arg('push', '201-206')).length}`)}`);
console.log(`[B] CEM 시범 수집: 에피소드 ${jobs.length}개 (후보 ${pop} × 세대 ${iters}, Worker ${workers}) → ${run.rel}`);
const t0 = Date.now();
const done = [];

function runJob(job) {
  return new Promise((resolve) => {
    const args = [`${root}/tools/train.mjs`, '--config', job.config, '--seed', String(job.seed), '--population', pop, '--iterations', iters, '--workers', workers, '--lane-dir', job.laneDir, '--no-stop'];
    if (arg('time')) args.push('--time', arg('time'));
    const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', decisions = 0;
    p.stdout.on('data', (d) => {
      out += d;
      const n = (String(d).match(/결정\s+\d+ @/g) ?? []).length;
      if (n) {
        decisions += n;
        const k = done.length;
        const pct = ((k + Math.min(0.95, decisions / 15)) / jobs.length) * 100;
        process.stdout.write(`\r  진행 ${pct.toFixed(1)}% — 에피소드 ${k + 1}/${jobs.length} (${job.config} 시드 ${job.seed}) 결정 ${decisions} · 경과 ${((Date.now() - t0) / 60000).toFixed(1)}분   `);
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const m = out.match(/저장: (.+?)\/ \(/);
      resolve({ ...job, code, dir: m ? m[1].replace(/\\/g, '/') : null, err: err.trim().split('\n').slice(-3).join(' ') });
    });
  });
}

/** 이미 끝난 실행 폴더 찾기: results/<날짜>/<시각>_cem_kr210-<구성>-s<시드>/ 중 demos.json이 있는 최신 */
function findJob(job) {
  const hits = [];
  for (const day of readdirSync(`${root}/results`).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    for (const d of readdirSync(`${root}/results/${day}`).sort()) {
      if (d.endsWith(`_cem_kr210-${job.config}-s${job.seed}`) && existsSync(`${root}/results/${day}/${d}/demos.json`)) hits.push(`${root}/results/${day}/${d}`.replace(/\\/g, '/'));
    }
  }
  return { ...job, code: hits.length ? 0 : 1, dir: hits.at(-1) ?? null, err: hits.length ? '' : '실행 폴더 없음' };
}

for (const job of jobs) {
  const r = process.argv.includes('--collect') ? findJob(job) : await runJob(job);
  let demos = null;
  try {
    demos = JSON.parse(readFileSync(`${r.dir}/demos.json`, 'utf8'));
    const rep = readFileSync(`${r.dir}/report.md`, 'utf8');
    const mm = rep.match(/회수율 \(개수 \/ 질량\) \| \*\*([\d.]+)%\*\* \/ [\d.]+% \| \*\*([\d.]+)%\*\*/);
    r.cem = mm ? +mm[1] : demos.summary.rateCount;
    r.rule = mm ? +mm[2] : null;
  } catch (e) {
    r.error = r.err || String(e.message);
  }
  r.demos = demos?.demos ?? [];
  done.push(r);
  console.log(`\n  ✔ ${r.config} 시드 ${r.seed}: CEM ${r.cem ?? '—'}% / 규칙(${r.laneDir}) ${r.rule ?? '—'}% · 시범 ${r.demos.length}개${r.error ? ` · 오류 ${r.error}` : ''}`);
}

const all = done.flatMap((r) => r.demos.filter((d) => d.obs && d.u).map((d) => ({ config: r.config, seed: r.seed, ...d })));
writeFileSync(`${run.dir}/demos.json`, JSON.stringify({ schema: 'robosim-demos/1', createdLocal: run.t.local, robot: 'kuka-kr210-r2700', count: all.length, episodes: done.map(({ demos, err, ...r }) => r), demos: all }));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const L = [];
L.push(`# [B] 진화 탐색 시범 수집 — ${run.t.local}`, '');
L.push(`- 명령: \`node tools/cem-demos.mjs\` · 후보 ${pop} × 세대 ${iters} · Worker ${workers} · 소요 ${((Date.now() - t0) / 60000).toFixed(0)}분`);
L.push('- 각 결정의 관측(드로스 격자 12×8 + 남은 비율 + 시간)과 진화 탐색이 고른 최선 스트로크(9변수, 0~1 정규화)를 모았다 → PPO 모방 학습 교사.');
L.push('- 비교 규칙 경로: 단독 = 번갈아(alternate), 측면 셀 = 로봇 쪽. 시드는 평가 시드(11·12·13)와 겹치지 않는다. 대형이 막히면 그 사이클만 버림(--no-stop).', '');
L.push('| 구성 | 시드 | CEM | 규칙 | 차이 | 시범 수 | 결과 폴더 |', '|---|---|---|---|---|---|---|');
for (const r of done) L.push(`| ${r.config} | ${r.seed} | **${r.cem ?? '—'}%** | ${r.rule ?? '—'}% | ${r.cem != null && r.rule != null ? `${(r.cem - r.rule).toFixed(1)}%p` : '—'} | ${r.demos.length} | \`${(r.dir ?? '').replace(`${root.replace(/\\/g, '/')}/`, '')}\` |`);
for (const c of ['alone', 'push']) {
  const rs = done.filter((r) => r.config === c && r.cem != null);
  if (rs.length) L.push(`| **${c} 평균** | ${rs.length}개 | **${mean(rs.map((r) => r.cem)).toFixed(1)}%** | ${mean(rs.map((r) => r.rule)).toFixed(1)}% | ${(mean(rs.map((r) => r.cem)) - mean(rs.map((r) => r.rule))).toFixed(1)}%p | ${rs.reduce((s, r) => s + r.demos.length, 0)} | |`);
}
const dirs = all.map((d) => d.u[2]);
const heads = all.map((d) => d.u);
L.push('', `- 시범 합계 ${all.length}개 (\`demos.json\`).`);
if (heads.length) {
  // 행동 분포 요약: 방향(heading)이 스나우트 쪽(0±60°)인 비율, 열린 면 회전(|yaw1−yaw0| > 30°) 비율
  const lab = JSON.parse(readFileSync(`${done.find((r) => r.dir)?.dir}/demos.json`, 'utf8')).lab;
  const keys = ['x0', 'y0', 'headingDeg', 'lengthMm', 'yaw0Deg', 'yaw1Deg', 'tiltDeg', 'depthMm', 'speedMmS'].filter((k) => lab.search[k].on);
  const val = (d, k) => { const s = lab.search[k]; return s.min + (s.max - s.min) * d.u[keys.indexOf(k)]; };
  const toSnout = all.filter((d) => { const h = ((val(d, 'headingDeg') % 360) + 360) % 360; return h < 60 || h > 300; }).length;
  const toRobot = all.filter((d) => { const h = val(d, 'headingDeg'); return h > 120 && h < 240; }).length;
  const turn = all.filter((d) => Math.abs(val(d, 'yaw1Deg') - val(d, 'yaw0Deg')) > 30).length;
  L.push(`- 고른 스트로크 경향: 스나우트 쪽으로 쓸기(방향 0±60°) ${toSnout}개 (${(100 * toSnout / all.length).toFixed(0)}%), 로봇 쪽(180±60°) ${toRobot}개 (${(100 * toRobot / all.length).toFixed(0)}%), 스윕 중 열린 면 30° 넘게 회전 ${turn}개 (${(100 * turn / all.length).toFixed(0)}%), 규칙 레인 그대로 ${all.filter((d) => d.rule).length}개, 반대 방향 규칙 레인 ${all.filter((d) => d.ruleRev).length}개.`);
}
void dirs;
writeFileSync(`${run.dir}/report.md`, L.join('\n') + '\n');
const sum = ['alone', 'push'].map((c) => { const rs = done.filter((r) => r.config === c && r.cem != null); return rs.length ? `${c} CEM ${mean(rs.map((r) => r.cem)).toFixed(1)}% vs 규칙 ${mean(rs.map((r) => r.rule)).toFixed(1)}% (${rs.length}개)` : null; }).filter(Boolean).join(' · ');
finishRun(root, run, { summary: `시범 ${all.length}개 · ${sum}`, detail: { jobs, population: pop, iterations: iters } });
console.log('\n' + L.join('\n'));
console.log(`\n저장: ${run.rel}/demos.json`);
