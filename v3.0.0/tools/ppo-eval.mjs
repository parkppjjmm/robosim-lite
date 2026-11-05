// 학습된 PPO 정책 평가 — 10분 과제(전체 셀 시뮬레이터)에서 정책 vs 규칙 경로, 3D 재생 파일 저장
// 실행: node tools/ppo-eval.mjs --policy results/ppo/<이름>/policy.json [--seeds 11,12,13] [--config alone|mode1|mode2] [--out <폴더>]
// 결과: <out>/eval.md, <out>/eval-<구성>-s<시드>.rsim.json.gz (정책), <out>/rule-<구성>-s<시드>.rsim.json.gz (규칙)
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
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
const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));

const polPath = arg('policy');
if (!polPath) {
  console.error('--policy <policy.json> 이 필요합니다.');
  process.exit(1);
}
const pol = JSON.parse(readFileSync(polPath, 'utf8'));
const agent = PPO.importPolicy(pol);
const lab = LAB.sanitizeLab(pol.lab);
const seeds = arg('seeds', '11,12,13').split(',').map(Number);
const config = arg('config', 'alone');
const CONFIGS = { alone: [null, null], mode1: ['ur-ur10e:1', 'abb-irb1200-5-09:1'], mode2: ['ur-ur10e:2', 'ur-ur10e:2'] };
const sideOf = (v) => (v ? { robotId: v.split(':')[0], mode: Number(v.split(':')[1]) === 2 ? 2 : 1 } : { robotId: null, mode: 1 });
const outDir = arg('out', dirname(polPath));
const RAPIER = await loadRapier();
const rows = [];
for (const seed of seeds) {
  const [left, right] = CONFIGS[config].map(sideOf);
  const { task } = TE.sanitizeTask({ timeLimitS: pol.task?.timeLimitS ?? 600, cell: { main: pol.task?.main ?? 'kuka-kr210-r2700', left, right }, dross: { seed, count: pol.task?.count ?? 160 } }, robots);
  const pr = await LAB.runPolicy({ RAPIER, robots, task, lab, agent, runEpisode: CS.runEpisode, record: new RP.EpisodeRecorder({ everyS: 0.1 }) });
  writeFileSync(`${outDir}/eval-${config}-s${seed}.rsim.json.gz`, gzipSync(JSON.stringify({ ...pr.episode, lab: { method: 'ppo-policy', reward: lab.reward } })));
  const rr = await CS.runEpisode(task, { RAPIER, robots, record: new RP.EpisodeRecorder({ everyS: 0.1 }) });
  writeFileSync(`${outDir}/rule-${config}-s${seed}.rsim.json.gz`, gzipSync(JSON.stringify(rr.episode)));
  const d = pr.log.decisions;
  rows.push({ seed, ppo: pr.summary, rule: rr.summary, strokes: d.length, repaired: d.filter((x) => x.repaired > 0).length, fallback: d.filter((x) => x.fallback).length, retries: d.filter((x) => x.retry).length });
  console.log(`  ${config} 시드 ${seed}: PPO ${pr.summary.rateCount}% / 규칙 ${rr.summary.rateCount}% (스트로크 ${d.length}, 보정 ${rows.at(-1).repaired}, 규칙 대체 ${rows.at(-1).fallback}, 재시도 ${rows.at(-1).retries})`);
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const L = [];
L.push(`## 최고 정책 10분 과제 — ${config} (전체 셀 시뮬레이터, ${new Date().toISOString()})`, '');
L.push(`- 정책: \`${polPath.replace(/\\/g, '/').split('/').slice(-3).join('/')}\` (${pol.phase === 'bc' ? '모방 직후' : `PPO 반복 ${pol.iter}`}, 학습 평가 회수율 ${pol.eval?.rate?.toFixed(1) ?? '—'}%)`);
L.push('- 실행: 결정적(평균) 행동, 계획 불가면 보정(repair) → 그래도 안 되면 규칙 레인으로 대체', '');
L.push('| 시드 | PPO 정책 | 규칙 경로 | 차이 | 스트로크 | 보정 | 규칙 대체 | 흘림 (PPO / 규칙) |', '|---|---|---|---|---|---|---|---|');
for (const r of rows) L.push(`| ${r.seed} | **${r.ppo.rateCount}%** | ${r.rule.rateCount}% | ${(r.ppo.rateCount - r.rule.rateCount).toFixed(1)}%p | ${r.strokes} | ${r.repaired} | ${r.fallback} | ${r.ppo.spilled} / ${r.rule.spilled} |`);
L.push(`| 평균 | **${mean(rows.map((r) => r.ppo.rateCount)).toFixed(1)}%** | ${mean(rows.map((r) => r.rule.rateCount)).toFixed(1)}% | ${(mean(rows.map((r) => r.ppo.rateCount)) - mean(rows.map((r) => r.rule.rateCount))).toFixed(1)}%p | | | | |`);
L.push('', `3D 재생: \`eval-${config}-s<시드>.rsim.json.gz\`(정책) · \`rule-${config}-s<시드>.rsim.json.gz\`(규칙)`);
writeFileSync(`${outDir}/eval-${config}.md`, L.join('\n') + '\n');
console.log('\n' + L.join('\n'));
