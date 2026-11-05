// v1.1.1: 드로스 제거 작업 셀 — 부력(떠 있음), 스키머 툴 안전 모델, 스키밍 사이클 계획·물리 실행 재현(드로스 회수),
// 결정성, 저장 설정 검증. 대형 로봇 4종(도달거리 2.6 m 이상)에서 확인한다.
// 실행: node tests/dross.mjs  (Node 18+, Rapier는 tests/.cache/)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const G = await imp('gripper.js');
const S = await imp('safety.js');
const TR = await imp('trajectory.js');
const PL = await imp('planner.js');
const P = await imp('physics.js');
const D = await imp('dross.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const RAPIER = await loadRapier();
const DT = 1 / 60;
const quick = !process.argv.includes('--all');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

/** 셀 물리 월드: 설비 → 로봇 → 드로스 (main.js와 같은 순서) */
function makeWorld(cfg) {
  const w = new P.PhysicsWorld(RAPIER);
  w.setFixtures(D.drossFixtures());
  w.load([]);
  const field = new D.DrossField(w, cfg);
  field.init();
  return { w, field };
}

// ---- 1. 부력: 드로스가 욕면에 떠서 멈춘다 ----
{
  const { w, field } = makeWorld({ count: 60, seed: 3 });
  for (let i = 0; i < 240; i++) { w.step(); field.tick(DT); }
  const st = field.stats();
  const { n, buf } = w.particleState();
  let maxDev = 0;
  for (let i = 0; i < n; i++) maxDev = Math.max(maxDev, Math.abs(buf[i * 4 + 2] - D.BATH_Z_MM));
  // 정지 여부는 1 s 동안의 이동량으로 본다 (스텝 직후 linvel은 부력 충격량과 중력이 번갈아 반영된 값이라 실제 이동과 다름)
  const before = Array.from(buf.slice(0, n * 4));
  for (let i = 0; i < 60; i++) w.step();
  const after = w.particleState().buf;
  let maxV = 0;
  for (let i = 0; i < n; i++) maxV = Math.max(maxV, Math.hypot(after[i * 4] - before[i * 4], after[i * 4 + 1] - before[i * 4 + 1], after[i * 4 + 2] - before[i * 4 + 2]));
  check('부력: 4 s 뒤 모든 드로스가 욕면에 떠 있음 (중심 높이 = 욕면 ± 반지름)', st.work + st.far === st.total && maxDev < 45, `작업 영역 ${st.work}, 스나우트 너머 ${st.far}, 중심-욕면 최대 ${maxDev.toFixed(1)} mm`);
  check('부력: 점성 저항으로 거의 정지 (1 s 이동 < 10 mm)', maxV < 10, `최대 ${maxV.toFixed(2)} mm/s`);
  check('스나우트가 두 영역을 나눔 (작업 영역 60개, 너머 30개 근처)', st.work >= 55 && st.far >= 25, `${st.work} / ${st.far}`);
  w.dispose();
}

// ---- 2. 결정성: 같은 시드 → 같은 배치·결과 ----
{
  const run = () => {
    const { w, field } = makeWorld({ count: 80, seed: 7, ratePerMin: 60 });
    for (let i = 0; i < 300; i++) { w.step(); field.tick(DT); }
    const { n, buf } = w.particleState();
    const out = Array.from(buf.slice(0, n * 4));
    w.dispose();
    return out;
  };
  const a = run(), b = run();
  const diff = a.length === b.length ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity;
  check('결정성: 같은 시드·발생률로 5 s 2회 → 입자 위치 동일', diff === 0, `입자 ${a.length / 4}개, 최대 차이 ${diff}`);
}

// ---- 3. 스키머 안전 모델 ----
{
  const spec = D.SKIMMER_SPEC ?? G.SKIMMER_SPEC;
  const T6 = K.poseMatrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [2000, 0, 1400]); // 툴 Z 아래
  const segs = G.toolSegments(spec, T6, 0);
  const lowest = Math.min(...segs.map((s) => Math.min(s.a[2], s.b[2]) - s.r));
  const plateBottom = 1400 - spec.lengthMm - spec.plateThickMm;
  const lipTop = 1400 - spec.lengthMm + spec.lipMm;
  const highestPlate = Math.max(...segs.filter((s) => s.part === 'plate').map((s) => Math.max(s.a[2], s.b[2]) + s.r));
  const ys = segs.filter((s) => s.part === 'plate').flatMap((s) => [s.a[1] - s.r, s.a[1] + s.r]);
  check('스키머 캡슐이 바닥판 아랫면·턱 끝·판 폭을 덮음 (보수적)', lowest <= plateBottom && highestPlate >= lipTop && Math.min(...ys) <= -spec.plateYMm / 2 && Math.max(...ys) >= spec.plateYMm / 2,
    `캡슐 z ${lowest.toFixed(0)}~${highestPlate.toFixed(0)} (판 ${plateBottom}~턱 ${lipTop}), y ${Math.min(...ys)}~${Math.max(...ys)}`);
  const boxes = G.skimmerBoxes(spec, T6);
  check('스쿱 물리 형상 = 박스 4개 (바닥판·뒤 턱·좌우 턱)', boxes.length === 4 && boxes.every((b) => b.box.half.length === 3));
  check('레버암 상한에 스쿱 대각선 포함', G.toolExtentMm(spec) > spec.lengthMm + 250, `${G.toolExtentMm(spec).toFixed(0)} mm`);
}

// ---- 4. 스키밍 사이클: 계획 → 물리 실행 재현 → 드로스 회수 ----
function simulateCycle(robot, spec, field, w, res) {
  const obstacles = D.drossFixtures();
  const ctx = S.createSafetyContext(robot, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: TH, obstacles, floor: true, tool: { spec, opening: 0 }, physicsMode: true });
  const physSegs = (e) => [...e.segments.filter((s) => s.part !== 'plate' && s.link !== 9), ...G.skimmerBoxes(spec, e.frames[6])];
  let q = res.vertices[0].q.slice();
  let e = S.evaluatePose(ctx, q);
  w.setRobot(physSegs(e));
  let violations = 0;
  const keys = new Set();
  let t = 0;
  const tick = () => {
    e = S.evaluatePose(ctx, q);
    if (e.violations.length) { violations++; e.violations.forEach((v) => keys.add(v.key)); }
    w.moveRobot(physSegs(e));
    w.step();
    field.tick(DT);
    t += DT;
  };
  for (const st of res.steps) {
    if (st.kind === 'move') {
      const tr = st.trajectory;
      for (let s = 0; s <= tr.duration + 1e-9; s += DT) { q = TR.sampleTrajectory(tr, s); tick(); }
      q = tr.points.at(-1).slice();
      tick();
    } else {
      for (let s = 0; s < st.sec; s += DT) tick();
    }
  }
  for (let i = 0; i < 90; i++) tick(); // 떨어지는 드로스가 박스에 안착할 때까지
  return { violations, keys: [...keys], timeS: t };
}

const large = robots.filter((r) => D.drossRobotOk(r));
check('대형 로봇만 드로스 셀 사용 (도달거리 ≥ 2.4 m)', large.length === 4 && large.every((r) => r.sizeClass === 'large'), large.map((r) => r.name).join(', '));
const spec = G.SKIMMER_SPEC;
for (const robot of quick ? large.slice(0, 4) : large) {
  const { w, field } = makeWorld({ count: 120, seed: 11 });
  for (let i = 0; i < 120; i++) { w.step(); field.tick(DT); }
  const before = field.stats();
  const lanes = D.skimLanes(spec, TH.obstacleMarginMm);
  const pick = D.chooseLane(lanes, w.particleState(), spec);
  const q0 = K.homeJoints(robot);
  const t0 = performance.now();
  const res = await D.planSkimCycle(
    { robot, q0, spec, lane: pick.lane, immersionMm: 60, sweepMmS: 120, obstacles: D.drossFixtures(), thresholds: TH, floor: true },
    { plan: (req) => PL.planPath({ robot, thresholds: TH, floor: true, features: {}, avoidSingularity: false, reference: q0, timeoutMs: 8000, ...req }) },
  );
  const ms = performance.now() - t0;
  console.log(`\n### ${robot.name} — 레인 ${lanes.length}개 중 ${pick.lane.index}번 (y ${pick.lane.y.toFixed(0)}, 드로스 ${pick.count}개)`);
  check(`${robot.name}: 스키밍 사이클 계획 성공`, res.ok, res.ok ? `${ms.toFixed(0)} ms, 구간 ${res.steps.length}개, 예상 ${res.duration.toFixed(1)} s · ${res.steps.map((s) => s.label).join(' → ')}` : res.message);
  if (!res.ok) { w.dispose(); continue; }
  const sim = simulateCycle(robot, spec, field, w, res);
  const after = field.stats();
  check(`${robot.name}: 실행 중 안전 위반 없음 (포트 벽·스나우트·드로스 박스)`, sim.violations === 0, sim.violations ? `${sim.violations} tick: ${sim.keys.join(', ')}` : `0 tick, 사이클 ${sim.timeS.toFixed(1)} s`);
  check(`${robot.name}: 드로스 회수 (박스에 1개 이상)`, after.bin >= 1, `작업 영역 ${before.work} → ${after.work}, 박스 ${after.bin}개 (${after.binKg.toFixed(1)} kg), 흘림 ${after.spilled}, 운반 중 ${after.carried}`);
  w.dispose();
}

// ---- 5. 저장 설정 검증 ----
{
  const a = D.sanitizeDross({ enabled: true, count: 9999, ratePerMin: 30, seed: 2.6, immersionMm: 'x' });
  check('설정 검증: 범위 밖·형식 오류는 기본값, 시드는 정수', a.enabled && a.count === D.DROSS_DEFAULTS.count && a.ratePerMin === 30 && a.seed === 3 && a.immersionMm === D.DROSS_DEFAULTS.immersionMm, JSON.stringify(a));
  check('설정 없음 → 꺼짐 + 기본값, 측면 로봇 없음', JSON.stringify(D.sanitizeDross(undefined)) === JSON.stringify({ ...D.DROSS_DEFAULTS, sides: D.SIDE_DEFAULTS }));
  const sd = D.sanitizeDross({ sides: { left: { robotId: 'ur-ur10e', mode: 2 }, right: { robotId: 'nope', mode: 7 } } }, (id) => id === 'ur-ur10e');
  check('측면 로봇 설정 검증: 알 수 없는 로봇·모드는 기본값', sd.sides.left.robotId === 'ur-ur10e' && sd.sides.left.mode === 2 && sd.sides.right.robotId === null && sd.sides.right.mode === 1, JSON.stringify(sd.sides));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
