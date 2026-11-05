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
/**
 * main.js 루프와 같은 순서로 SIM_S초 실행.
 * 대형 로봇: 사이클을 반복(모드 1 측면이 있으면 레인 Y 제한, 모드 2 측면이 있으면 '포트 대기' 단계 + wantsPot)
 */
async function simulate(mainId, sidesIn, label) {
  const main = byId(mainId);
  const sides = {};
  for (const [slot, cfg] of Object.entries(sidesIn)) {
    sides[slot] = { ...cfg, binDist: cfg.mode === 1 ? D.sideBinDistFor(cfg.robotId) : undefined };
  }
  const fixtures = fixturesFor(sides);
  const w = new P.PhysicsWorld(RAPIER);
  w.setFixtures(fixtures);
  w.load([]);
  const field = new D.DrossField(w, { count: 160, seed: 11 });
  field.init();
  const spec = G.SKIMMER_SPEC;
  const ctx = S.createSafetyContext(main, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: TH, obstacles: fixtures, floor: true, tool: { spec, opening: 0 }, physicsMode: true });
  const physMain = (e) => [...e.segments.filter((s) => s.part !== 'plate'), ...G.skimmerBoxes(spec, e.frames[6])];
  let cur = S.evaluatePose(ctx, K.homeJoints(main));
  w.setRobot(physMain(cur));
  const coord = new C.CellCoordinator();
  for (const [slot, cfg] of Object.entries(sides)) {
    const cr = new C.CellRobot(slot, byId(cfg.robotId), cfg.mode, { thresholds: TH, obstaclesWorld: fixtures, binDist: cfg.binDist });
    coord.robots.set(slot, cr);
    w.setExtraRobot(slot, cr.physicsShapes());
  }
  for (let i = 0; i < 90; i++) { w.step(); field.tick(DT); }
  coord.start();
  const anyMode2 = [...coord.robots.values()].some((r) => r.mode === 2);
  const lanes = D.skimLanes(spec, TH.obstacleMarginMm, D.mainLaneRange(spec, sides));
  const out = { mainBlocked: 0, sideBlocked: 0, mainCycles: 0, minMainSide: Infinity, lockViolations: 0, holdS: 0, planFail: [] };
  let mainRun = null, lastLane = -1, mainPlanning = false, inPotPhase = false;
  const prof = { side: 0, main: 0, phys: 0, physMax: 0 };
  const _wall0 = performance.now();

  const startMain = async () => {
    mainPlanning = true;
    if (anyMode2) coord.main.wantsPot = true;
    const pick = D.chooseLane(lanes, w.particleState(), spec, lastLane);
    if (!pick || pick.count < 1) { mainPlanning = false; coord.main.wantsPot = false; return; }
    const res = await D.planSkimCycle({ robot: main, q0: cur.q.slice(), spec, lane: pick.lane, obstacles: fixtures, thresholds: TH, floor: true, cell: { corridor: coord.robots.size > 0 } },
      { plan: (req) => PL.planPath({ robot: main, thresholds: TH, floor: true, features: {}, avoidSingularity: false, reference: cur.q, timeoutMs: 8000, ...req }) });
    mainPlanning = false;
    if (!res.ok) { out.planFail.push(res.message); coord.main.wantsPot = false; return; }
    lastLane = pick.lane.index;
    const steps = res.steps.slice();
    const liftIdx = steps.findIndex((s) => s.label === '스쿱 상승');
    if (anyMode2) steps.unshift({ kind: 'action', type: 'until', label: '측면 로봇 퇴피 대기' });
    mainRun = { steps, i: 0, t: 0, liftIdx: liftIdx + (anyMode2 ? 1 : 0) };
  };

  for (let tick = 0; tick < SIM_S * 60; tick++) {
    // 브라우저의 프레임마다 양보와 같게: 측면 로봇의 비동기 계획이 끝날 수 있도록 이벤트 루프에 양보
    if (coord.planning.size) await new Promise((r) => setImmediate(r));
    // 측면 로봇
    const _t0 = performance.now();
    coord.tick(DT, {
      mainSegments: cur.segments, mainName: main.name, particles: () => w.particleState(), obstaclesWorld: () => fixtures, paused: false,
      onBlocked: (r, res) => { out.sideBlocked++; out.lastSideBlock = `${r.slot}: ${res.reason ?? res.blocked?.map((v) => v.key).join(',')}`; },
      onPlanFail: (r) => out.planFail.push(`${r.slot}: ${r.error}`),
    });
    const _t1 = performance.now();
    prof.side += _t1 - _t0;
    // 대형 로봇 (다른 로봇을 포함한 적용 전 검사)
    ctx.others = [...coord.robots.values()].map((r) => ({ id: r.slot, segments: r.worldSegments() }));
    if (!mainRun && !mainPlanning) await startMain();
    if (mainRun) {
      const st = mainRun.steps[mainRun.i];
      inPotPhase = mainRun.i <= mainRun.liftIdx && !(st.kind === 'action');
      if (!st) { mainRun = null; out.mainCycles++; }
      else if (st.kind === 'action') {
        if (st.type === 'until') { if (!coord.sideInPot()) mainRun.i++; }
        else { mainRun.t += DT; if (mainRun.t >= st.sec) { mainRun.i++; mainRun.t = 0; } }
      } else {
        const tN = Math.min(st.trajectory.duration, mainRun.t + DT);
        const r = S.sweepCheck(ctx, cur, TR.sampleTrajectory(st.trajectory, tN));
        if (!r.ok) { out.mainBlocked++; out.lastMainBlock = `${st.label}: ${r.blocked.map((v) => v.key).join(',')}`; mainRun = null; coord.main.wantsPot = false; break; } // 앱에서는 알람 → 여기서 멈춤
        else {
          cur = r.last;
          mainRun.t = tN;
          if (tN >= st.trajectory.duration - 1e-9) {
            if (mainRun.i === mainRun.liftIdx) coord.main.wantsPot = false; // 들어 올린 뒤엔 포트를 비워 줌
            mainRun.i++; mainRun.t = 0;
          }
        }
      }
      if (mainRun && mainRun.i >= mainRun.steps.length) { mainRun = null; out.mainCycles++; }
    }
    if (anyMode2 && inPotPhase && mainRun && [...coord.robots.values()].some((r) => r.mode === 2 && r.inPot)) out.lockViolations++;
    for (const r of coord.robots.values()) {
      out.minMainSide = Math.min(out.minMainSide, S.capsuleSetDistance(cur.segments, r.worldSegments()).d);
      if (r.status === 'holding') out.holdS += DT;
    }
    if (process.env.PROFILE && tick % 300 === 0) console.log('  t', tick / 60, 'wall', ((performance.now() - _wall0) / 1000).toFixed(1), 'prof', JSON.stringify(Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, Math.round(v)]))), 'particles', w.particles.length);
    if (process.env.DBG && tick % 1800 === 0) console.log('  t', tick / 60, 'inPot', coord.sideInPot(), [...coord.planning], [...coord.robots.values()].map((r) => r.status + ':' + r.mode), 'main', mainRun ? `${mainRun.i}/${mainRun.steps.length} ${mainRun.steps[mainRun.i]?.label}` : (mainPlanning ? 'planning' : 'idle'), 'wants', coord.main.wantsPot, [...coord.robots.values()].map((r) => `${r.slot}:${r.status}:${r.label}:${r.error ?? ''}`).join(' | '));
    const _t2 = performance.now();
    prof.main += _t2 - _t1;
    // 물리
    w.moveRobot(physMain(cur));
    for (const r of coord.robots.values()) w.moveExtraRobot(r.slot, r.physicsShapes());
    w.step();
    field.tick(DT);
    const _d = performance.now() - _t2;
    prof.phys += _d;
    prof.physMax = Math.max(prof.physMax, _d);
  }
  if (process.env.PROFILE) console.log('  prof ms total: side', prof.side.toFixed(0), 'main', prof.main.toFixed(0), 'phys', prof.phys.toFixed(0), 'physMax', prof.physMax.toFixed(1));
  const st = field.stats(D.drossBins(sides));
  out.stats = st;
  out.side = Object.fromEntries([...coord.robots.values()].map((r) => [r.slot, { name: r.robot.name, mode: r.mode, cycles: r.cycles, lanes: r.lanes.length, minOther: r.minOtherMm }]));
  w.dispose();
  const sideTxt = Object.entries(out.side).map(([k, v]) => `${k} ${v.name} 모드${v.mode} 작업 ${v.cycles}회(레인 ${v.lanes})`).join(' · ');
  console.log(`\n### ${label} — ${SIM_S} s`);
  console.log(`    대형 사이클 ${out.mainCycles}, 박스 ${JSON.stringify(st.bins)}, 작업 영역 남은 ${st.work}, 흘림 ${st.spilled}, ${sideTxt}`);
  console.log(`    대형↔측면 최소 거리 ${out.minMainSide.toFixed(0)} mm, 측면 간섭 대기 ${out.holdS.toFixed(1)} s, 계획 실패 ${out.planFail.length}${out.planFail.length ? ` (${out.planFail.slice(0, 2).join(' | ')})` : ''}`);
  return out;
}

const base = process.env.ONLY && process.env.ONLY !== 'A' ? { mainBlocked: 0, stats: { bins: { main: 1 }, bin: 0, work: 0 }, mainCycles: 0 } : await simulate('kuka-kr210-r2700', {}, 'A. 대형 로봇 단독 (KR 210)');
check('A: 대형 단독 — 안전 위반 0, 회수 > 0', base.mainBlocked === 0 && base.stats.bins.main > 0, `사이클 ${base.mainCycles}, 회수 ${base.stats.bins.main}`);

const m1 = process.env.ONLY && process.env.ONLY !== 'B' ? null : await simulate('kuka-kr210-r2700', { left: { robotId: 'ur-ur10e', mode: 1 }, right: { robotId: 'abb-irb1200-5-09', mode: 1 } }, 'B. 모드 1 — KR 210 + 왼쪽 UR10e + 오른쪽 IRB 1200 (각자 제거)');
check('B: 대형·측면 모두 안전 위반 0', m1.mainBlocked === 0 && m1.sideBlocked === 0, `대형 ${m1.mainBlocked} ${m1.lastMainBlock ?? ''} / 측면 ${m1.sideBlocked} ${m1.lastSideBlock ?? ''}`);
check('B: 로봇 간 최소 거리 ≥ 여유거리 20 mm', m1.minMainSide >= TH.obstacleMarginMm, `${m1.minMainSide.toFixed(0)} mm`);
check('B: 측면 로봇이 자기 박스에 회수 (왼쪽·오른쪽 각 1개 이상)', m1.stats.bins.left > 0 && m1.stats.bins.right > 0, JSON.stringify(m1.stats.bins));
// 처리량은 합격 기준이 아니라 측정값으로 남긴다 (모드 1은 대형 레인이 가운데로 줄고 측면 스쿱이 작아 120 s 합계가 단독보다 적을 수 있음 — REVIEW n-7)
console.log(`    측정: 모드 1 합계 회수 ${m1.stats.bin} (대형 ${m1.stats.bins.main} + 왼쪽 ${m1.stats.bins.left} + 오른쪽 ${m1.stats.bins.right}) vs 대형 단독 ${base.stats.bin}`);

const m2 = process.env.ONLY && process.env.ONLY !== 'C' ? null : await simulate('kuka-kr210-r2700', { left: { robotId: 'ur-ur10e', mode: 2 }, right: { robotId: 'ur-ur10e', mode: 2 } }, 'C. 모드 2 — KR 210 + 양쪽 UR10e (대형 쪽으로 밀기)');
check('C: 대형·측면 모두 안전 위반 0', m2.mainBlocked === 0 && m2.sideBlocked === 0, `대형 ${m2.mainBlocked} ${m2.lastMainBlock ?? ''} / 측면 ${m2.sideBlocked} ${m2.lastSideBlock ?? ''}`);
check('C: 포트 점유 잠금 위반 0 (대형이 포트 안일 때 측면 밀기 없음)', m2.lockViolations === 0, `${m2.lockViolations} tick`);
check('C: 측면 로봇 밀기 실행 (각 1회 이상)', m2.side.left.cycles > 0 && m2.side.right.cycles > 0, `왼쪽 ${m2.side.left.cycles} · 오른쪽 ${m2.side.right.cycles}`);
check('C: 로봇 간 최소 거리 ≥ 여유거리 20 mm', m2.minMainSide >= TH.obstacleMarginMm, `${m2.minMainSide.toFixed(0)} mm`);
console.log(`    참고: 모드 2 대형 박스 회수 ${m2.stats.bins.main} (대형 단독 ${base.stats.bins.main}), 작업 영역 남은 ${m2.stats.work} (단독 ${base.stats.work})`);

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
