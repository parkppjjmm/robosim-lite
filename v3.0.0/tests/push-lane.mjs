// v3.0.0 (2026-11-06): 측면 로봇 모드 3(동시 밀기)·대형 쓸기 방향(스나우트 쪽)·운동학 바디 회전 부호 연속성 검증
// 실행: node tests/push-lane.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const D = await imp('dross.js');
const G = await imp('gripper.js');
const K = await imp('kinematics.js');
const P = await imp('physics.js');
const TE = await imp('task-eval.js');
const CR = await imp('cell-robot.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const kr210 = robots.find((r) => r.id === 'kuka-kr210-r2700');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

// ---- 1. 작업 설정 ----
{
  const { task, errors } = TE.sanitizeTask({ cell: { left: { robotId: 'ur-ur10e', mode: 3 }, right: { robotId: 'ur-ur10e', mode: 3 } }, mainRule: { laneDir: 'snout' } }, robots);
  check('설정: 측면 모드 3·쓸기 방향 snout 허용', !errors.length && task.cell.left.mode === 3 && task.mainRule.laneDir === 'snout', JSON.stringify(task.mainRule));
  const bad = TE.sanitizeTask({ mainRule: { laneDir: 'xx' }, cell: { left: { robotId: 'ur-ur10e', mode: 7 } } }, robots).task;
  check('설정: 모르는 방향은 robot, 모르는 모드는 1', bad.mainRule.laneDir === 'robot' && bad.cell.left.mode === 1);
}

// ---- 2. 모드 3 구역 분리 ----
{
  const sides = { left: { robotId: 'ur-ur10e', mode: 3 }, right: { robotId: 'ur-ur10e', mode: 3 } };
  const r = D.mainLaneRange(G.SKIMMER_SPEC, sides);
  check('모드 3: 대형 스쿱 중심 |Y| ≤ PUSH_ASSIST.mainCenterMaxMm', r.yHi === D.PUSH_ASSIST.mainCenterMaxMm && r.yLo === -D.PUSH_ASSIST.mainCenterMaxMm, JSON.stringify(r));
  check('모드 2: 대형 구역 제한 없음(기존과 같음)', D.mainLaneRange(G.SKIMMER_SPEC, { left: { robotId: 'ur-ur10e', mode: 2 } }).yHi === Infinity);
  const fx = D.drossFixtures(sides);
  const cr = new CR.CellRobot('left', robots.find((x) => x.id === 'ur-ur10e'), 3, { thresholds: TE.TASK_THRESHOLDS, obstaclesWorld: fx });
  const ends = cr.lanes.map((l) => Math.abs(l.endW[1]));
  check('모드 3: 측면 밀기 레인이 대형 구역 경계 근처(pushToMm)까지', cr.lanes.length > 0 && ends.every((y) => y >= D.PUSH_ASSIST.pushToMm - 1 && y < 520), `레인 ${cr.lanes.length}, 끝 |y| ${ends.join(',')}`);
  const co = new CR.CellCoordinator();
  co.robots.set('left', cr);
  cr.status = 'running';
  check('모드 3: 포트 점유 잠금 없음 (sideInPot = false)', co.sideInPot() === false);
}

// ---- 3. 스나우트 쪽 쓸기 사이클 ----
{
  const lanes = D.skimLanes(G.SKIMMER_SPEC, TE.TASK_THRESHOLDS.obstacleMarginMm, {});
  const L = lanes[2];
  const res = await D.planSkimCycle({ robot: kr210, q0: K.homeJoints(kr210), spec: G.SKIMMER_SPEC, lane: { ...L, start: [L.xe, L.y], end: [L.xs, L.y] }, obstacles: D.drossFixtures({}), thresholds: TE.TASK_THRESHOLDS, floor: true }, { plan: null });
  const labels = res.ok ? res.steps.map((s) => s.label) : [];
  check('스나우트 쪽 쓸기: 계획 성공 + 담은 채 물러나기·돌리기 단계', res.ok && labels.includes('담은 채 물러나기') && labels.includes('담은 채 돌리기'), res.ok ? labels.join(' → ') : res.message);
  const turn = res.ok ? res.steps.find((s) => s.label === '담은 채 돌리기').trajectory : null;
  let v6 = 0;
  if (turn) for (let k = 1; k < turn.points.length; k++) v6 = Math.max(v6, Math.abs(turn.points[k][5] - turn.points[k - 1][5]) / Math.max(1e-6, turn.times[k] - turn.times[k - 1]));
  check('돌리기 J6 속도 ≤ 40°/s (튕김 방지)', turn && v6 <= 40, `${v6.toFixed(1)}°/s`);
  const fwd = await D.planSkimCycle({ robot: kr210, q0: K.homeJoints(kr210), spec: G.SKIMMER_SPEC, lane: L, obstacles: D.drossFixtures({}), thresholds: TE.TASK_THRESHOLDS, floor: true }, { plan: null });
  check('로봇 쪽 쓸기(기존)에는 돌리기 단계 없음 (v1.1.2와 같음)', fwd.ok && !fwd.steps.some((s) => s.label === '담은 채 돌리기'));
}

// ---- 4. 회전 부호 연속성 ----
{
  const RAPIER = await loadRapier();
  const w = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setRotation({ x: 0, y: 0, z: 0.6, w: 0.8 }));
  const q = P.continuousRot(b, { x: -0, y: -0, z: -0.62, w: -0.78 });
  check('운동학 회전: 직전과 반대 부호 쿼터니언은 뒤집어 넘김 (한 스텝 360° 회전 방지)', q.w > 0 && q.z > 0, JSON.stringify(q));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
