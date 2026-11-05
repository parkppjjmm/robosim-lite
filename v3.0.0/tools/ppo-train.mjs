// v3.0.0 PPO 강화학습 (헤드리스) — PRD_v.3.0.0 4.3 B-1·B-2, 4.5(다양한 상황 탐색 → 최선만 채택), FR-60·62·67
// 계층형 B의 "스트로크 정책": 관측(작업 영역 드로스 격자 + 남은 비율 + 시간) → 스트로크 변수(시작점·방향·길이·열린 면 방향(J6)·
// 회전·기울임·깊이·속도). 관절값은 IK·안전 게이트가 만든다. 환경 = 대형 로봇 단독 셀(StrokeEnv), 에피소드마다 다른 드로스 배치.
// 순서: ① 모방(BC) — 규칙 경로(v1.1.2)를 교사로 ② PPO — 병렬 롤아웃, GAE, 클립 목적함수 ③ 주기적 고정 시드 평가로 최고 체크포인트만 채택
//       ④ 최고 정책으로 10분 과제(전체 셀 시뮬레이터) 실행·규칙 경로와 비교·3D 재생 파일
// 실행: node tools/ppo-train.mjs [--iterations 40] [--bc 3] [--workers 14] [--episodes 14] [--main kuka-kr210-r2700] [--count 160]
//                               [--time 600] [--eval-seeds 11,12,13] [--eval-every 5] [--lab 설정.json] [--resume policy.json] [--out results/ppo/<이름>]
// 결과: <out>/policy.json(최고), <out>/policy-last.json, <out>/curve.json, <out>/report.md, <out>/eval-s<시드>.rsim.json.gz
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/${m}`));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const { loadRapier } = await imp('tests/lib/rapier.mjs');
const TE = await imp('js/task-eval.js');
const CS = await imp('js/cell-sim.js');
const RP = await imp('js/replay.js');
const LAB = await imp('js/stroke-lab.js');
const PPO = await imp('js/ppo.js');
const { rng } = await imp('js/dross.js');
const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));

const fileCfg = arg('lab') ? JSON.parse(readFileSync(arg('lab'), 'utf8')) : {};
const lab = LAB.sanitizeLab(fileCfg.lab ?? fileCfg);
const ITER = Number(arg('iterations', 40));
const BC = Number(arg('bc', 3));
const WORKERS = Math.max(1, Number(arg('workers', Math.max(1, cpus().length - 2))));
const EPISODES = Number(arg('episodes', WORKERS));
const EVAL_SEEDS = arg('eval-seeds', '11,12,13').split(',').map(Number);
const EVAL_EVERY = Number(arg('eval-every', 5));
const { task } = TE.sanitizeTask({ timeLimitS: Number(arg('time', 600)), cell: { main: arg('main', 'kuka-kr210-r2700') }, dross: { count: Number(arg('count', 160)) } }, robots);
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const outDir = `${root}/${arg('out', `results/ppo/${stamp}-${task.cell.main.split('-')[1]}`)}`;
mkdirSync(outDir, { recursive: true });
const cfg = { robotId: task.cell.main, count: task.dross.count, timeLimitS: task.timeLimitS, maxSteps: 40, thresholds: TE.TASK_THRESHOLDS, lab, task };
const actDim = LAB.searchKeys(lab).length;

// ---- 작업자 풀 ----
const pool = { idle: [], queue: [], wait: new Map(), seq: 0, all: [] };
await Promise.all(Array.from({ length: WORKERS }, () => new Promise((resolve) => {
  const w = new Worker(new URL('./ppo-worker.mjs', import.meta.url));
  w.on('message', (m) => {
    if (m.type === 'ready') {
      pool.idle.push(w);
      return resolve();
    }
    pool.wait.get(m.id)(m);
    pool.wait.delete(m.id);
    pool.idle.push(w);
    pump();
  });
  w.on('error', (e) => console.error('작업자 오류:', e.message));
  w.postMessage({ type: 'init', robots, cfg });
  pool.all.push(w);
})));
function pump() {
  while (pool.idle.length && pool.queue.length) {
    const w = pool.idle.pop();
    w.postMessage(pool.queue.shift());
  }
}
const rollouts = (jobs) => Promise.all(jobs.map((job) => new Promise((resolve) => {
  const id = ++pool.seq;
  pool.wait.set(id, resolve);
  pool.queue.push({ id, ...job });
  pump();
}))).then((rs) => {
  for (const r of rs) if (r.error) throw new Error(r.error);
  return rs;
});

// ---- 학습 ----
const rand = rng(Number(arg('seed', 1)));
let agent = arg('resume') ? PPO.importPolicy(JSON.parse(readFileSync(arg('resume'), 'utf8'))) : PPO.createAgent({ actDim, rand });
const optPi = new PPO.Adam(3e-4), optVf = new PPO.Adam(1e-3), optBc = new PPO.Adam(1e-3);
let seedCounter = 1000;
const curve = [];
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const t0 = Date.now();
const stat = (rs) => ({ ret: mean(rs.map((r) => r.stats.ret)), rate: mean(rs.map((r) => r.stats.rate)), empties: mean(rs.map((r) => r.stats.empties)), infeasible: mean(rs.map((r) => r.stats.infeasible)), repaired: mean(rs.map((r) => r.stats.repaired)), steps: mean(rs.map((r) => r.stats.steps)) });
const fmt = (s) => `회수율 ${s.rate.toFixed(1)}% · 보상 ${s.ret.toFixed(0)} · 스트로크 ${s.steps.toFixed(1)} · 헛질 ${s.empties.toFixed(1)} · 보정 ${s.repaired.toFixed(1)} · 불가 ${s.infeasible.toFixed(1)}`;
console.log(`PPO: ${task.cell.main} · 드로스 ${task.dross.count}개 · ${task.timeLimitS} s · 행동 ${actDim}차원 · 작업자 ${WORKERS} · 반복 ${ITER}(+모방 ${BC}) · 에피소드/반복 ${EPISODES}`);
console.log(`점수 규칙: ${JSON.stringify(lab.reward)}`);

// ① 모방 (규칙 경로 교사)
let teacherStat = null;
for (let k = 0; k < BC; k++) {
  const rs = await rollouts(Array.from({ length: EPISODES }, () => ({ mode: 'teacher', policy: PPO.exportPolicy(agent), seed: seedCounter++, randSeed: seedCounter })));
  const samples = rs.flatMap((r) => r.transitions.filter((x) => x.target).map((x) => ({ obs: Float64Array.from(x.obs), target: x.target })));
  const { mse } = PPO.bcUpdate(agent, samples, { epochs: 30, rand, opt: optBc });
  teacherStat = stat(rs);
  curve.push({ phase: 'bc', k, ...teacherStat, mse, s: (Date.now() - t0) / 1000 });
  console.log(`  모방 ${k + 1}/${BC}: 교사(규칙 경로) ${fmt(teacherStat)} · 표본 ${samples.length} · MSE ${mse.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// 평가 (결정적 행동, 고정 시드)
async function evaluate(tag) {
  const rs = await rollouts(EVAL_SEEDS.map((seed) => ({ mode: 'eval', policy: PPO.exportPolicy(agent), seed, randSeed: 1 })));
  const s = stat(rs);
  console.log(`  ▶ 평가(${tag}) 시드 ${EVAL_SEEDS.join('·')}: ${fmt(s)}`);
  return s;
}
let best = await evaluate('모방 후');
let bestPolicy = PPO.exportPolicy(agent, { phase: 'bc', eval: best });
curve.push({ phase: 'eval', iter: 0, ...best, s: (Date.now() - t0) / 1000 });

// ② PPO
for (let it = 1; it <= ITER; it++) {
  const rs = await rollouts(Array.from({ length: EPISODES }, () => ({ mode: 'policy', policy: PPO.exportPolicy(agent), seed: seedCounter++, randSeed: seedCounter * 7 })));
  const batch = [];
  for (const r of rs) {
    const obs = r.transitions.map((x) => Float64Array.from(x.obs));
    const vals = obs.map((o) => PPO.value(agent, o));
    const { adv, ret } = PPO.gae(r.transitions.map((x) => x.reward / 100), vals);
    r.transitions.forEach((x, i) => batch.push({ obs: obs[i], u: x.u, logp: x.logp, adv: adv[i], ret: ret[i] }));
  }
  const up = PPO.ppoUpdate(agent, batch, { rand, optPi, optVf });
  const s = stat(rs);
  curve.push({ phase: 'ppo', iter: it, ...s, ...up, n: batch.length, s: (Date.now() - t0) / 1000 });
  console.log(`  PPO ${String(it).padStart(3)}/${ITER}: ${fmt(s)} · KL ${up.approxKl.toFixed(4)} · 클립 ${(100 * up.clipFrac).toFixed(0)}% · 표준편차 ${mean(up.std).toFixed(3)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (it % EVAL_EVERY === 0 || it === ITER) {
    const e = await evaluate(`반복 ${it}`);
    curve.push({ phase: 'eval', iter: it, ...e, s: (Date.now() - t0) / 1000 });
    if (e.ret > best.ret) {
      best = e;
      bestPolicy = PPO.exportPolicy(agent, { phase: 'ppo', iter: it, eval: e });
      console.log('    ★ 최고 체크포인트 갱신 (평가 보상 기준)');
    }
    writeFileSync(`${outDir}/policy.json`, JSON.stringify({ ...bestPolicy, lab, task: { main: task.cell.main, count: task.dross.count, timeLimitS: task.timeLimitS } }));
    writeFileSync(`${outDir}/curve.json`, JSON.stringify(curve));
  }
}
writeFileSync(`${outDir}/policy-last.json`, JSON.stringify({ ...PPO.exportPolicy(agent, { phase: 'ppo', iter: ITER }), lab }));
writeFileSync(`${outDir}/policy.json`, JSON.stringify({ ...bestPolicy, lab, task: { main: task.cell.main, count: task.dross.count, timeLimitS: task.timeLimitS } }));
writeFileSync(`${outDir}/curve.json`, JSON.stringify(curve));
for (const w of pool.all) w.terminate();
const trainS = (Date.now() - t0) / 1000;

// ④ 최고 정책 → 10분 과제 (전체 셀 시뮬레이터) vs 규칙 경로
const RAPIER = await loadRapier();
const bestAgent = PPO.importPolicy(bestPolicy);
const rows = [];
for (const seed of EVAL_SEEDS) {
  const tk = TE.sanitizeTask({ ...task, dross: { ...task.dross, seed } }, robots).task;
  const rec = new RP.EpisodeRecorder({ everyS: 0.1 });
  const pr = await LAB.runPolicy({ RAPIER, robots, task: tk, lab, agent: bestAgent, runEpisode: CS.runEpisode, record: rec });
  writeFileSync(`${outDir}/eval-s${seed}.rsim.json.gz`, gzipSync(JSON.stringify({ ...pr.episode, lab: { method: 'ppo', reward: lab.reward } })));
  const rr = await CS.runEpisode(tk, { RAPIER, robots });
  rows.push({ seed, ppo: pr.summary, rule: rr.summary, strokes: pr.log.decisions.length, retries: pr.log.decisions.filter((d) => d.retry).length });
  console.log(`  10분 과제 시드 ${seed}: PPO ${pr.summary.rateCount}% / 규칙 ${rr.summary.rateCount}% (스트로크 ${pr.log.decisions.length}, 재시도 ${rows.at(-1).retries})`);
}

// 보고서
const L = [];
L.push(`# PPO 강화학습 결과 — ${new Date().toISOString()}`, '');
L.push(`- 환경: ${robots.find((r) => r.id === task.cell.main).name} 단독 셀(StrokeEnv), 드로스 ${task.dross.count}개(에피소드마다 다른 시드), ${task.timeLimitS} s, 행동 = 스트로크 ${actDim}변수(${LAB.searchKeys(lab).join(', ')})`);
L.push(`- 관측: 작업 영역 드로스 격자 ${PPO.OBS_GRID.nx}×${PPO.OBS_GRID.ny} + 남은 비율 + 시간 비율 (${PPO.OBS_DIM}차원), 정책 MLP ${PPO.OBS_DIM}→64→64→${actDim}(가우시안), 순수 JS`);
L.push(`- 학습: 모방(규칙 경로 교사) ${BC}회 → PPO ${ITER}회 × 에피소드 ${EPISODES}개, 작업자 ${WORKERS}, ${trainS.toFixed(0)} s. 최고 체크포인트 = 고정 시드(${EVAL_SEEDS.join('·')}) 평가 보상 최고 (${bestPolicy.phase === 'bc' ? '모방 직후' : `PPO 반복 ${bestPolicy.iter}`})`);
L.push(`- 점수 규칙: ${JSON.stringify(lab.reward)}`);
L.push('- 시뮬레이터 결과(구형 입자 근사)다. 정책은 대형 단독 셀에서 학습했다.', '');
L.push('## 학습 곡선 (평가: 결정적 행동, 고정 시드)', '', '| 시점 | 회수율 | 보상 | 스트로크 | 헛질 | 보정 | 계획 불가 |', '|---|---|---|---|---|---|---|');
if (teacherStat) L.push(`| 교사(규칙 경로, 무작위 시드) | ${teacherStat.rate.toFixed(1)}% | ${teacherStat.ret.toFixed(0)} | ${teacherStat.steps.toFixed(1)} | ${teacherStat.empties.toFixed(1)} | ${teacherStat.repaired.toFixed(1)} | ${teacherStat.infeasible.toFixed(1)} |`);
for (const c of curve.filter((c) => c.phase === 'eval')) L.push(`| ${c.iter === 0 ? '모방 후' : `PPO ${c.iter}`} | ${c.rate.toFixed(1)}% | ${c.ret.toFixed(0)} | ${c.steps.toFixed(1)} | ${c.empties.toFixed(1)} | ${c.repaired.toFixed(1)} | ${c.infeasible.toFixed(1)} |`);
L.push('', '## 최고 정책으로 10분 과제 (전체 셀 시뮬레이터, 대형 단독)', '', '| 시드 | PPO 정책 | 규칙 경로 | 차이 | PPO 스트로크 (재시도) | PPO 흘림 / 규칙 흘림 |', '|---|---|---|---|---|---|');
for (const r of rows) L.push(`| ${r.seed} | **${r.ppo.rateCount}%** | ${r.rule.rateCount}% | ${(r.ppo.rateCount - r.rule.rateCount).toFixed(1)}%p | ${r.strokes} (${r.retries}) | ${r.ppo.spilled} / ${r.rule.spilled} |`);
L.push(`| 평균 | **${mean(rows.map((r) => r.ppo.rateCount)).toFixed(1)}%** | ${mean(rows.map((r) => r.rule.rateCount)).toFixed(1)}% | ${(mean(rows.map((r) => r.ppo.rateCount)) - mean(rows.map((r) => r.rule.rateCount))).toFixed(1)}%p | | |`);
L.push('', `- 정책 파일: \`policy.json\` (robosim-policy/1) — 앱 '학습' 패널의 [정책 불러오기]로 실행·3D 재생. 3D 재생: \`eval-s<시드>.rsim.json.gz\`.`);
writeFileSync(`${outDir}/report.md`, L.join('\n') + '\n');
console.log('\n' + L.join('\n'));
console.log(`\n저장: ${outDir}/ — 전체 ${((Date.now() - t0) / 1000).toFixed(0)} s`);
