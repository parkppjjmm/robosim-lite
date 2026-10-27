// v1.1.0 2-B: Pick & Place — 장애물(벽) 너머로 물체를 옮기는 작업을 task.js로 계획하고,
// Rapier 물리 월드에서 실행을 재현해 운반 중 충돌 없음, 놓은 위치 오차를 검증한다 (소·중·대형 각 1종)
// 실행: node tests/pick-place.mjs  (Node 18+, Rapier는 tests/.cache/)
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
const TK = await imp('task.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const RAPIER = await loadRapier();

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};
const DT = 1 / 60;
const DOWN = [1, 0, 0, 0, -1, 0, 0, 0, -1];

/** 실행 재현: main.js의 루프(안전 검사 → 로봇 바디 → 파지 물체 추종 → 물리 스텝)와 같은 순서 */
function simulate(robot, spec, obstacles, result) {
  const w = new P.PhysicsWorld(RAPIER);
  w.load(obstacles);
  for (let i = 0; i < 30; i++) w.step(); // 안착
  const tool = { spec, opening: spec.maxOpenMm };
  const ctx = S.createSafetyContext(robot, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: TH, obstacles, floor: true, tool, physicsMode: true });
  const syncPoses = () => {
    const poses = w.poses();
    for (const ob of ctx.compiled) {
      const p = poses.get(ob.id);
      if (p) { ob.pos = p.pos; ob.R = p.R; }
    }
    return poses;
  };
  let q = result.vertices[0].q.slice();
  let worst = { count: 0, keys: new Set() };
  let lastObj = null, vel = [0, 0, 0];
  const physSegs = (e) => e.segments.filter((s) => s.link !== 9);
  let e = S.evaluatePose(ctx, q);
  w.setRobot(physSegs(e));
  const tick = () => {
    syncPoses();
    e = S.evaluatePose(ctx, q);
    if (e.violations.length) { worst.count++; e.violations.forEach((v) => worst.keys.add(v.key)); }
    w.moveRobot(physSegs(e));
    if (ctx.attached) {
      const T6 = e.frames[6];
      w.moveAttached(T6);
      const pos = K.origin(K.multiply(T6, ctx.attached.rel));
      if (lastObj) vel = pos.map((v, i) => (v - lastObj[i]) / DT);
      lastObj = pos;
      // 집을 때 맞닿아 있던 받침이 여유거리 밖으로 벗어나면 다시 검사 (main.js tickGripperPhysics와 같은 규칙)
      const seg = e.segments.find((s) => s.link === 9);
      ctx.attached.ignore = ctx.attached.ignore.filter((id) => (id === 'floor' ? Math.min(seg.a[2], seg.b[2]) - seg.r < TH.obstacleMarginMm : true));
    }
    w.step();
  };
  let objectMovedAbort = false;
  for (const st of result.steps.filter((s, i) => !(i === 0 && s.cmd === 'open'))) { // 시작 열기는 이미 열린 상태라 생략
    if (st.kind === 'move') {
      const tr = st.trajectory;
      for (let t = 0; t <= tr.duration + 1e-9; t += DT) { q = TR.sampleTrajectory(tr, t); tick(); }
      q = tr.points.at(-1).slice();
      tick();
    } else if (st.cmd === 'close') {
      const p = syncPoses().get(st.objectId);
      if (Math.hypot(...p.pos.map((v, i) => v - st.objectPos[i])) > TK.OBJECT_MOVED_TOLERANCE_MM) { objectMovedAbort = true; break; }
      const ob = obstacles.find((o) => o.id === st.objectId);
      const cand = G.findGraspCandidate(spec, e.frames[6], ctx.tool.opening, [{ id: ob.id, type: ob.type, size: ob.size, pos: p.pos, R: p.R }]);
      if (!cand) { worst.keys.add('grasp-miss'); break; }
      const rate = spec.maxOpenMm / spec.actuationS;
      while (ctx.tool.opening > cand.widthMm) { ctx.tool.opening = Math.max(cand.widthMm, ctx.tool.opening - rate * DT); tick(); }
      const rel = K.multiply(TK.invertRigid(e.frames[6]), K.poseMatrix(p.R, p.pos));
      const held = { id: ob.id, type: ob.type, size: ob.size, rel, ignore: [] };
      w.attach(ob.id, rel);
      S.setAttached(ctx, held);
      held.ignore = [...new Set(S.evaluatePose(ctx, q).obstacle.hits.filter((h) => h.link === 9).map((h) => h.obstacleId))];
      lastObj = null;
    } else {
      w.detach(vel);
      S.setAttached(ctx, null);
      ctx.releasedId = st.objectId;
      const rate = spec.maxOpenMm / spec.actuationS;
      while (ctx.tool.opening < spec.maxOpenMm) { ctx.tool.opening = Math.min(spec.maxOpenMm, ctx.tool.opening + rate * DT); tick(); }
    }
  }
  for (let i = 0; i < 120; i++) tick(); // 착지 대기
  const final = w.poses().get(result.steps.find((s) => s.cmd === 'close').objectId).pos.slice();
  w.dispose();
  return { violations: worst.count, keys: [...worst.keys], final, objectMovedAbort };
}

for (const id of ['abb-irb1200-5-09', 'kuka-kr20-r1810', 'fanuc-r2000ic-165f']) {
  const robot = robots.find((r) => r.id === id);
  const spec = G.gripperSpec(robot);
  const R = robot.reachMm;
  const side = Math.round(spec.maxOpenMm * 0.6);
  const h = Math.round(Math.max(side, spec.lengthMm * 0.6));
  // 집을 박스(y < 0), 벽(y = 0), 놓을 위치(y > 0)
  const box = { id: 'item', name: '부품', type: 'box', pos: [R * 0.6, -R * 0.35, h / 2], size: [side, side, h], rot: [0, 0, 20], visible: true, physics: { densityKgM3: 500, massKg: null, friction: 0.6, restitution: 0.1 } };
  const wall = { id: 'wall', name: '벽', type: 'box', pos: [R * 0.6, 0, R * 0.12], size: [R * 0.5, 40, R * 0.24], rot: [0, 0, 0], visible: true, physics: { densityKgM3: 5000, massKg: 1000, friction: 0.6, restitution: 0.1 } };
  const obstacles = [box, wall];
  const placeTcp = [R * 0.6, R * 0.35, h * 0.5];
  const q0 = K.homeJoints(robot);
  const object = { ...box, R: (await imp('collision.js')).rotationFromRPY(box.rot) };
  const t0 = performance.now();
  const res = await TK.planPickPlace(
    { robot, q0, spec, object, placeT: K.poseMatrix(DOWN, placeTcp), graspDir: 'top', approachMm: 100, obstacles, thresholds: TH, floor: true },
    { plan: (req) => PL.planPath({ robot, thresholds: TH, floor: true, features: {}, avoidSingularity: false, reference: q0, timeoutMs: 8000, ...req }) },
  );
  const ms = performance.now() - t0;
  console.log(`\n### ${robot.name} (${robot.sizeClass}) — 박스 ${side}×${side}×${h} mm, 벽 높이 ${(R * 0.24).toFixed(0)} mm`);
  check(`${robot.name}: Pick & Place 계획 성공`, res.ok, res.ok ? `${ms.toFixed(0)} ms, 경유점 ${res.vertices.length}개, 놓기점 보정 +${res.placeRaisedMm} mm` : res.message);
  if (!res.ok) continue;
  const sim = simulate(robot, spec, obstacles, res);
  check(`${robot.name}: 실행 중 안전 위반 없음 (운반 물체 포함)`, sim.violations === 0, sim.violations ? `${sim.violations} tick: ${sim.keys.join(', ')}` : '0 tick');
  const exp = res.expectedObjectPos;
  const xy = Math.hypot(sim.final[0] - exp[0], sim.final[1] - exp[1]);
  check(`${robot.name}: 놓은 위치 수평 오차 < 10 mm`, xy < 10, `기대 (${exp[0].toFixed(0)}, ${exp[1].toFixed(0)}) → 실제 (${sim.final[0].toFixed(0)}, ${sim.final[1].toFixed(0)}, z ${sim.final[2].toFixed(0)}), 오차 ${xy.toFixed(1)} mm`);
  check(`${robot.name}: 바닥에 안착 (z ≈ ${h / 2} mm)`, Math.abs(sim.final[2] - h / 2) < 3, `z ${sim.final[2].toFixed(1)} mm`);
}

// 실패 안내: 집을 수 없는 물체 / 도달 불가 놓기 위치
{
  const robot = robots.find((r) => r.id === 'abb-irb1200-5-09');
  const spec = G.gripperSpec(robot);
  const big = { id: 'big', type: 'box', size: [200, 200, 100], pos: [500, 0, 50], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const plan = (req) => PL.planPath({ robot, thresholds: TH, floor: true, features: {}, timeoutMs: 3000, ...req });
  const base = { robot, q0: K.homeJoints(robot), spec, graspDir: 'top', approachMm: 100, thresholds: TH, floor: true };
  const r1 = await TK.planPickPlace({ ...base, object: big, placeT: K.poseMatrix(DOWN, [500, 300, 100]), obstacles: [{ ...big, rot: [0, 0, 0] }] }, { plan });
  check('너무 큰 물체 → "파지점: 물체 폭 … 최대 벌림 폭" 안내', !r1.ok && r1.stage === '파지점', r1.message);
  const small = { id: 's', type: 'box', size: [30, 30, 60], pos: [500, 0, 30], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const r2 = await TK.planPickPlace({ ...base, object: small, placeT: K.poseMatrix(DOWN, [3000, 0, 100]), obstacles: [{ ...small, rot: [0, 0, 0] }] }, { plan });
  check('도달 불가 놓기 위치 → "놓기 접근점 이동: … Out of Reach" 안내', !r2.ok && r2.stage === '놓기 접근점 이동' && r2.reason === 'ik-failed', r2.message);
}

// 4-1 M-3: 닫힌 그리퍼로 시작해도 되도록 첫 단계는 '열기'
{
  const robot = robots.find((r) => r.id === 'abb-irb1200-5-09');
  const spec = G.gripperSpec(robot);
  const ob = { id: 's', type: 'box', size: [30, 30, 60], pos: [500, -200, 30], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const res = await TK.planPickPlace({ robot, q0: K.homeJoints(robot), spec, graspDir: 'top', approachMm: 100, thresholds: TH, floor: true,
    object: ob, placeT: K.poseMatrix(DOWN, [500, 200, 100]), obstacles: [{ ...ob, rot: [0, 0, 0] }] },
  { plan: (req) => PL.planPath({ robot, thresholds: TH, floor: true, features: {}, timeoutMs: 5000, ...req }) });
  check('Pick & Place 첫 단계 = 그리퍼 열기', res.ok && res.steps[0].kind === 'grip' && res.steps[0].cmd === 'open', res.ok ? res.steps.map((s) => s.label).join(' → ') : res.message);
}

// 저장 스키마: Waypoint 도착 동작 검증·기본값 (v1 데이터 = 동작 없음)
{
  globalThis.addEventListener ??= () => {}; // state.js는 브라우저 전역(pagehide)을 등록한다
  const ST = await imp('state.js');
  const ok = [
    [undefined, 'none'], [{ type: 'close' }, 'close'], [{ type: 'open' }, 'open'], [{ type: 'bogus' }, 'none'],
  ].every(([raw, t]) => ST.sanitizeAction(raw).type === t);
  const w = ST.sanitizeAction({ type: 'wait', sec: 999 });
  check('Waypoint 동작 검증: 없음/열기/닫기/대기, 모르는 값 → 없음, 대기 시간은 0.1~60 s로 제한', ok && w.type === 'wait' && w.sec === 60, JSON.stringify(w));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
// process.exit() 대신 exitCode: Windows Node 24에서 닫히는 중인 비동기 핸들과 겹치면 libuv assert로 비정상 종료될 수 있음
process.exitCode = fail ? 1 : 0;
