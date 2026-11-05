// v1.1.1: v1.1.0 검토(REVIEW_v1.1.0.md)의 경미 이슈 수정 회귀 테스트 (Node에서 확인할 수 있는 항목)
//   m-2 구름 저항(각감쇠) / m-3 물리 모드 배치 편집 즉시 반영 / m-5 계획 단계 질량 확인 / m-9 파지 폭 공통 기준 / m-10 중력 변경
//   (m-4 로더 재시도, m-6 대기 시계, m-7 파지 중 배치 저장은 브라우저 동작 — REVIEW_v1.1.1.md 참고)
// 실행: node tests/minor-fixes.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const G = await imp('gripper.js');
const P = await imp('physics.js');
const PL = await imp('planner.js');
const TK = await imp('task.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const RAPIER = await loadRapier();
const PH = { densityKgM3: 500, massKg: null, friction: 0.6, restitution: 0.1 };

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

// m-2: 굴러가는 구·원기둥이 멈춘다 (v1.1.0: 30 s 뒤에도 13개가 움직이고 33 m까지 굴러감)
{
  const w = new P.PhysicsWorld(RAPIER);
  const obs = [];
  for (let i = 0; i < 50; i++) {
    const type = ['box', 'sphere', 'cylinder'][i % 3];
    const s = 60 + (i % 5) * 20;
    obs.push({ id: `o${i}`, type, pos: [(i % 10) * 250 - 1100, Math.floor(i / 10) * 250 - 500, 300 + (i % 7) * 120], size: [s, s, s * 1.2], rot: [i * 7, i * 13, 0], visible: true, physics: PH });
  }
  w.load(obs);
  // ① v1.1.0 재현 조건: 떨어뜨리기만 함 (v1.1.0: 30 s 뒤 13개가 움직이고 최대 33 m)
  let t = 0;
  while (w.awakeCount > 0 && t < 30 * 60) { w.step(); t++; }
  let far = 0;
  for (const p of w.poses().values()) far = Math.max(far, Math.hypot(p.pos[0], p.pos[1]));
  check('m-2: 물체 50개 낙하 → 모두 정지, 멀리 굴러가지 않음 (< 3 m)', w.awakeCount === 0 && far < 3000, `${(t / 60).toFixed(1)} s에 정지, 원점에서 최대 ${(far / 1000).toFixed(2)} m`);
  w.dispose();
  // ② 옆으로 1.5 m/s로 던져 굴리기
  const w2 = new P.PhysicsWorld(RAPIER);
  w2.load(obs);
  for (const { body } of w2.objects.values()) body.setLinvel({ x: 1.5, y: 0.5, z: 0 }, true);
  for (let i = 0; i < 30 * 60; i++) w2.step();
  check('m-2: 1.5 m/s로 던져 굴려도 30 s 안에 모두 정지 (구름 저항)', w2.awakeCount === 0, `움직이는 물체 ${w2.awakeCount}개`);
  w2.dispose();
}

// m-3: 물리 모드 배치 편집 → 물리 월드에 즉시 반영
{
  const w = new P.PhysicsWorld(RAPIER);
  const a = { id: 'a', type: 'box', pos: [500, 0, 50], size: [100, 100, 100], rot: [0, 0, 0], visible: true, physics: PH };
  const b = { id: 'b', type: 'sphere', pos: [-500, 0, 50], size: [100, 100, 100], rot: [0, 0, 0], visible: true, physics: PH };
  w.load([a, b]);
  for (let i = 0; i < 30; i++) w.step();
  let r = w.syncObjects([{ ...a, visible: false }, b]);
  check('m-3: 숨김 → 물리 바디 제거', r.removed.includes('a') && !w.objects.has('a'), JSON.stringify(r));
  r = w.syncObjects([a, b]);
  check('m-3: 다시 표시 → 배치 위치에 생성', r.added.includes('a') && Math.abs(w.poses().get('a').pos[0] - 500) < 1);
  const before = w.poses().get('b').pos.slice();
  r = w.syncObjects([a, { ...b, size: [200, 200, 200] }]);
  for (let i = 0; i < 60; i++) w.step();
  const pb = w.poses().get('b').pos;
  check('m-3: 크기 변경 → 현재 위치에서 새 형상으로 교체 (지름 200 구가 바닥 위 z ≈ 100)', r.replaced.includes('b') && Math.abs(pb[2] - 100) < 3 && Math.hypot(pb[0] - before[0], pb[1] - before[1]) < 5, `z ${pb[2].toFixed(1)}`);
  r = w.syncObjects([a]);
  check('m-3: 삭제 → 물리 바디 제거', r.removed.includes('b') && w.objects.size === 1);
  w.attach('a', K.poseMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]));
  w.syncObjects([{ ...a, size: [120, 100, 100] }]);
  check('m-3: 파지 중인 물체가 바뀌면 파지 해제', w.attached === null);
  w.dispose();
}

// m-10: 중력 변경이 바로 반영 (0 → 떠 있음, 1.62 → 천천히 낙하)
{
  const fall = (g) => {
    const w = new P.PhysicsWorld(RAPIER, { gravity: [0, 0, -9.81] });
    w.load([{ id: 'x', type: 'box', pos: [0, 0, 5000], size: [100, 100, 100], rot: [0, 0, 0], visible: true, physics: PH }]);
    w.setGravity([0, 0, -g]);
    for (let i = 0; i < 30; i++) w.step();
    const z = w.poses().get('x').pos[2];
    w.dispose();
    return 5000 - z;
  };
  const d0 = fall(0), dm = fall(1.62), de = fall(9.81);
  check('m-10: setGravity — 0 은 정지, 달(1.62)은 지구(9.81)의 약 1/6 낙하', d0 < 0.01 && Math.abs(dm / de - 1.62 / 9.81) < 0.02, `0.5 s 낙하 ${d0.toFixed(2)} / ${dm.toFixed(1)} / ${de.toFixed(1)} mm`);
}

// m-9: 파지 폭 판정 공통 기준 (수동 닫기 = Pick & Place)
{
  const robot = robots.find((r) => r.id === 'kuka-kr20-r1810');
  const spec = G.gripperSpec(robot); // 중형: 최대 벌림 120
  const T6 = K.poseMatrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [800, 0, 400]);
  const at = (w) => [{ id: 'o', type: 'box', size: [w, 30, 40], pos: [800, 0, 400 - spec.lengthMm + 20], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] }];
  const manual = [119, 120, 121].map((w) => !!G.findGraspCandidate(spec, T6, spec.maxOpenMm, at(w)));
  const tcp = K.multiply(T6, G.toolMatrix(spec.lengthMm));
  const task = [119, 120, 121].map((w) => !TK.graspPose(spec, { type: 'box', size: [w, 200, 40], pos: [800, 0, 20], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, 'top', tcp, 20).error);
  check('m-9: 최대 벌림 120 mm — 119·120 파지 가능, 121 거부 (수동 닫기)', manual.join() === 'true,true,false', manual.join());
  check('m-9: Pick & Place 파지점도 같은 기준', task.join() === manual.join(), task.join());
  const partly = !!G.findGraspCandidate(spec, T6, 80, at(81)) && !G.findGraspCandidate(spec, T6, 80, at(82));
  check('m-9: 일부 닫힌 손가락(80 mm)은 81 mm까지 (공차 1 mm)', partly);
}

// m-5: 무거운 물체는 Pick & Place 계획 단계에서 실패
{
  const robot = robots.find((r) => r.id === 'abb-irb1200-5-09');
  const spec = G.gripperSpec(robot);
  const ob = { id: 's', type: 'box', size: [30, 30, 60], pos: [500, -200, 30], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  let planned = 0;
  const res = await TK.planPickPlace({ robot, q0: K.homeJoints(robot), spec, graspDir: 'top', approachMm: 100, thresholds: TH, floor: true,
    object: ob, massKg: 12, placeT: K.poseMatrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [500, 200, 100]), obstacles: [{ ...ob, rot: [0, 0, 0] }] },
  { plan: (req) => (planned++, PL.planPath({ robot, thresholds: TH, floor: true, features: {}, timeoutMs: 3000, ...req })) });
  check('m-5: 질량 12 kg > 소형 그리퍼 5 kg → "파지점: 질량 초과", 경로 계획 전 실패', !res.ok && res.stage === '파지점' && /질량 초과/.test(res.message) && planned === 0, res.message);
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
