// v1.1.0 2-A: 그리퍼 — 형상·파지 후보, 크기별 기본값·사용자 수정, TCP 오프셋(직선 보간·플래너 IK),
//             12개 모델 홈 자세 오탐 없음, 파지 물체 검사, 물리 파지 → 들기 → 이동 → 놓기, 질량
// 실행: node tests/gripper.mjs  (Node 18+, 물리 항목은 tests/.cache/의 Rapier 사용)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const G = await imp('gripper.js');
const S = await imp('safety.js');
const T = await imp('trajectory.js');
const PL = await imp('planner.js');
const P = await imp('physics.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const ALL = { selfCollision: true, obstacleCollision: true, singularity: true, autoPathPlanning: false };

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 1) 크기별 기본값 + 로봇별 사용자 수정 (범위 밖 값은 무시)
{
  const small = robots.find((r) => r.sizeClass === 'small');
  const large = robots.find((r) => r.sizeClass === 'large');
  check('크기별 기본값 (소형 100 mm / 대형 250 mm)', G.gripperSpec(small).lengthMm === 100 && G.gripperSpec(large).lengthMm === 250);
  const spec = G.gripperSpec(small, { [small.id]: { lengthMm: 180, maxOpenMm: 9999, bogus: 1 } });
  check('사용자 수정 적용, 범위 밖·모르는 키 무시', spec.lengthMm === 180 && spec.maxOpenMm === 60 && !('bogus' in spec), JSON.stringify(spec));
  check('다른 로봇의 수정값은 영향 없음', G.gripperSpec(large, { [small.id]: { lengthMm: 180 } }).lengthMm === 250);
}

// 2) 형상: 플랜지 = 원점, Z 위 방향일 때 몸체·손가락 캡슐 위치
const medium = G.GRIPPER_DEFAULTS.medium; // 길이 150, 벌림 120, 손가락 두께 15, 몸체 높이 60
const T6up = K.poseMatrix(I3, [0, 0, 0]);
{
  const segs = G.toolSegments(medium, T6up, 100);
  const [body, f1, f2] = segs;
  check('몸체 캡슐 = 링크 7, 손가락 = 링크 8 ×2', body.link === 7 && f1.link === 8 && f2.link === 8);
  check('손가락 중심 x = ±(벌림/2 + 두께/2) = ±57.5', Math.abs(f1.a[0] - 57.5) < 1e-9 && Math.abs(f2.a[0] + 57.5) < 1e-9);
  check('손가락 끝 + 반경 = TCP (z = 150)', Math.abs(f1.b[2] + f1.r - 150) < 1e-9);
  const tcp = K.origin(K.multiply(T6up, G.toolMatrix(150)));
  check('toolMatrix: TCP = 플랜지 + Z × 길이', dist3(tcp, [0, 0, 150]) < 1e-9);
  check('inverseToolMatrix ∘ toolMatrix = 단위행렬', K.multiply(G.toolMatrix(150), G.inverseToolMatrix(150)).every((v, i) => Math.abs(v - K.identity()[i]) < 1e-12));
}

// 3) 파지 후보: 손가락 사이 물체만, 폭이 벌림 이하, 회전한 박스는 투영 폭
{
  const ob = (id, pos, size, R = I3, type = 'box') => ({ id, type, size, pos, R });
  const cands = [ob('fits', [0, 0, 120], [80, 40, 40])];
  check('손가락 사이 80 mm 박스 → 후보', G.findGraspCandidate(medium, T6up, 120, cands)?.id === 'fits');
  check('벌림 70 mm에서는 80 mm 박스를 못 집음', G.findGraspCandidate(medium, T6up, 70, cands) === null);
  check('손가락 아래(끝보다 먼 곳) 물체는 후보 아님', G.findGraspCandidate(medium, T6up, 120, [ob('far', [0, 0, 300], [40, 40, 40])]) === null);
  check('옆(Y)으로 벗어난 물체는 후보 아님', G.findGraspCandidate(medium, T6up, 120, [ob('side', [0, 200, 120], [40, 40, 40])]) === null);
  const c = Math.SQRT1_2;
  const Rz45 = [c, -c, 0, c, c, 0, 0, 0, 1];
  const w = G.objectWidthAlong({ type: 'box', size: [60, 60, 40] }, Rz45, [1, 0, 0]);
  check('Z축 45° 회전한 60 mm 박스의 X 방향 폭 = 84.9 mm', Math.abs(w - 60 * Math.SQRT2) < 1e-6, w.toFixed(2));
  const cyl = G.objectWidthAlong({ type: 'cylinder', size: [50, 50, 200] }, I3, [1, 0, 0]);
  check('세운 원기둥의 가로 폭 = 지름', Math.abs(cyl - 50) < 1e-9);
}

// 4) 12개 모델: 그리퍼(크기별 기본값)를 달아도 홈 자세에서 자기 충돌·장애물 오탐 없음
{
  const bad = [];
  for (const robot of robots) {
    const spec = G.gripperSpec(robot);
    const ctx = S.createSafetyContext(robot, { features: ALL, thresholds: TH, obstacles: [], floor: true, tool: { spec, opening: spec.maxOpenMm } });
    const e = S.evaluatePose(ctx, K.homeJoints(robot));
    const v = e.violations.filter((x) => x.type !== 'SINGULARITY');
    if (v.length) bad.push(`${robot.id}: ${v.map((x) => x.key).join(',')}`);
  }
  check('12개 모델 홈 자세 + 그리퍼 → 충돌 오탐 0건', bad.length === 0, bad.join(' / '));
}

// 5) 그리퍼 접힘 감지: 손목을 크게 꺾어 그리퍼가 전완에 닿으면 Self 감지 (전완 끝 트림 후에도 유지)
{
  let detected = 0, total = 0;
  for (const robot of robots) {
    const spec = { ...G.gripperSpec(robot), lengthMm: 400 };
    const ctx = S.createSafetyContext(robot, { features: { selfCollision: true }, thresholds: TH, obstacles: [], floor: false, tool: { spec, opening: spec.maxOpenMm } });
    const q = K.homeJoints(robot);
    const [lo, hi] = robot.jointLimitsDeg[4];
    let hit = false;
    for (const j5 of [hi, lo]) {
      q[4] = j5;
      if (S.evaluatePose(ctx, q).self.pairs.some(([a, b]) => a === 4 && b >= 7)) hit = true;
    }
    total++;
    if (hit) detected++;
  }
  // J5 한계가 좁은 모델은 구조적으로 닿지 않으므로 전부일 필요는 없다 — 검사 쌍이 있고 실제로 감지되는지 확인
  const pairsOk = robots.every((robot) => {
    const spec = G.gripperSpec(robot);
    const ctx = S.createSafetyContext(robot, { features: { selfCollision: true }, thresholds: TH, obstacles: [], floor: false, tool: { spec, opening: spec.maxOpenMm } });
    const segs = S.robotSegments(ctx, K.forwardKinematics(robot, K.homeJoints(robot)).frames);
    const links = ctx.selfPairs.map((p) => [segs[p.i].link, segs[p.j].link].sort((a, b) => a - b).join('-'));
    return links.includes('4-7') && links.includes('4-8') && !links.some((l) => l.endsWith('-9'));
  });
  check('전완-그리퍼(4-7, 4-8) 자기 충돌 검사 쌍 존재, 파지 물체(9)는 제외', pairsOk);
  check('긴 그리퍼(400 mm) + J5 한계 → 전완-그리퍼 Self 감지', detected >= 1, `${detected}/${total}개 모델 (나머지는 J5 한계 안에서 닿지 않음)`);
}

// 6) TCP 오프셋: 직선 보간이 TCP(손가락 끝)를 직선으로 움직이고, 목표 TCP에 도달
{
  let worstEnd = 0, worstLine = 0, ok = true;
  for (const robot of robots) {
    const L = G.gripperSpec(robot).lengthMm;
    const q0 = K.homeJoints(robot);
    const tcp0 = K.multiply(K.forwardKinematics(robot, q0).frames[6], G.toolMatrix(L));
    const p0 = K.origin(tcp0);
    const target = K.poseMatrix(K.rotationOf(tcp0), [p0[0] - 100, p0[1] + 80, p0[2] - 120]);
    const res = T.linearMove(robot, q0, target, { toolLengthMm: L });
    if (!res.ok) { ok = false; continue; }
    const tcpOf = (q) => K.origin(K.multiply(K.forwardKinematics(robot, q).frames[6], G.toolMatrix(L)));
    worstEnd = Math.max(worstEnd, dist3(tcpOf(res.trajectory.points.at(-1)), K.origin(target)));
    // 중간 샘플이 시작-목표 직선 위에 있는지
    const a = p0, b = K.origin(target), ab = b.map((v, i) => v - a[i]), L2 = ab.reduce((s, v) => s + v * v, 0);
    for (const q of res.trajectory.points) {
      const p = tcpOf(q);
      const t = Math.max(0, Math.min(1, p.reduce((s, v, i) => s + (v - a[i]) * ab[i], 0) / L2));
      worstLine = Math.max(worstLine, dist3(p, a.map((v, i) => v + ab[i] * t)));
    }
  }
  check('직선 보간(TCP 기준): 12개 모델 모두 성공', ok);
  check('직선 보간 끝 TCP 오차 < 0.5 mm', worstEnd < 0.5, `${worstEnd.toFixed(3)} mm`);
  check('직선 보간 TCP가 직선에서 벗어난 최대 거리 < 1 mm', worstLine < 1, `${worstLine.toFixed(3)} mm`);
}

// 7) 플래너: TCP 목표(손가락 끝)를 플랜지 목표로 바꿔 IK → 끝 자세의 TCP가 목표와 일치
{
  const robot = robots.find((r) => r.sizeClass === 'medium');
  const spec = G.gripperSpec(robot);
  const qGoal = K.homeJoints(robot).map((v, i) => v + [25, -10, 10, 0, -15, 0][i]);
  const goalT = K.multiply(K.forwardKinematics(robot, qGoal).frames[6], G.toolMatrix(spec.lengthMm));
  const res = await PL.planPath({
    robot, obstacles: [], thresholds: TH, floor: true, features: ALL, avoidSingularity: false,
    start: K.homeJoints(robot), goal: { type: 'pose', pos: K.origin(goalT), rpy: K.rotationToRPY(goalT) },
    tool: { spec, opening: spec.maxOpenMm }, timeoutMs: 5000,
  });
  const qEnd = res.ok ? res.path.at(-1) : null;
  const err = qEnd ? dist3(K.origin(K.multiply(K.forwardKinematics(robot, qEnd).frames[6], G.toolMatrix(spec.lengthMm))), K.origin(goalT)) : Infinity;
  check('플래너 TCP 목표 + 그리퍼 → 끝 자세 TCP 오차 < 0.5 mm', err < 0.5, res.ok ? `${err.toFixed(3)} mm` : res.message);
}

// 8) 파지한 물체(링크 9): 다른 물체·바닥과 검사, 집을 때 맞닿아 있던 대상은 ignore로 제외
{
  const robot = robots.find((r) => r.sizeClass === 'medium');
  const spec = G.gripperSpec(robot);
  const q = K.homeJoints(robot);
  const T6 = K.forwardKinematics(robot, q).frames[6];
  const objPos = K.origin(K.multiply(T6, G.toolMatrix(spec.lengthMm - 30)));
  const wall = { id: 'wall', type: 'box', pos: [objPos[0], objPos[1], objPos[2] - 90], size: [400, 400, 40], rot: [0, 0, 0], visible: true };
  const ctx = S.createSafetyContext(robot, { features: ALL, thresholds: TH, obstacles: [wall], floor: true, tool: { spec, opening: 60 }, physicsMode: true });
  const before = S.evaluatePose(ctx, q).violations.filter((v) => v.type === 'OBSTACLE').length;
  const rel = K.poseMatrix(I3, [0, 0, spec.lengthMm - 30]);
  S.setAttached(ctx, { id: 'held', type: 'box', size: [60, 60, 100], rel, ignore: [] });
  const hits = S.evaluatePose(ctx, q).obstacle.hits.filter((h) => h.link === 9);
  check('파지 물체(링크 9)가 아래 물체와의 근접을 감지', before === 0 && hits.some((h) => h.obstacleId === 'wall'), `${hits.map((h) => h.obstacleId)}`);
  ctx.attached.ignore = ['wall'];
  check('ignore에 넣은 대상은 파지 물체 검사에서 제외', !S.evaluatePose(ctx, q).obstacle.hits.some((h) => h.link === 9));
  const lev0 = S.leverBounds(robot, spec), lev1 = ctx.levers;
  check('파지 중 레버암 상한 증가 (세분 검사 간격 보수화)', lev1[0] > lev0[0], `${lev0[0].toFixed(0)} → ${lev1[0].toFixed(0)} mm`);
}

// 9) 물리: 파지 → 들기 → 이동 → 놓기 → 착지, 질량
{
  const RAPIER = await loadRapier();
  const w = new P.PhysicsWorld(RAPIER);
  w.load([
    { id: 'b', type: 'box', pos: [800, 0, 50], size: [80, 80, 100], rot: [0, 0, 0], visible: true },
    { id: 'heavy', type: 'box', pos: [-800, 0, 50], size: [100, 100, 100], rot: [0, 0, 0], visible: true, physics: { massKg: 30 } },
  ]);
  for (let i = 0; i < 60; i++) w.step();
  check('질량: massKg 지정값 반환 (30 kg > 중형 한계 20 kg)', Math.abs(w.mass('heavy') - 30) < 1e-3 && w.mass('heavy') > medium.maxPayloadKg, `${w.mass('heavy').toFixed(3)} kg`);
  // 플랜지가 물체 위에서 아래를 향함 (Z축 = −Z 월드): Rx 180°
  const Rdown = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const flange = (x, y, z) => K.poseMatrix(Rdown, [x, y, z]);
  const pb = w.poses().get('b');
  let T6 = flange(800, 0, pb.pos[2] + 150 - 20);
  const inv = (M) => { const Rt = K.transpose3(K.rotationOf(M)), o = K.origin(M); return K.poseMatrix(Rt, [0, 1, 2].map((r) => -(Rt[r * 3] * o[0] + Rt[r * 3 + 1] * o[1] + Rt[r * 3 + 2] * o[2]))); };
  const rel = K.multiply(inv(T6), K.poseMatrix(pb.R, pb.pos));
  check('attach 성공', w.attach('b', rel));
  // 들기 300 mm (1 s) → 수평 이동 400 mm (1 s)
  const path = [];
  for (let i = 1; i <= 60; i++) path.push([800, 0, pb.pos[2] + 130 + 5 * i]);
  for (let i = 1; i <= 60; i++) path.push([800 - (400 * i) / 60, 0, pb.pos[2] + 430]);
  let maxErr = 0, prev = null, vel = [0, 0, 0];
  for (const p of path) {
    T6 = flange(...p);
    w.moveAttached(T6);
    w.step();
    const want = K.origin(K.multiply(T6, rel));
    const got = w.poses().get('b').pos;
    maxErr = Math.max(maxErr, dist3(want, got));
    if (prev) vel = got.map((v, i) => (v - prev[i]) * 60);
    prev = got.slice();
  }
  check('파지 중 물체가 그리퍼를 따라감 (오차 < 0.5 mm)', maxErr < 0.5, `${maxErr.toFixed(4)} mm`);
  w.detach(vel);
  for (let i = 0; i < 240; i++) w.step();
  const end = w.poses().get('b');
  check('놓은 물체가 바닥에 착지 (z ≈ 50 mm)', Math.abs(end.pos[2] - 50) < 3, `z ${end.pos[2].toFixed(1)} mm`);
  // 400 mm/s로 −X 이동 중 놓음 → 300 mm 낙하(약 0.25 s) 동안 약 100 mm 더 감 → x ≈ 300 mm
  const fallS = Math.sqrt((2 * 0.3) / 9.81);
  const expectX = 400 - 400 * fallS;
  check('착지 위치 = 놓을 때 속도를 이어받은 포물선 (x ≈ 301 mm)', Math.abs(end.pos[0] - expectX) < 40, `x ${end.pos[0].toFixed(0)} mm (기대 ${expectX.toFixed(0)})`);
  check('놓은 뒤 동적 바디로 복귀', w.objects.get('b').body.isDynamic() && w.attached === null);
  w.dispose();
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
