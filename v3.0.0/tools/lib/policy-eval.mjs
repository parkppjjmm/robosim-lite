// 학습된 PPO 정책을 전체 셀 시뮬레이터(10분 과제)에서 규칙 경로와 같은 조건으로 비교 — tools/ppo-eval.mjs·tools/ppo-train.mjs 공용
// 파일 이름 규칙(results/README.md): 3D 재생 = <방법>-<구성>-s<시드>.rsim.json.gz (방법 ppo|rule), 보고서 = cell-eval-<구성>.md
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** 셀 구성 (구성 이름 → [왼쪽, 오른쪽] 측면 로봇 '로봇id:모드') */
export const CONFIGS = { alone: [null, null], mode1: ['ur-ur10e:1', 'abb-irb1200-5-09:1'], mode2: ['ur-ur10e:2', 'ur-ur10e:2'], push: ['ur-ur10e:3', 'ur-ur10e:3'] };
export const CONFIG_LABEL = {
  alone: '대형 단독',
  mode1: '대형 + 측면 2대 (모드 1: 측면 로봇이 각자 박스에 담음)',
  mode2: '대형 + 측면 2대 (모드 2: 측면 로봇이 대형 레인으로 밀어 줌, 포트 점유 잠금)',
  push: '대형 + 측면 2대 (모드 3: 타이밍 밀기 — 대형이 나가 있는 동안만 밀기, 대형만 회수)',
};
export const sideOf = (v) => (v ? { robotId: v.split(':')[0], mode: [2, 3].includes(Number(v.split(':')[1])) ? Number(v.split(':')[1]) : 1 } : { robotId: null, mode: 1 });

/** 셀 설정(cell) → 구성 이름 (alone | mode1 | mode2 | custom) */
export function configName(cell) {
  const l = cell.left?.robotId ? cell.left.mode : 0;
  const r = cell.right?.robotId ? cell.right.mode : 0;
  if (!l && !r) return 'alone';
  if (l === r) return l === 3 ? 'push' : `mode${l}`;
  return 'custom';
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

/**
 * @param m { TE, CS, RP, LAB } 모듈 (호출하는 도구가 불러온 것)
 * @returns { rows, md, file } — rows: 시드별 { seed, ppo, rule, strokes, repaired, fallback, retries }
 */
export async function evalPolicyCell({ m, RAPIER, robots, pol, agent, lab, config = 'alone', seeds = [11, 12, 13], outDir, policyLabel, ruleLaneDir = 'robot', log = console.log }) {
  const { TE, CS, RP, LAB } = m;
  const rows = [];
  for (const seed of seeds) {
    const [left, right] = CONFIGS[config].map(sideOf);
    const { task } = TE.sanitizeTask({ timeLimitS: pol.task?.timeLimitS ?? 600, cell: { main: pol.task?.main ?? 'kuka-kr210-r2700', left, right }, dross: { seed, count: pol.task?.count ?? 160 }, mainRule: { laneDir: ruleLaneDir } }, robots);
    const pr = await LAB.runPolicy({ RAPIER, robots, task, lab, agent, runEpisode: CS.runEpisode, record: new RP.EpisodeRecorder({ everyS: 0.1 }) });
    writeFileSync(`${outDir}/ppo-${config}-s${seed}.rsim.json.gz`, gzipSync(JSON.stringify({ ...pr.episode, lab: { method: 'ppo-policy', reward: lab.reward } })));
    const rr = await CS.runEpisode(task, { RAPIER, robots, record: new RP.EpisodeRecorder({ everyS: 0.1 }) });
    writeFileSync(`${outDir}/rule-${config}-s${seed}.rsim.json.gz`, gzipSync(JSON.stringify(rr.episode)));
    const d = pr.log.decisions;
    const row = { seed, ppo: pr.summary, rule: rr.summary, strokes: d.length, repaired: d.filter((x) => x.repaired > 0).length, fallback: d.filter((x) => x.fallback).length, retries: d.filter((x) => x.retry).length };
    rows.push(row);
    log(`  ${config} 시드 ${seed}: PPO ${row.ppo.rateCount}% / 규칙 ${row.rule.rateCount}% (스트로크 ${row.strokes}, 보정 ${row.repaired}, 규칙 대체 ${row.fallback}, 재시도 ${row.retries})`);
  }
  const mp = mean(rows.map((r) => r.ppo.rateCount));
  const mr = mean(rows.map((r) => r.rule.rateCount));
  const L = [];
  L.push(`# 전체 셀 10분 과제 평가 — ${CONFIG_LABEL[config]} (\`${config}\`)`, '');
  L.push(`- 측정: ${new Date().toISOString()} · \`node tools/ppo-eval.mjs\``);
  L.push(`- 정책: ${policyLabel}`);
  L.push(`- 비교: 같은 드로스 배치(시드)에서 대형 로봇만 **PPO 정책** ↔ **규칙 경로(쓸기 방향 ${ruleLaneDir})** 로 바꿔 실행. 측면 로봇은 둘 다 기존 경로.`);
  L.push('- 정책 실행: 결정적(평균) 행동 → 계획 불가면 보정(repair) → 그래도 안 되면 규칙 레인으로 대체. 측면 로봇 구역은 침범하지 않음.', '');
  L.push('| 시드 | PPO 정책 | 규칙 경로 | 차이 | 스트로크 | 보정 | 규칙 대체 | 흘림 (PPO / 규칙) |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.seed} | **${r.ppo.rateCount}%** | ${r.rule.rateCount}% | ${(r.ppo.rateCount - r.rule.rateCount).toFixed(1)}%p | ${r.strokes} | ${r.repaired} | ${r.fallback} | ${r.ppo.spilled} / ${r.rule.spilled} |`);
  L.push(`| 평균 | **${mp.toFixed(1)}%** | ${mr.toFixed(1)}% | ${(mp - mr).toFixed(1)}%p | | | | |`);
  L.push('', `3D 재생(앱 '에피소드 재생'): \`ppo-${config}-s<시드>.rsim.json.gz\`(정책) · \`rule-${config}-s<시드>.rsim.json.gz\`(규칙)`);
  const md = L.join('\n') + '\n';
  const file = `${outDir}/cell-eval-${config}.md`;
  writeFileSync(file, md);
  return { rows, md, file, meanPpo: mp, meanRule: mr };
}
