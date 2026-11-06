// v3.0.0 PPO 강화학습 (헤드리스) — PRD_v.3.0.0 4.3 B-1·B-2, 4.5(다양한 상황 탐색 → 최선만 채택), FR-60·62·67
// 계층형 B의 "스트로크 정책": 관측(작업 영역 드로스 격자 + 남은 비율 + 시간) → 스트로크 변수(시작점·방향·길이·열린 면 방향(J6)·
// 회전·기울임·깊이·속도). 관절값은 IK·안전 게이트가 만든다. 환경 = 대형 로봇 단독 셀(StrokeEnv), 에피소드마다 다른 드로스 배치.
// 순서: ① 모방(BC) — 규칙 경로(v1.1.2)를 교사로 ② PPO — 병렬 롤아웃, GAE, 클립 목적함수 ③ 주기적 고정 시드 평가로 최고 체크포인트만 채택
//       ④ 최고 정책으로 10분 과제(전체 셀 시뮬레이터) 실행·규칙 경로와 비교·3D 재생 파일
// 실행: node tools/ppo-train.mjs [--iterations 40] [--bc 3] [--workers 14] [--episodes 14] [--main kuka-kr210-r2700] [--count 160]
//                               [--time 600] [--eval-seeds 11,12,13] [--eval-every 5] [--lab 설정.json] [--resume policy-last.json] [--name run2] [--out 폴더(기본 results/<날짜>/<시각>_ppo-train_<로봇>-<이름>)]
//   --demos <demos.json>[,<demos.json>…]: 모방 학습 교사 = 진화 탐색 시범 (tools/cem-demos.mjs 결과, [C] 단계). 없으면 규칙 경로 교사(1차 방식)
//   --demo-filter better|all: better(기본) = 진화 탐색이 같은 시드 규칙 경로보다 높았던 에피소드의 시범만 쓴다
//   --rule-lane-dir robot|alternate: 학습 직후 평가에서 비교할 규칙 경로의 쓸기 방향 (기본 robot)
// 결과(이름 규칙은 results/README.md):
//   <out>/policy-best.json   최고 체크포인트(앱 [정책 불러오기]로 쓰는 파일)   <out>/policy-last.json   마지막 반복
//   <out>/checkpoints/iter-NNN.json   평가할 때마다(5회마다) 저장한 중간 정책     <out>/train-curve.json   반복별 학습 기록
//   <out>/train-report.md   학습 보고서   <out>/cell-eval-alone.md + ppo-alone-s<시드>·rule-alone-s<시드>.rsim.json.gz   전체 셀 10분 평가
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { evalPolicyCell } from './lib/policy-eval.mjs';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';
import { progressLine } from './lib/progress.mjs';

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
// 행동 형식: residual(기본, 규칙 레인 기준 조정 10) | abs(1차와 같은 9개 값 직접)
const resumeFile = arg('resume') ? JSON.parse(readFileSync(arg('resume'), 'utf8')) : null;
const ACTION = resumeFile ? resumeFile.actionMode ?? 'abs' : arg('action', 'residual');
// 진화 탐색 시범 ([C] 단계)
const DEMO_FILES = arg('demos') ? arg('demos').split(',') : [];
let DEMOS = null;
if (DEMO_FILES.length) {
  const sameSearch = (a, b) => LAB.STROKE_PARAMS.every((p) => a[p.key].on === b[p.key].on && (!a[p.key].on || (a[p.key].min === b[p.key].min && a[p.key].max === b[p.key].max)));
  DEMOS = { files: DEMO_FILES, samples: [], episodes: 0, dropped: 0, cem: [] };
  for (const f of DEMO_FILES) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    const eps = d.episodes ?? [{ config: d.config, seed: d.seed, cem: d.summary?.rateCount ?? null, rule: null, dir: null }];
    const list = d.demos.map((x) => ({ ...x, config: x.config ?? d.config, seed: x.seed ?? d.seed }));
    const labFile = d.lab ?? JSON.parse(readFileSync(`${eps.find((e) => e.dir)?.dir}/demos.json`, 'utf8')).lab;
    if (!sameSearch(labFile.search, lab.search)) {
      console.error(`시범의 스트로크 범위(lab.search)가 학습 설정과 다릅니다: ${f} — 같은 --lab 설정으로 수집·학습해야 합니다.`);
      process.exit(1);
    }
    const logCache = new Map();
    const baseOf = (e, t) => {
      if (!e.dir) return null;
      if (!logCache.has(e.dir)) logCache.set(e.dir, JSON.parse(readFileSync(`${e.dir}/log.json`, 'utf8')).decisions);
      const dd = logCache.get(e.dir).find((x) => Math.abs(x.t - t) < 0.05);
      const rt = dd?.trialsList?.find((x) => x.rule);
      return rt && dd ? { base: rt.values, best: dd.best.values } : null;
    };
    for (const e of eps) {
      const keep = arg('demo-filter', 'better') === 'all' || e.rule == null || e.cem > e.rule;
      const mine = list.filter((x) => x.seed === e.seed && x.config === e.config && x.obs && x.u);
      if (!keep) { DEMOS.dropped += mine.length; continue; }
      DEMOS.episodes++;
      if (e.cem != null) DEMOS.cem.push(e.cem);
      mine.sort((a, b) => a.t - b.t);
      mine.forEach((x, i) => {
        let target = x.u;
        if (ACTION === 'residual') {
          const bb = baseOf(e, x.t);
          if (!bb) return;
          target = LAB.encodeResidual(bb.best, bb.base, lab);
        }
        DEMOS.samples.push({ obs: Float64Array.from(x.obs), target, prev: i ? mine[i - 1].u : null });
      });
    }
  }
  if (!DEMOS.samples.length) {
    console.error('쓸 수 있는 시범이 없습니다.');
    process.exit(1);
  }
  console.log(`교사 = 진화 탐색 시범 ${DEMOS.samples.length}개 (에피소드 ${DEMOS.episodes}개${DEMOS.dropped ? `, 규칙보다 낮은 에피소드 시범 ${DEMOS.dropped}개 제외` : ''}) — ${DEMO_FILES.join(', ')}`);
}
const WORKERS = Math.max(1, Number(arg('workers', Math.max(1, cpus().length - 2))));
const EPISODES = Number(arg('episodes', WORKERS));
const EVAL_SEEDS = arg('eval-seeds', '11,12,13').split(',').map(Number);
const EVAL_EVERY = Number(arg('eval-every', 5));
const { task } = TE.sanitizeTask({ timeLimitS: Number(arg('time', 600)), cell: { main: arg('main', 'kuka-kr210-r2700') }, dross: { count: Number(arg('count', 160)) } }, robots);
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
void stamp;
const run = makeRunDir(root, 'ppo-train', `${task.cell.main.split('-')[1]}-${arg('name', 'run')}`, arg('out'));
const outDir = run.dir;
mkdirSync(`${outDir}/checkpoints`, { recursive: true });
const cfg = { robotId: task.cell.main, count: task.dross.count, timeLimitS: task.timeLimitS, maxSteps: 40, thresholds: TE.TASK_THRESHOLDS, lab, task };
const actDim = ACTION === 'residual' ? LAB.RESIDUAL_DIM : LAB.searchKeys(lab).length;
cfg.actionMode = ACTION;

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
// 관측: --obs last(기본, 직전 스트로크 포함 102) | base(1차와 같은 98)
let agent = resumeFile ? PPO.importPolicy(resumeFile) : PPO.createAgent({ actDim, rand, obsDim: arg('obs', 'last') === 'base' ? PPO.OBS_DIM : PPO.OBS_DIM_LAST });
const OBS_N = PPO.obsDimOf(agent);
// 시범의 관측(98)에 직전 스트로크(같은 에피소드의 바로 앞 시범) 특징을 붙인다
if (DEMOS && OBS_N > PPO.OBS_DIM) {
  for (const sm of DEMOS.samples) {
    const prev = sm.prev ? LAB.decodeStroke(sm.prev, lab).values : null;
    const o = new Float64Array(OBS_N);
    o.set(sm.obs.subarray(0, PPO.OBS_DIM));
    o.set(PPO.lastFeatures(prev), PPO.OBS_DIM);
    sm.obs = o;
  }
}
const optPi = new PPO.Adam(3e-4), optVf = new PPO.Adam(1e-3), optBc = new PPO.Adam(1e-3);
let seedCounter = 1000;
const curve = [];
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const t0 = Date.now();
const stat = (rs) => ({ ret: mean(rs.map((r) => r.stats.ret)), rate: mean(rs.map((r) => r.stats.rate)), empties: mean(rs.map((r) => r.stats.empties)), infeasible: mean(rs.map((r) => r.stats.infeasible)), repaired: mean(rs.map((r) => r.stats.repaired)), steps: mean(rs.map((r) => r.stats.steps)) });
const fmt = (s) => `회수율 ${s.rate.toFixed(1)}% · 보상 ${s.ret.toFixed(0)} · 스트로크 ${s.steps.toFixed(1)} · 헛질 ${s.empties.toFixed(1)} · 보정 ${s.repaired.toFixed(1)} · 불가 ${s.infeasible.toFixed(1)}`;
console.log(`PPO: ${task.cell.main} · 드로스 ${task.dross.count}개 · ${task.timeLimitS} s · 행동 ${actDim}차원 · 작업자 ${WORKERS} · 반복 ${ITER}(+모방 ${BC}) · 에피소드/반복 ${EPISODES}`);
console.log(`점수 규칙: ${JSON.stringify(lab.reward)}`);

// ① 모방 — 교사: 진화 탐색 시범(--demos) 또는 규칙 경로(1차 방식)
let teacherStat = null;
if (DEMOS) {
  for (let k = 0; k < BC; k++) {
    const { mse } = PPO.bcUpdate(agent, DEMOS.samples, { epochs: 30, rand, opt: optBc });
    curve.push({ phase: 'bc', k, teacher: 'cem-demos', n: DEMOS.samples.length, mse, s: (Date.now() - t0) / 1000 });
    console.log(`  모방 ${k + 1}/${BC}: 교사(진화 탐색 시범 ${DEMOS.samples.length}개) · MSE ${mse.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}
for (let k = 0; k < (DEMOS ? 0 : BC); k++) {
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
// 정책 파일 = 신경망 가중치 + 점수 규칙 + 과제 정보 (robosim-policy/1)
const policyFile = (p) => JSON.stringify({ ...p, actionMode: ACTION, lab, task: { main: task.cell.main, count: task.dross.count, timeLimitS: task.timeLimitS } });
const saveCheckpoint = (it, e) => writeFileSync(`${outDir}/checkpoints/iter-${String(it).padStart(3, '0')}.json`, policyFile(PPO.exportPolicy(agent, { phase: it ? 'ppo' : 'bc', iter: it, eval: e })));
let best = await evaluate('모방 후');
let bestPolicy = PPO.exportPolicy(agent, { phase: 'bc', eval: best });
curve.push({ phase: 'eval', iter: 0, ...best, s: (Date.now() - t0) / 1000 });
saveCheckpoint(0, best);

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
  // 진행률 막대 = PPO 반복 / 전체 반복 (2026-11-06 사용자 요청). 끝난 뒤 10분 과제 평가(약 수 분)가 더 있다
  console.log(`  ${progressLine(it / ITER, t0)} | PPO ${String(it).padStart(3)}/${ITER}: ${fmt(s)} · KL ${up.approxKl.toFixed(4)} · 클립 ${(100 * up.clipFrac).toFixed(0)}% · 표준편차 ${mean(up.std).toFixed(3)} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (it % EVAL_EVERY === 0 || it === ITER) {
    const e = await evaluate(`반복 ${it}`);
    curve.push({ phase: 'eval', iter: it, ...e, s: (Date.now() - t0) / 1000 });
    saveCheckpoint(it, e);
    if (e.ret > best.ret) {
      best = e;
      bestPolicy = PPO.exportPolicy(agent, { phase: 'ppo', iter: it, eval: e });
      console.log('    ★ 최고 체크포인트 갱신 (평가 보상 기준)');
    }
    writeFileSync(`${outDir}/policy-best.json`, policyFile(bestPolicy));
    writeFileSync(`${outDir}/train-curve.json`, JSON.stringify(curve));
  }
}
writeFileSync(`${outDir}/policy-last.json`, policyFile(PPO.exportPolicy(agent, { phase: 'ppo', iter: ITER })));
writeFileSync(`${outDir}/policy-best.json`, policyFile(bestPolicy));
writeFileSync(`${outDir}/train-curve.json`, JSON.stringify(curve));
for (const w of pool.all) w.terminate();
const trainS = (Date.now() - t0) / 1000;

// ④ 최고 정책 → 10분 과제 (전체 셀 시뮬레이터) vs 규칙 경로
const RAPIER = await loadRapier();
const bestAgent = PPO.importPolicy(JSON.parse(policyFile(bestPolicy)));
const bestLabel = `\`policy-best.json\` (${bestPolicy.phase === 'bc' ? '모방 직후' : `PPO 반복 ${bestPolicy.iter}`}, 학습 평가 회수율 ${best.rate.toFixed(1)}%)`;
const { rows } = await evalPolicyCell({ m: { TE, CS, RP, LAB }, RAPIER, robots, pol: JSON.parse(policyFile(bestPolicy)), agent: bestAgent, lab, config: 'alone', seeds: EVAL_SEEDS, outDir, policyLabel: bestLabel, ruleLaneDir: arg('rule-lane-dir', 'robot') });

// 보고서
const L = [];
L.push(`# PPO 강화학습 결과 — ${new Date().toISOString()}`, '');
L.push(`- 환경: ${robots.find((r) => r.id === task.cell.main).name} 단독 셀(StrokeEnv), 드로스 ${task.dross.count}개(에피소드마다 다른 시드), ${task.timeLimitS} s, 행동 = ${ACTION === 'residual' ? `규칙 레인 기준 조정 ${actDim}값(반대 방향 여부, 시작 X·Y·방향·길이 조정, 열린 면 시작·끝, 기울임, 깊이, 속도)` : `스트로크 ${actDim}변수(${LAB.searchKeys(lab).join(', ')})`}`);
L.push(`- 관측: 작업 영역 드로스 격자 ${PPO.OBS_GRID.nx}×${PPO.OBS_GRID.ny} + 남은 비율 + 시간 비율 ${OBS_N > PPO.OBS_DIM ? ' + 직전 스트로크 4' : ''} (${OBS_N}차원), 정책 MLP ${OBS_N}→64→64→${actDim}(가우시안), 순수 JS`);
L.push(`- 학습: 모방(${DEMOS ? `진화 탐색 시범 ${DEMOS.samples.length}개 — ${DEMO_FILES.map((f) => f.replace(/\\/g, '/').split('/').slice(-2).join('/')).join(', ')}` : '규칙 경로 교사'}) ${BC}회 → PPO ${ITER}회 × 에피소드 ${EPISODES}개, 작업자 ${WORKERS}, ${trainS.toFixed(0)} s. 최고 체크포인트 = 고정 시드(${EVAL_SEEDS.join('·')}) 평가 보상 최고 (${bestPolicy.phase === 'bc' ? '모방 직후' : `PPO 반복 ${bestPolicy.iter}`})`);
L.push(`- 점수 규칙: ${JSON.stringify(lab.reward)}`);
L.push('- 시뮬레이터 결과(구형 입자 근사)다. 정책은 대형 단독 셀에서 학습했다.', '');
L.push('## 학습 곡선 (평가: 결정적 행동, 고정 시드)', '', '| 시점 | 회수율 | 보상 | 스트로크 | 헛질 | 보정 | 계획 불가 |', '|---|---|---|---|---|---|---|');
if (DEMOS) L.push(`| 교사(진화 탐색 시범 ${DEMOS.samples.length}개, 수집 에피소드 평균 ${mean(DEMOS.cem).toFixed(1)}%) | ${mean(DEMOS.cem).toFixed(1)}% | — | — | — | — | — |`);
if (teacherStat) L.push(`| 교사(규칙 경로, 무작위 시드) | ${teacherStat.rate.toFixed(1)}% | ${teacherStat.ret.toFixed(0)} | ${teacherStat.steps.toFixed(1)} | ${teacherStat.empties.toFixed(1)} | ${teacherStat.repaired.toFixed(1)} | ${teacherStat.infeasible.toFixed(1)} |`);
for (const c of curve.filter((c) => c.phase === 'eval')) L.push(`| ${c.iter === 0 ? '모방 후' : `PPO ${c.iter}`} | ${c.rate.toFixed(1)}% | ${c.ret.toFixed(0)} | ${c.steps.toFixed(1)} | ${c.empties.toFixed(1)} | ${c.repaired.toFixed(1)} | ${c.infeasible.toFixed(1)} |`);
L.push('', '## 최고 정책으로 10분 과제 (전체 셀 시뮬레이터, 대형 단독 — 자세히: cell-eval-alone.md)', '', '| 시드 | PPO 정책 | 규칙 경로 | 차이 | PPO 스트로크 (재시도) | PPO 흘림 / 규칙 흘림 |', '|---|---|---|---|---|---|');
for (const r of rows) L.push(`| ${r.seed} | **${r.ppo.rateCount}%** | ${r.rule.rateCount}% | ${(r.ppo.rateCount - r.rule.rateCount).toFixed(1)}%p | ${r.strokes} (${r.retries}) | ${r.ppo.spilled} / ${r.rule.spilled} |`);
L.push(`| 평균 | **${mean(rows.map((r) => r.ppo.rateCount)).toFixed(1)}%** | ${mean(rows.map((r) => r.rule.rateCount)).toFixed(1)}% | ${(mean(rows.map((r) => r.ppo.rateCount)) - mean(rows.map((r) => r.rule.rateCount))).toFixed(1)}%p | | |`);
L.push('', `- 정책 파일: \`policy-best.json\` (robosim-policy/1) — 앱 '학습' 패널의 [정책 불러오기]로 실행·3D 재생. 중간 정책: \`checkpoints/iter-NNN.json\`. 3D 재생: \`ppo-alone-s<시드>.rsim.json.gz\`(정책) · \`rule-alone-s<시드>.rsim.json.gz\`(규칙).`);
writeFileSync(`${outDir}/train-report.md`, L.join('\n') + '\n');
console.log('\n' + L.join('\n'));
finishRun(root, run, { summary: `최고 = ${bestPolicy.phase === 'bc' ? '모방 직후' : `반복 ${bestPolicy.iter}`} 학습 평가 ${best.rate.toFixed(1)}% · 셀 단독 PPO ${mean(rows.map((r) => r.ppo.rateCount)).toFixed(1)}% vs 규칙 ${mean(rows.map((r) => r.rule.rateCount)).toFixed(1)}%`, detail: { iterations: ITER, bc: BC, episodes: EPISODES, workers: WORKERS, lab, demos: DEMO_FILES, demoSamples: DEMOS?.samples.length ?? 0 } });
console.log(`\n저장: ${outDir}/ — 전체 ${((Date.now() - t0) / 1000).toFixed(0)} s`);
