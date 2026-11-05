// v1.1.1: 드로스 셀 측면 로봇(소형·협동) — UR 3종, 설치·레인, 대형 + 측면 2대 동시 실행 재현(모드 1·2)
// main.js와 같은 순서(측면 로봇 → 대형 로봇 안전 게이트(다른 로봇 포함) → 물리)로 물리 월드에서 실행하고
// 안전 위반·로봇 간 최소 거리·박스별 회수량·모드 2 잠금 위반을 확인한다.
// 실행: node tests/cell-robots.mjs [--long]   (Node 18+, Rapier는 tests/.cache/)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const G = await imp('gripper.js');
const S = await imp('safety.js');
const TR = await imp('trajectory.js');
const PL = await imp('planner.js');
const P = await imp('physics.js');
const D = await imp('dross.js');
const C = await imp('cell-robot.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const RAPIER = await loadRapier();
const DT = 1 / 60;
const SIM_S = Number(process.env.SIM_S) || (process.argv.includes('--long') ? 240 : 120);
const byId = (id) => robots.find((r) => r.id === id);

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

// ---- 1. UR 3종 ----
{
  const ur = robots.filter((r) => r.maker === 'UR');
  check('UR 3종(UR5e·UR10e·UR20), 협동 로봇 표시', ur.map((r) => r.name).join() === 'UR5e,UR10e,UR20' && ur.every((r) => r.cobot), ur.map((r) => `${r.name} ${r.reachMm} mm`).join(', '));
  const reachOk = ur.every((r) => Math.abs(K.maxReach(r) - r.reachMm) / r.reachMm < 0.05);
  check('UR 도달거리 카탈로그 ±5%', reachOk, ur.map((r) => `${r.name} ${K.maxReach(r).toFixed(0)}`).join(', '));
  const sideList = robots.filter(C.sideRobotOk).map((r) => r.name);
  check('측면 로봇 후보 = 소형 4종 + UR 3종', sideList.length === 7 && sideList.includes('UR10e'), sideList.join(', '));
}

// ---- 2. 설치·레인 (후보 × 슬롯 × 모드) ----
const fixturesFor = (sides) => D.drossFixtures(sides);
console.log('\n| 로봇 | 슬롯 | 모드 | 대기 자세 | 레인 |');
const laneTable = {};
for (const robot of robots.filter(C.sideRobotOk)) {
  for (const slot of ['left', 'right']) {
    for (const mode of [1, 2]) {
      const binDist = mode === 1 ? D.sideBinDistFor(robot.id) : undefined;
      if (mode === 1 && binDist == null) {
        laneTable[`${robot.id}:${slot}:${mode}`] = 0;
        console.log(`| ${robot.name} | ${slot} | 1 | — | 모드 1 불가 (측면 박스 덤프 자세 없음) |`);
        continue;
      }
      const sides = { [slot]: { robotId: robot.id, mode, binDist } };
      const cr = new C.CellRobot(slot, robot, mode, { thresholds: TH, obstaclesWorld: fixturesFor(sides), binDist });
      const park = cr.findPark() !== null;
      laneTable[`${robot.id}:${slot}:${mode}`] = cr.lanes.length;
      const desc = cr.lanes.map((l) => (mode === 1 ? `y${l.startW[1]} x${l.startW[0]}→${l.endW[0]}` : `x${l.startW[0]} y${l.startW[1]}→${l.endW[1]}`)).join(' / ');
      console.log(`| ${robot.name} | ${slot} | ${mode} | ${park ? 'O' : 'X'} | ${cr.lanes.length}개 ${desc}${binDist ? ` · 박스 거리 ${binDist}` : ''} |`);
    }
  }
}
check('UR10e: 양쪽 슬롯 · 두 모드 모두 레인 있음', ['left:1', 'left:2', 'right:1', 'right:2'].every((k) => laneTable[`ur-ur10e:${k}`] > 0));
check('UR5e: 양쪽 슬롯 · 두 모드 모두 레인 있음', ['left:1', 'left:2', 'right:1', 'right:2'].every((k) => laneTable[`ur-ur5e:${k}`] > 0));
check('UR20: 양쪽 슬롯 · 두 모드 모두 레인 있음', ['left:1', 'left:2', 'right:1', 'right:2'].every((k) => laneTable[`ur-ur20:${k}`] > 0));
// 측면 박스 거리 표 = 실제 계산 결과 (왼쪽 슬롯 기준으로 다시 계산해 비교)
if (!process.env.ONLY) {
  const diff = [];
  for (const robot of robots.filter(C.sideRobotOk)) {
    const d = await C.pickSideBinDist(robot, 'left', TH);
    if (d !== D.SIDE_BIN_TABLE[robot.id]) diff.push(`${robot.id}: 표 ${D.SIDE_BIN_TABLE[robot.id]} / 계산 ${d}`);
  }
  check('측면 박스 거리 표(SIDE_BIN_TABLE) = 계산 결과', diff.length === 0, diff.join(', ') || '7종 일치');
}

// ---- 3. 동시 실행 재현 ----
// v3.0.0: 루프는 js/cell-sim.js runEpisode로 옮겼다(브라우저 main.js와 같은 순서: 측면 → 대형 안전 게이트(다른 로봇 포함) → 물리).
const CS = await imp('cell-sim.js');
const TE = await imp('task-eval.js');
async function simulate(mainId, sidesIn, label) {
  const cell = { main: mainId, left: sidesIn.left ?? { robotId: null, mode: 1 }, right: sidesIn.right ?? { robotId: null, mode: 1 } };
  const { task, errors } = TE.sanitizeTask({ cell, timeLimitS: SIM_S, dross: { count: 160, seed: 11 } }, robots);
  if (errors.length) throw new Error(errors.join(' / '));
  const { summary, out } = await CS.runEpisode(task, { RAPIER, robots, thresholds: TH, simS: SIM_S, profile: !!process.env.PROFILE, debug: !!process.env.DBG });
  const st = out.stats;
  const sideTxt = Object.entries(out.side).map(([k, v]) => `${k} ${v.name} 모드${v.mode} 작업 ${v.cycles}회(레인 ${v.lanes})`).join(' · ');
  console.log(`\n### ${label} — ${SIM_S} s`);
  console.log(`    대형 사이클 ${out.mainCycles}, 박스 ${JSON.stringify(st.bins)}, 작업 영역 남은 ${st.work}, 흘림 ${st.spilled}, ${sideTxt}`);
  console.log(`    대형↔측면 최소 거리 ${out.minMainSide.toFixed(0)} mm, 측면 간섭 대기 ${out.holdS.toFixed(1)} s, 계획 실패 ${out.planFail.length}${out.planFail.length ? ` (${out.planFail.slice(0, 2).join(' | ')})` : ''}`);
  console.log(`    회수율(작업 영역 기준) ${summary.rateCount}% (질량 ${summary.rateMass}%), 배속 ${summary.speedup}× (${summary.wallS} s)`);
  return { ...out, summary };
}

const base = process.env.ONLY && process.env.ONLY !== 'A' ? { mainBlocked: 0, stats: { bins: { main: 1 }, bin: 0, work: 0 }, mainCycles: 0 } : await simulate('kuka-kr210-r2700', {}, 'A. 대형 로봇 단독 (KR 210)');
check('A: 대형 단독 — 안전 위반 0, 회수 > 0', base.mainBlocked === 0 && base.stats.bins.main > 0, `사이클 ${base.mainCycles}, 회수 ${base.stats.bins.main}`);

const m1 = process.env.ONLY && process.env.ONLY !== 'B' ? null : await simulate('kuka-kr210-r2700', { left: { robotId: 'ur-ur10e', mode: 1 }, right: { robotId: 'abb-irb1200-5-09', mode: 1 } }, 'B. 모드 1 — KR 210 + 왼쪽 UR10e + 오른쪽 IRB 1200 (각자 제거)');
if (m1) check('B: 대형·측면 모두 안전 위반 0', m1.mainBlocked === 0 && m1.sideBlocked === 0, `대형 ${m1.mainBlocked} ${m1.lastMainBlock ?? ''} / 측면 ${m1.sideBlocked} ${m1.lastSideBlock ?? ''}`);
if (m1) check('B: 로봇 간 최소 거리 ≥ 여유거리 20 mm', m1.minMainSide >= TH.obstacleMarginMm, `${m1.minMainSide.toFixed(0)} mm`);
if (m1) check('B: 측면 로봇이 자기 박스에 회수 (왼쪽·오른쪽 각 1개 이상)', m1.stats.bins.left > 0 && m1.stats.bins.right > 0, JSON.stringify(m1.stats.bins));
// 처리량은 합격 기준이 아니라 측정값으로 남긴다 (모드 1은 대형 레인이 가운데로 줄고 측면 스쿱이 작아 120 s 합계가 단독보다 적을 수 있음 — REVIEW n-7)
if (m1) console.log(`    측정: 모드 1 합계 회수 ${m1.stats.bin} (대형 ${m1.stats.bins.main} + 왼쪽 ${m1.stats.bins.left} + 오른쪽 ${m1.stats.bins.right}) vs 대형 단독 ${base.stats.bin}`);

const m2 = process.env.ONLY && process.env.ONLY !== 'C' ? null : await simulate('kuka-kr210-r2700', { left: { robotId: 'ur-ur10e', mode: 2 }, right: { robotId: 'ur-ur10e', mode: 2 } }, 'C. 모드 2 — KR 210 + 양쪽 UR10e (대형 쪽으로 밀기)');
if (m2) check('C: 대형·측면 모두 안전 위반 0', m2.mainBlocked === 0 && m2.sideBlocked === 0, `대형 ${m2.mainBlocked} ${m2.lastMainBlock ?? ''} / 측면 ${m2.sideBlocked} ${m2.lastSideBlock ?? ''}`);
if (m2) check('C: 포트 점유 잠금 위반 0 (대형이 포트 안일 때 측면 밀기 없음)', m2.lockViolations === 0, `${m2.lockViolations} tick`);
if (m2) check('C: 측면 로봇 밀기 실행 (각 1회 이상)', m2.side.left.cycles > 0 && m2.side.right.cycles > 0, `왼쪽 ${m2.side.left.cycles} · 오른쪽 ${m2.side.right.cycles}`);
if (m2) check('C: 로봇 간 최소 거리 ≥ 여유거리 20 mm', m2.minMainSide >= TH.obstacleMarginMm, `${m2.minMainSide.toFixed(0)} mm`);
if (m2) console.log(`    참고: 모드 2 대형 박스 회수 ${m2.stats.bins.main} (대형 단독 ${base.stats.bins.main}), 작업 영역 남은 ${m2.stats.work} (단독 ${base.stats.work})`);

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
