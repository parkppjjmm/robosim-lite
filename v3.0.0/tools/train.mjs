// v3.0.0 학습(Trial & Error) 헤드리스 실행 — PRD_v.3.0.0 4.5·FR-67 (L1 진화 탐색 단계)
// 10분 과제를 돌리며 대형 로봇이 쉴 때마다 스트로크 후보(시작점·방향·길이·열린 면 방향(J6)·회전·기울임·깊이·속도)를
// 병렬로 시도해 점수(보상 규칙)가 가장 높은 것만 실행한다. 측면 로봇은 기존 경로. 같은 과제의 규칙 경로 결과와 비교한다.
// 실행: node tools/train.mjs [--lab 설정.json] [--main kuka-kr210-r2700] [--config alone|mode1|mode2] [--seed 11] [--count 160]
//                           [--target 80] [--time 600] [--workers N] [--population 16] [--iterations 3] [--method cem|random]
//                           [--no-compare] [--out results/<방법>/<로봇>-<구성>-s<시드>]
//   --lab: 앱 '학습' 패널의 [설정 내보내기]로 만든 파일 (robosim-lab/1). 명령행 값이 있으면 그것이 우선한다.
// 결과(이름 규칙은 results/README.md): <out>/report.md, <out>/<방법>-<구성>-s<시드>.rsim.json.gz(학습 3D 재생),
//   <out>/rule-<구성>-s<시드>.rsim.json.gz(같은 과제의 규칙 경로), <out>/log.json(모든 시도)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { configName } from './lib/policy-eval.mjs';
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
const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));

// ---- 설정 ----
const fileCfg = arg('lab') ? JSON.parse(readFileSync(arg('lab'), 'utf8')) : {};
const labRaw = { ...fileCfg.lab ?? fileCfg };
for (const k of ['population', 'iterations', 'method', 'seed']) if (arg(k) !== undefined) labRaw[k] = k === 'method' ? arg(k) : Number(arg(k));
const lab = LAB.sanitizeLab(labRaw);
const CONFIGS = { alone: [null, null], mode1: ['ur-ur10e:1', 'abb-irb1200-5-09:1'], mode2: ['ur-ur10e:2', 'ur-ur10e:2'] };
const sideOf = (v) => (v ? { robotId: v.split(':')[0], mode: Number(v.split(':')[1]) === 2 ? 2 : 1 } : { robotId: null, mode: 1 });
const conf = arg('config');
const taskRaw = { ...(fileCfg.task ?? {}) };
taskRaw.cell = { ...(taskRaw.cell ?? {}) };
if (arg('main')) taskRaw.cell.main = arg('main');
if (conf) [taskRaw.cell.left, taskRaw.cell.right] = CONFIGS[conf].map(sideOf);
taskRaw.dross = { ...(taskRaw.dross ?? {}) };
if (arg('seed')) taskRaw.dross.seed = Number(arg('seed'));
if (arg('count')) taskRaw.dross.count = Number(arg('count'));
if (arg('target')) taskRaw.targetRatePct = Number(arg('target'));
if (arg('time')) taskRaw.timeLimitS = Number(arg('time'));
taskRaw.aiRobot = { slot: 'main' }; // v3.0.0 1차: 학습 대상 = 대형 로봇 (측면 로봇 학습은 다음 단계)
const { task, errors } = TE.sanitizeTask(taskRaw, robots);
if (errors.length) {
  console.error('설정 오류: ' + errors.join(' / '));
  process.exit(1);
}
const workers = Math.max(1, Number(arg('workers', Math.max(1, cpus().length - 2))));
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const cfgName = configName(task.cell);
const runName = `${task.cell.main.split('-')[1]}-${cfgName}-s${task.dross.seed}`;
let outDir = `${root}/${arg('out', `results/${lab.method}/${runName}`)}`;
if (!arg('out')) for (let k = 2; existsSync(outDir); k++) outDir = `${root}/results/${lab.method}/${runName}-${k}`; // 같은 이름이 있으면 -2, -3 …
const epName = `${lab.method}-${cfgName}-s${task.dross.seed}.rsim.json.gz`;
const ruleName = `rule-${cfgName}-s${task.dross.seed}.rsim.json.gz`;
void stamp;
mkdirSync(outDir, { recursive: true });

// ---- 작업자 풀 ----
class EvalPool {
  constructor(n) {
    this.idle = [];
    this.queue = [];
    this.wait = new Map();
    this.seq = 0;
    this.ready = Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
      const w = new Worker(new URL('./lab-worker.mjs', import.meta.url));
      w.on('message', (m) => {
        if (m.type === 'ready') {
          this.idle.push(w);
          this.pump();
          return resolve();
        }
        this.wait.get(m.id)(m.result);
        this.wait.delete(m.id);
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => console.error('작업자 오류:', e.message));
      w.postMessage({ type: 'init', robots });
      (this.all ??= []).push(w);
    })));
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { id, job } = this.queue.shift();
      w.postMessage({ id, job });
    }
  }

  run(jobs) {
    return Promise.all(jobs.map((job) => new Promise((resolve) => {
      const id = ++this.seq;
      this.wait.set(id, resolve);
      this.queue.push({ id, job });
      this.pump();
    })));
  }

  close() {
    for (const w of this.all ?? []) w.terminate();
  }
}

const RAPIER = await loadRapier();
const name = (id) => robots.find((r) => r.id === id)?.name ?? id;
console.log(`학습: ${name(task.cell.main)} · 왼쪽 ${task.cell.left.robotId ?? '없음'} · 오른쪽 ${task.cell.right.robotId ?? '없음'} · 드로스 ${task.dross.count}개 시드 ${task.dross.seed} · 목표 ${task.targetRatePct}% / ${task.timeLimitS} s`);
console.log(`탐색: ${lab.method} · 후보 ${lab.population} × 세대 ${lab.iterations} · 탐색 변수 ${LAB.searchKeys(lab).join(', ')} · 작업자 ${workers}`);
console.log(`점수 규칙: ${JSON.stringify(lab.reward)}`);
const pool = new EvalPool(workers);
await pool.ready;
const t0 = Date.now();
const rec = new RP.EpisodeRecorder({ everyS: 0.1 });
const lab1 = await LAB.runLab({
  RAPIER, robots, task, lab, record: rec, runEpisode: CS.runEpisode, evalBatch: (jobs) => pool.run(jobs),
  onProgress: (p) => {
    if (p.kind !== 'decision') return;
    const d = p.decision;
    console.log(`  결정 ${String(d.n).padStart(2)} @ ${String(d.t).padStart(5)} s · 회수율 ${p.rate.toFixed(1)}% · 시도 ${d.trials} (${d.evalS} s) · 최고 점수 ${d.best.score} (규칙 ${d.ruleScore ?? '—'})${d.best.rule ? ' = 규칙 레인' : ''} · 예상 회수 ${d.best.collected} · 방향 ${d.best.values.headingDeg.toFixed(0)}° 열린 면 ${d.best.values.yaw0Deg.toFixed(0)}→${d.best.values.yaw1Deg.toFixed(0)}° 기울임 ${d.best.values.tiltDeg.toFixed(0)}°`);
  },
});
pool.close();
const trainS = (Date.now() - t0) / 1000;
writeFileSync(`${outDir}/${epName}`, gzipSync(JSON.stringify({ ...lab1.episode, lab: { method: lab.method, reward: lab.reward } })));
writeFileSync(`${outDir}/log.json`, JSON.stringify(lab1.log, null, 1));

// ---- 같은 과제의 규칙 경로 (비교) ----
let rule = null;
if (!process.argv.includes('--no-compare')) {
  const rr = new RP.EpisodeRecorder({ everyS: 0.1 });
  rule = await CS.runEpisode(task, { RAPIER, robots, record: rr });
  writeFileSync(`${outDir}/${ruleName}`, gzipSync(JSON.stringify(rule.episode)));
}

// ---- 보고서 ----
const S = lab1.log.summary;
const R = rule?.summary;
const L = [];
L.push(`# 학습(Trial & Error) 결과 — ${new Date().toISOString()}`, '');
L.push(`- 과제: ${name(task.cell.main)} · 왼쪽 ${task.cell.left.robotId ?? '없음'} · 오른쪽 ${task.cell.right.robotId ?? '없음'} · 드로스 ${task.dross.count}개(시드 ${task.dross.seed}) · 목표 ${task.targetRatePct}% · ${task.timeLimitS} s`);
L.push(`- 탐색: ${lab.method} · 후보 ${lab.population} × 세대 ${lab.iterations} · 규칙 레인을 첫 세대 후보에 포함: ${lab.includeRule ? '예' : '아니오'} · 작업자 ${workers} · 학습 시간 ${trainS.toFixed(0)} s`);
L.push(`- 점수 규칙: 회수 +${lab.reward.perDross}/개 · 벽 띠 +${lab.reward.wallBonus} · 헛질 ${lab.reward.emptyStroke} · 흘림 ${lab.reward.spill}/개 · ${lab.reward.perSecond}/s · 계획 불가 ${lab.reward.infeasible}`);
L.push('- 시뮬레이터 결과(구형 입자 근사)다. 후보 평가는 측면 로봇 없이 복사한 드로스 위에서 하므로 실제 실행 결과와 다를 수 있다.', '');
L.push('| 항목 | 학습(최선 채택) | 규칙 경로(v1.1.2) |', '|---|---|---|');
L.push(`| 회수율 (개수 / 질량) | **${S.rateCount}%** / ${S.rateMass}% | ${R ? `**${R.rateCount}%** / ${R.rateMass}%` : '—'} |`);
L.push(`| 목표 ${task.targetRatePct}% 도달 | ${S.reached ? `예 (${S.reachS} s)` : '아니오'} | ${R ? (R.reached ? `예 (${R.reachS} s)` : '아니오') : '—'} |`);
L.push(`| 로봇별 회수 | ${Object.entries(S.byRobot).map(([k, v]) => `${k} ${v.n}`).join(' · ')} | ${R ? Object.entries(R.byRobot).map(([k, v]) => `${k} ${v.n}`).join(' · ') : '—'} |`);
L.push(`| 대형 스트로크 수 / 헛질 | ${S.decisions} / ${S.emptyStrokes} | ${R ? `${R.mainCycles} / —` : '—'} |`);
L.push(`| 흘림 | ${S.spilled} | ${R?.spilled ?? '—'} |`);
L.push(`| 시도(후보 평가) 수 | ${S.trials} (규칙 레인이 최선으로 뽑힌 결정 ${S.ruleChosen}) | — |`, '');
L.push('## 결정별 최선 스트로크', '', '| # | 시각 s | 회수율 % | 최고 점수 (규칙) | 예상 회수 → 실제 | 시작 (x, y) | 방향° | 길이 | 열린 면° (시작→끝) | 기울임° | 깊이 | 속도 |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const d of lab1.log.decisions) {
  const v = d.best.values;
  L.push(`| ${d.n} | ${d.t} | ${d.rate} | ${d.best.score} (${d.ruleScore ?? '—'})${d.best.rule ? ' 규칙' : ''} | ${d.best.collected} → ${d.actualCollected ?? '—'} | ${v.x0.toFixed(0)}, ${v.y0.toFixed(0)} | ${v.headingDeg.toFixed(0)} | ${v.lengthMm.toFixed(0)} | ${v.yaw0Deg.toFixed(0)}→${v.yaw1Deg.toFixed(0)} | ${v.tiltDeg.toFixed(0)} | ${v.depthMm.toFixed(0)} | ${v.speedMmS.toFixed(0)} |`);
}
L.push('', `3D로 보기: 앱 '에피소드 재생'에서 \`${outDir.replace(root + '/', '')}/${epName}\`(학습)·\`${ruleName}\`(규칙)를 불러온다(용량 때문에 git에는 없음).`);
writeFileSync(`${outDir}/report.md`, L.join('\n') + '\n');
console.log('\n' + L.slice(0, 13).join('\n'));
console.log(`\n저장: ${outDir}/ (${epName}, ${ruleName}, log.json, report.md) — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
