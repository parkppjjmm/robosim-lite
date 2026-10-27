// v1.1.0 1단계: 물리엔진 — 낙하·안착, 적층 안정, 결정성, 범위 이탈, 배치 저장 변환, 저장 스키마 v1→v2
// 실행: node tests/physics.mjs  (Node 18+, 첫 실행 시 Rapier를 CDN에서 받아 tests/.cache/에 저장)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier, RAPIER_VERSION } from './lib/rapier.mjs';

// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const P = await imp('physics.js');
const C = await imp('collision.js');
const RAPIER = await loadRapier();
console.log(`Rapier ${RAPIER.version()} (요청 ${RAPIER_VERSION})`);

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};
const run = (obstacles, seconds) => {
  const w = new P.PhysicsWorld(RAPIER);
  w.load(obstacles);
  const t0 = performance.now();
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) w.step();
  const ms = (performance.now() - t0) / n;
  const poses = w.poses();
  return { w, poses, ms };
};
const box = (id, pos, size = [100, 100, 100], extra = {}) => ({ id, name: id, type: 'box', pos, size, rot: [0, 0, 0], visible: true, ...extra });

// 1) 낙하·안착: 박스/구/원기둥이 공중(Z=500)에서 떨어져 바닥에 안착 → 중심 높이 = 반 높이
{
  const obs = [
    box('b', [0, 0, 500], [100, 100, 100]),
    { id: 's', type: 'sphere', pos: [400, 0, 500], size: [120, 120, 120], rot: [0, 0, 0], visible: true },
    { id: 'c', type: 'cylinder', pos: [-400, 0, 500], size: [80, 80, 200], rot: [0, 0, 0], visible: true },
  ];
  const { poses } = run(obs, 4);
  const z = (id) => poses.get(id).pos[2];
  check('박스 낙하·안착 (기대 50 mm)', Math.abs(z('b') - 50) < 2, `${z('b').toFixed(2)} mm`);
  check('구 낙하·안착 (기대 60 mm)', Math.abs(z('s') - 60) < 2, `${z('s').toFixed(2)} mm`);
  check('원기둥 낙하·안착, 축 Z 유지 (기대 100 mm)', Math.abs(z('c') - 100) < 2, `${z('c').toFixed(2)} mm`);
  const R = poses.get('c').R;
  check('원기둥이 서 있음 (로컬 Z축 ≈ 월드 Z)', R[8] > 0.99, `R22=${R[8].toFixed(4)}`);
}

// 2) 적층 안정: 박스 3개를 쌓아 두고 5초 → 무너지지 않음
{
  const obs = [box('b1', [0, 0, 50]), box('b2', [0, 0, 150]), box('b3', [0, 0, 250])];
  const { poses } = run(obs, 5);
  const drift = Math.max(...['b1', 'b2', 'b3'].map((id) => Math.hypot(poses.get(id).pos[0], poses.get(id).pos[1])));
  const top = poses.get('b3').pos[2];
  check('박스 3단 적층 안정 (수평 이동 < 2 mm, 최상단 ≈ 250 mm)', drift < 2 && Math.abs(top - 250) < 3, `수평 ${drift.toFixed(2)} mm, 최상단 ${top.toFixed(1)} mm`);
}

// 3) 결정성: 같은 배치를 두 번 실행하면 결과가 비트 단위로 같다 (NFR-10)
{
  const obs = [];
  for (let i = 0; i < 20; i++) obs.push(box(`r${i}`, [((i * 37) % 300) - 150, ((i * 53) % 300) - 150, 200 + i * 60], [80, 60, 50], { rot: [i * 7, i * 11, i * 13] }));
  const a = run(obs, 3).poses, b = run(obs, 3).poses;
  let maxDiff = 0;
  for (const [id, p] of a) p.pos.forEach((v, k) => (maxDiff = Math.max(maxDiff, Math.abs(v - b.get(id).pos[k]))));
  check('결정성: 같은 입력 2회 → 같은 결과', maxDiff === 0, `최대 차이 ${maxDiff} mm`);
}

// 4) 물성: 질량 지정·밀도, 마찰 차이 (경사면에서 미끄러짐)
{
  const w = new P.PhysicsWorld(RAPIER);
  w.load([box('m', [0, 0, 50], [100, 100, 100], { physics: { densityKgM3: 500, massKg: 3, friction: 0.6, restitution: 0.1 } }),
          box('d', [300, 0, 50], [100, 100, 100], { physics: { densityKgM3: 2000, massKg: null, friction: 0.6, restitution: 0.1 } })]);
  const mm = w.objects.get('m').body.mass(), md = w.objects.get('d').body.mass();
  check('질량 지정 3 kg / 밀도 2000 → 2 kg', Math.abs(mm - 3) < 1e-6 && Math.abs(md - 2) < 1e-6, `${mm.toFixed(3)} kg, ${md.toFixed(3)} kg`);
  w.dispose();
  // 중력을 기울여 경사면 효과: 마찰 0.1은 미끄러지고 1.5는 버틴다
  const slide = (friction) => {
    const ww = new P.PhysicsWorld(RAPIER, { gravity: [9.81 * Math.sin(0.4), 0, -9.81 * Math.cos(0.4)] });
    ww.load([box('f', [0, 0, 50], [100, 100, 100], { physics: { densityKgM3: 500, massKg: null, friction, restitution: 0 } })]);
    for (let i = 0; i < 120; i++) ww.step();
    const x = ww.poses().get('f').pos[0];
    ww.dispose();
    return x;
  };
  const low = slide(0.1), high = slide(1.5);
  check('마찰: 0.1은 미끄러지고 1.5는 버팀 (경사 23°)', low > 100 && Math.abs(high) < 5, `0.1 → ${low.toFixed(0)} mm, 1.5 → ${high.toFixed(1)} mm`);
}

// 5) 범위 이탈: 바닥 밖(반경 60 m)에서 떨어진 물체는 비활성화
{
  const { w, poses } = run([box('far', [60000, 0, 500])], 3);
  check('범위 이탈 물체 비활성화', poses.get('far').out === true && w.outOfRange.has('far'));
}

// 6) 숨긴 물체는 시뮬레이션하지 않음
{
  const { poses } = run([box('v', [0, 0, 300]), box('h', [300, 0, 300], [100, 100, 100], { visible: false })], 1);
  check('숨긴 물체 제외', poses.has('v') && !poses.has('h'));
}

// 7) 배치 저장 변환: 회전 배치 → 쿼터니언 → 다시 ZYX 오일러 (왕복 오차)
{
  let maxErr = 0;
  for (let i = 0; i < 500; i++) {
    const rpy = [Math.sin(i) * 179, Math.cos(i * 1.3) * 89, Math.sin(i * 0.7) * 179];
    const R = C.rotationFromRPY(rpy);
    const back = C.rotationFromRPY(P.rpyFromMatrix(P.matrixFromQuat(P.quatFromMatrix(R))));
    maxErr = Math.max(maxErr, ...R.map((v, k) => Math.abs(v - back[k])));
  }
  check('회전 변환 왕복 (RPY → 쿼터니언 → RPY)', maxErr < 1e-9, `최대 오차 ${maxErr.toExponential(1)}`);
}

// 8) 성능: 동적 물체 50개 (NFR-9 참고값)
{
  const obs = [];
  for (let i = 0; i < 50; i++) obs.push(box(`p${i}`, [(i % 7) * 130 - 400, Math.floor(i / 7) * 130 - 400, 100 + (i % 5) * 150], [100, 100, 100]));
  const { ms } = run(obs, 3);
  check('물체 50개 물리 스텝 평균 < 4 ms (Node)', ms < 4, `${ms.toFixed(3)} ms/step`);
}

// 10) 로봇 운동학 바디 (FR-19): 캡슐 방향, 로봇이 박스를 밀어냄, 로봇은 밀리지 않음, 결정성
{
  const K = await imp('kinematics.js');
  const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));
  const robot = robots[0]; // IRB 1200
  const segsAt = (q) => K.linkSegments(robot, K.forwardKinematics(robot, q).frames);
  // 캡슐 방향: 바디 로컬 Y축이 링크 방향과 일치하고 중심이 링크 중점
  const w0 = new P.PhysicsWorld(RAPIER);
  const q0 = [0, 20, -30, 40, 60, 10];
  const segs0 = segsAt(q0);
  w0.setRobot(segs0);
  let maxAxisErr = 0, maxCenterErr = 0;
  segs0.forEach((seg, i) => {
    const b = w0.robotBodies[i];
    const R = P.matrixFromQuat(b.rotation());
    const d = seg.b.map((v, k) => v - seg.a[k]);
    const n = Math.hypot(...d);
    if (n > 1) maxAxisErr = Math.max(maxAxisErr, ...[R[1], R[4], R[7]].map((v, k) => Math.abs(v - d[k] / n)));
    const t = b.translation();
    maxCenterErr = Math.max(maxCenterErr, Math.abs(t.x / P.MM - (seg.a[0] + seg.b[0]) / 2), Math.abs(t.z / P.MM - (seg.a[2] + seg.b[2]) / 2));
  });
  w0.dispose();
  check('로봇 링크 캡슐 자세 (축 방향·중심, Rapier float32 기준)', maxAxisErr < 1e-6 && maxCenterErr < 1e-3, `축 오차 ${maxAxisErr.toExponential(1)}, 중심 오차 ${maxCenterErr.toExponential(1)} mm`);

  // J1을 −40° → +40°로 돌리며 손목 쪽 경로에 놓인 박스를 민다 (60 Hz, 2초)
  const pushRun = () => {
    const w = new P.PhysicsWorld(RAPIER);
    const home = K.homeJoints(robot);
    const tcp = K.forwardKinematics(robot, home).tcp.pos; // 홈 TCP (451, 0, 807)
    w.load([box('target', [tcp[0], tcp[1], 200], [80, 80, 120], { physics: { densityKgM3: 300, massKg: null, friction: 0.5, restitution: 0 } })]);
    const startQ = home.slice(); startQ[0] = -40;
    w.setRobot(segsAt(startQ));
    for (let i = 0; i < 60; i++) w.step(); // 박스가 바닥에 안착 (중심 Z = 60)
    // 손끝(플랜지)이 박스 높이(Z = 80)에 오도록 IK로 자세를 정한 뒤 J1만 돌려 쓸고 지나간다
    const T = K.poseMatrix(C.rotationFromRPY([180, 0, 0]), [tcp[0], 0, 80]);
    const low = K.solveIK(robot, T, home).joints;
    const steps = 120;
    let robotPosErr = 0;
    for (let i = 0; i <= steps; i++) {
      const q = low.slice();
      q[0] = -40 + (80 * i) / steps;
      const segs = segsAt(q);
      w.moveRobot(segs);
      w.step();
      // 로봇은 밀리지 않음: 바디 위치 = 명령 위치
      const last = w.robotBodies.at(-1).translation();
      const want = segs.at(-1);
      robotPosErr = Math.max(robotPosErr, Math.abs(last.x / P.MM - (want.a[0] + want.b[0]) / 2));
    }
    for (let i = 0; i < 60; i++) w.step();
    const p = w.poses().get('target').pos;
    w.dispose();
    return { p, robotPosErr };
  };
  const r1 = pushRun(), r2 = pushRun();
  const moved = Math.hypot(r1.p[0] - 451, r1.p[1]);
  check('로봇이 경로의 박스를 밀어냄', moved > 50, `박스 이동 ${moved.toFixed(0)} mm (최종 ${r1.p.map((v) => v.toFixed(0)).join(', ')})`);
  check('로봇은 밀리지 않음 (명령 자세 유지)', r1.robotPosErr < 1e-3, `오차 ${r1.robotPosErr.toExponential(1)} mm`);
  const pd = Math.max(...r1.p.map((v, k) => Math.abs(v - r2.p[k])));
  check('결정성: 로봇이 박스를 미는 시나리오 2회 동일', pd === 0, `차이 ${pd} mm`);
}

// 9) 저장 스키마 v1 → v2 마이그레이션 (v1.0.0 데이터가 고정 모드 + 기본 물성으로 열림)
{
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.addEventListener ??= () => {};
  const S = await imp('state.js');
  const catalog = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));
  const v1 = {
    schemaVersion: 1, selectedMaker: 'KUKA', selectedRobotId: 'kuka-kr6-r900', joints: [10, 0, 0, 0, 90, 0],
    features: { selfCollision: true, obstacleCollision: true, singularity: false, autoPathPlanning: true },
    settings: { floorEnabled: true, speedPct: 150, theme: 'light' },
    obstacles: [{ id: 'w', name: '벽', type: 'box', pos: [500, 0, 300], size: [80, 300, 600], rot: [0, 0, 0], visible: true }],
    waypoints: [], alarmLog: [],
  };
  store.set(S.STORAGE_KEY, JSON.stringify(v1));
  const { state, notice } = S.initState(catalog);
  const ok = state.schemaVersion === 2 && state.settings.simMode === 'static' && state.settings.speedPct === 150 &&
    state.settings.theme === 'light' && state.obstacles[0].physics?.densityKgM3 === 500 && state.selectedRobotId === 'kuka-kr6-r900' &&
    Array.isArray(state.cell?.conveyors) && notice == null;
  check('저장 데이터 v1 → v2 (고정 모드, 기본 물성, 기존 값 유지)', ok, `schema ${state.schemaVersion}, simMode ${state.settings.simMode}`);
  S.importState(JSON.stringify({ ...v1, settings: { ...v1.settings, simMode: 'physics' } }));
  check('내보낸 v1.0.0 JSON 가져오기 → v2, 고정 모드로 시작', S.getState().schemaVersion === 2 && S.getState().settings.simMode === 'static');
  const bad = { ...v1, schemaVersion: 2, obstacles: [{ ...v1.obstacles[0], physics: { densityKgM3: -5, friction: 9, restitution: 0.5 } }] };
  S.importState(JSON.stringify(bad));
  const ph = S.getState().obstacles[0].physics;
  check('물성 검증: 범위 밖 값은 기본값', ph.densityKgM3 === 500 && ph.friction === 0.6 && ph.restitution === 0.5, JSON.stringify(ph));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
