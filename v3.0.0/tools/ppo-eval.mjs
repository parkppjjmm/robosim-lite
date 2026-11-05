// 학습된 PPO 정책 평가 — 10분 과제(전체 셀 시뮬레이터)에서 정책 vs 규칙 경로, 3D 재생 파일 저장
// 실행: node tools/ppo-eval.mjs --policy results/ppo/<이름>/policy-best.json [--seeds 11,12,13] [--config alone|mode1|mode2] [--out <폴더>]
// 결과(이름 규칙은 results/README.md): <out>/cell-eval-<구성>.md (표), <out>/ppo-<구성>-s<시드>.rsim.json.gz (정책), <out>/rule-<구성>-s<시드>.rsim.json.gz (규칙)
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
const outDir = arg('out', dirname(polPath));
const RAPIER = await loadRapier();
const policyLabel = `\`${polPath.replace(/\\/g, '/').split('/').slice(-3).join('/')}\` (${pol.phase === 'bc' ? '모방 직후' : `PPO 반복 ${pol.iter}`}, 학습 평가 회수율 ${pol.eval?.rate?.toFixed(1) ?? '—'}%)`;
const { md, file } = await evalPolicyCell({ m: { TE, CS, RP, LAB }, RAPIER, robots, pol, agent, lab, config, seeds, outDir, policyLabel });
console.log('\n' + md);
console.log(`저장: ${file}`);
