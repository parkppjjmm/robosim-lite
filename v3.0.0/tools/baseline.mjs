// v3.0.0 1단계: 규칙 경로(v1.1.2) 기준선 측정 (PRD_v.3.0.0 FR-55, AC-58)
// 대형 로봇 × 셀 구성(단독 / 모드 1 / 모드 2) × 드로스 시드로 제한 시간(기본 600 s) 회수율·목표 도달 시각·흘림을 잰다.
// 실행: node tools/baseline.mjs [--simS 600] [--seeds 11,12,13] [--mains kuka-kr210-r2700,...] [--configs alone,mode1,mode2]
//                              [--workers 4] [--target 80] [--lane-dir robot|snout|alternate] [--name 이름] [--out 폴더]
//   → results/<날짜>/<시각>_baseline_<이름>/report.md(표)·data.json(전체 수치)·run.json, results/INDEX.md에 한 줄 추가
// 결과: <out>.json(전체), <out>.md(표). 각 실행은 자식 프로세스(--job)로 병렬 처리한다. 외부 패키지 없음.
import { readFileSync, writeFileSync } from 'node:fs';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { cpus } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

// 셀 구성 (tests/cell-robots.mjs 시나리오와 같음)
const CONFIGS = {
  alone: { label: '단독', left: { robotId: null, mode: 1 }, right: { robotId: null, mode: 1 } },
  mode1: { label: '3대 모드 1 (좌 UR10e · 우 IRB 1200)', left: { robotId: 'ur-ur10e', mode: 1 }, right: { robotId: 'abb-irb1200-5-09', mode: 1 } },
  mode2: { label: '3대 모드 2 (좌·우 UR10e 밀기, 잠금)', left: { robotId: 'ur-ur10e', mode: 2 }, right: { robotId: 'ur-ur10e', mode: 2 } },
  push: { label: '3대 모드 3 동시 밀기 (좌·우 UR10e, 대형만 회수)', left: { robotId: 'ur-ur10e', mode: 3 }, right: { robotId: 'ur-ur10e', mode: 3 } },
};
const LANE_DIR = { robot: '로봇 쪽으로 쓸기(열린 면 → 로봇)', snout: '스나우트 쪽으로 쓸기(열린 면 → 스나우트, 들어 올린 뒤 돌려서 운반)', alternate: '번갈아' };
const LARGE = ['abb-irb6700-200-260', 'kuka-kr210-r2700', 'fanuc-r2000ic-165f', 'nachi-sra166'];

// ---- 자식 프로세스: 1회 실행 → JSON 한 줄 ----
if (process.argv.includes('--job')) {
  const job = JSON.parse(process.argv[process.argv.indexOf('--job') + 1]);
  const { loadRapier } = await import(pathToFileURL(`${root}/tests/lib/rapier.mjs`));
  const TE = await import(pathToFileURL(`${root}/js/task-eval.js`));
  const CS = await import(pathToFileURL(`${root}/js/cell-sim.js`));
  const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));
  const cfg = CONFIGS[job.config];
  const { task, errors } = TE.sanitizeTask({ targetRatePct: job.target, timeLimitS: job.simS, cell: { main: job.main, left: cfg.left, right: cfg.right }, dross: { seed: job.seed }, mainRule: { laneDir: job.laneDir } }, robots);
  if (errors.length) {
    console.log(JSON.stringify({ ...job, error: errors.join(' / ') }));
    process.exit(0);
  }
  const RAPIER = await loadRapier();
  const { summary, out } = await CS.runEpisode(task, { RAPIER, robots, simS: job.simS });
  console.log(JSON.stringify({ ...job, summary, side: out.side, firstFail: out.planFail[0] ?? null, history: out.history.filter((_, i) => i % 30 === 0) }));
  process.exit(0);
}

// ---- 부모: 작업 목록 → 병렬 실행 → 표 ----
const simS = Number(arg('simS', 600));
const target = Number(arg('target', 80));
const seeds = arg('seeds', '11,12,13').split(',').map(Number);
const mains = arg('mains', LARGE.join(',')).split(',');
const configs = arg('configs', 'alone,mode1,mode2').split(',');
const workers = Math.max(1, Number(arg('workers', Math.max(1, Math.min(4, cpus().length - 1)))));
const laneDirs = arg('lane-dir', 'robot').split(',');
const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));
const nameOf = (id) => robots.find((r) => r.id === id)?.name ?? id;

const jobs = [];
for (const main of mains) for (const config of configs) for (const laneDir of laneDirs) for (const seed of seeds) jobs.push({ main, config, seed, simS, target, laneDir });
const run = makeRunDir(root, 'baseline', arg('name', `${configs.join('+')}${laneDirs.join('') === 'robot' ? '' : `_${laneDirs.join('+')}`}`), arg('out'));
const outDir = run.dir;
console.log(`기준선: ${jobs.length}회 (대형 ${mains.length} × 구성 ${configs.length} × 시드 ${seeds.length}), ${simS} s, 작업자 ${workers}`);
const t0 = Date.now();
const results = [];
let next = 0;
const runOne = (job) => new Promise((resolve) => {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--job', JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', (d) => (buf += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', () => {
    const line = buf.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    resolve(line ? JSON.parse(line) : { ...job, error: err.trim().split('\n').slice(-3).join(' ') || '출력 없음' });
  });
});
await Promise.all(Array.from({ length: workers }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await runOne(job);
    results.push(r);
    const s = r.summary;
    console.log(`  [${results.length}/${jobs.length}] ${nameOf(job.main)} · ${job.config} · 시드 ${job.seed} → ${r.error ? `오류: ${r.error}` : `${s.rateCount}% (질량 ${s.rateMass}%), 흘림 ${s.spilled}, ${s.speedup}×`}`);
  }
}));
const elapsed = (Date.now() - t0) / 1000;

// 표
const ok = results.filter((r) => !r.error);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const lines = [];
lines.push(`# 기준선 — 규칙 경로(v1.1.2) ${simS} s 회수율`, '');
lines.push(`- 생성: ${run.t.local} (${run.rel}) · \`node tools/baseline.mjs\` · ${jobs.length}회 · 작업자 ${workers} · 소요 ${elapsed.toFixed(0)} s`);
lines.push(`- 조건: 작업 영역 드로스 160개(시드 ${seeds.join('·')}), 추가 발생 없음, 목표 ${target}%, 회수율 = 모든 박스 ÷ 작업 영역 초기 드로스(셀 합계, PRD D7)`);
lines.push('- 시뮬레이터 결과이며 실제 드로스(점착·덩어리)와 다르다. 회수율은 개수 기준, 괄호는 질량 기준.', '');
lines.push(`- 쓸기 방향: ${laneDirs.map((d) => `\`${d}\` = ${LANE_DIR[d]}`).join(', ')}`, '');
lines.push('| 대형 로봇 | 구성 | 쓸기 방향 | 회수율 평균 (질량) | 최소~최대 | 목표 도달 | 대형/좌/우 회수 평균 | 흘림 평균 | 대형 사이클 | 배속 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
const means = [];
for (const main of mains) for (const config of configs) for (const laneDir of laneDirs) {
  const rs = ok.filter((r) => r.main === main && r.config === config && (r.laneDir ?? 'robot') === laneDir).map((r) => r.summary);
  if (!rs.length) {
    const e = results.find((r) => r.main === main && r.config === config && r.error);
    lines.push(`| ${nameOf(main)} | ${CONFIGS[config].label} | ${laneDir} | 오류: ${e?.error ?? '—'} | | | | | | |`);
    continue;
  }
  const rc = rs.map((s) => s.rateCount);
  const reach = rs.filter((s) => s.reached).map((s) => s.reachS);
  const by = (k) => f1(mean(rs.map((s) => s.byRobot[k]?.n ?? 0)));
  const gave = rs.filter((s) => s.mainGaveUp).length;
  means.push(`${nameOf(main).split(' ')[0]} ${config} ${laneDir} ${f1(mean(rc))}%`);
  lines.push(`| ${nameOf(main)}${gave ? ` ⚠ 대형 계획 실패 ${gave}/${rs.length}` : ''} | ${CONFIGS[config].label} | ${laneDir} | **${f1(mean(rc))}%** (${f1(mean(rs.map((s) => s.rateMass)))}%) | ${f1(Math.min(...rc))}~${f1(Math.max(...rc))}% | ${reach.length}/${rs.length}${reach.length ? ` (평균 ${f1(mean(reach))} s)` : ''} | ${by('main')} / ${config === 'alone' ? '—' : by('left')} / ${config === 'alone' ? '—' : by('right')} | ${f1(mean(rs.map((s) => s.spilled)))} | ${f1(mean(rs.map((s) => s.mainCycles)))} | ${f1(mean(rs.map((s) => s.speedup)))}× |`);
}
lines.push('', '- ⚠ 대형 계획 실패: 모든 레인에서 사이클 계획이 2번씩 실패해 대형 로봇이 작업을 멈춘 실행 수 (아래 실패 원인).');
const fails = [...new Set(ok.flatMap((r) => (r.summary.mainGaveUp ? [`${nameOf(r.main)} · ${r.config}: ${r.firstFail ?? ''}`] : [])))];
if (fails.length) lines.push(...fails.map((f) => `  - ${f}`));
lines.push('', '## 측면 로봇 끝 상태 (첫 시드)', '');
for (const r of ok.filter((r) => r.config !== 'alone' && r.seed === seeds[0])) {
  lines.push(`- ${nameOf(r.main)} · ${r.config} · ${r.laneDir}: ${Object.entries(r.side).map(([k, v]) => `${k} ${v.name} 작업 ${v.cycles}회, 상태 '${v.status}' — ${v.label}`).join(' / ')}`);
}
writeFileSync(`${outDir}/data.json`, JSON.stringify({ simS, target, seeds, mains, configs, laneDirs, elapsedS: elapsed, results }, null, 1));
writeFileSync(`${outDir}/report.md`, lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
finishRun(root, run, { summary: means.join(' · '), detail: { simS, seeds, mains, configs, laneDirs } });
console.log(`\n저장: ${outDir}/report.md, ${outDir}/data.json (${elapsed.toFixed(0)} s)`);
