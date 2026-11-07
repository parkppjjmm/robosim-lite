// 학습된 PPO 정책 평가 — 10분 과제(전체 셀 시뮬레이터)에서 정책 vs 규칙 경로, 3D 재생 파일 저장
// 실행: node tools/ppo-eval.mjs --policy results/<날짜>/<시각>_ppo-train_<이름>/policy-best.json [--seeds 11,12,13] [--config alone|mode1|mode2|push] [--rule-lane-dir robot|alternate] [--snout-rule free|no-repeat] [--out <폴더>]
//   --snout-rule no-repeat: 스나우트 쪽 쓸기 연속 금지(직전이 스나우트 쪽이면 이번에는 같은 레인을 로봇 쪽으로) — 2026-11-07, 학습 없이 실행 단계에서 시험. 폴더 이름 끝에 -norepeat
// 결과: results/<날짜>/<시각>_ppo-eval_<정책 폴더>-<구성>/ — cell-eval-<구성>.md (표), ppo-·rule-<구성>-s<시드>.rsim.json.gz (3D 재생), run.json
//   (이전 결과를 덮어쓰지 않는다. 이름 규칙은 results/README.md)
import { readFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { evalPolicyCell, CONFIGS } from './lib/policy-eval.mjs';

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
  console.error('--policy <policy-best.json> 이 필요합니다.');
  process.exit(1);
}
const config = arg('config', 'alone');
if (!CONFIGS[config]) {
  console.error(`--config 는 ${Object.keys(CONFIGS).join('|')} 중 하나입니다.`);
  process.exit(1);
}
const pol = JSON.parse(readFileSync(polPath, 'utf8'));
const agent = PPO.importPolicy(pol);
const lab = LAB.sanitizeLab(pol.lab);
const seeds = arg('seeds', '11,12,13').split(',').map(Number);
const polName = basename(dirname(polPath.replace(/\\/g, '/'))).replace(/^\d{4}_ppo-train_/, '');
const SNOUT_RULE = arg('snout-rule', 'free');
const run = makeRunDir(root, 'ppo-eval', `${polName}-${config}${SNOUT_RULE === 'no-repeat' ? '-norepeat' : ''}`, arg('out'));
const outDir = run.dir;
const RAPIER = await loadRapier();
const policyLabel = `\`${polPath.replace(/\\/g, '/').split('/').slice(-3).join('/')}\` (${pol.phase === 'bc' ? '모방 직후' : `PPO 반복 ${pol.iter}`}, 학습 평가 회수율 ${pol.eval?.rate?.toFixed(1) ?? '—'}%)`;
const { md, file, meanPpo, meanRule } = await evalPolicyCell({ m: { TE, CS, RP, LAB }, RAPIER, robots, pol, agent, lab, config, seeds, outDir, policyLabel, ruleLaneDir: arg('rule-lane-dir', 'robot'), snoutRule: SNOUT_RULE });
console.log('\n' + md);
finishRun(root, run, { summary: `${config}${SNOUT_RULE === 'no-repeat' ? '(스나우트 쪽 연속 금지)' : ''}: PPO ${meanPpo.toFixed(1)}% vs 규칙 ${meanRule.toFixed(1)}% (시드 ${seeds.join('·')})`, detail: { policy: polPath.replace(/\\/g, '/'), config, seeds, snoutRule: SNOUT_RULE } });
console.log(`저장: ${file}`);
