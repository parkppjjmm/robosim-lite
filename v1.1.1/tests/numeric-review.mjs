// 4단계 수치 검증: 야코비안 유한차분, ZYX 오일러 왕복, 캡슐-장애물 경계 케이스, IK, 터널링, 복구 규칙, 성능
// 실행: node tests/numeric-review.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const C = await imp('collision.js');
const S = await imp('safety.js');
const SG = await imp('singularity.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const OFF = { selfCollision: false, obstacleCollision: false, singularity: false, autoPathPlanning: false };
let seed = 7;
const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0) >>> 0) / 4294967296;
const rnd = (a, b) => a + rand() * (b - a);
const randQ = (r) => r.jointLimitsDeg.map(([lo, hi]) => rnd(lo, hi));
const log = (...a) => console.log(...a);

// 1) Jacobian vs 유한차분
{
  let maxLin = 0, maxAng = 0;
  const h = 1e-4; // deg
  for (const r of robots) for (let n = 0; n < 30; n++) {
    const q = randQ(r);
    const J = K.jacobian(r, q);
    const T0 = K.forwardKinematics(r, q).frames[6];
    for (let i = 0; i < 6; i++) {
      const qp = q.slice(); qp[i] += h;
      const T1 = K.forwardKinematics(r, qp).frames[6];
      const dRad = h * K.DEG;
      const lin = [T1[3] - T0[3], T1[7] - T0[7], T1[11] - T0[11]].map((v) => v / dRad);
      // 각속도: R1 R0ᵀ 의 log
      const R0 = K.rotationOf(T0), R1 = K.rotationOf(T1);
      const w = K.logRotation(K.mul3(R1, K.transpose3(R0))).map((v) => v / dRad);
      for (let k = 0; k < 3; k++) {
        maxLin = Math.max(maxLin, Math.abs(lin[k] - J[k][i]) / Math.max(1, r.reachMm));
        maxAng = Math.max(maxAng, Math.abs(w[k] - J[k + 3][i]));
      }
    }
  }
  log(`[Jacobian] 유한차분 대비 최대 오차: 선속도 ${maxLin.toExponential(2)} (reach 정규화), 각속도 ${maxAng.toExponential(2)} rad/rad`);
}

// 2) 오일러(ZYX) 왕복
{
  let maxErr = 0, gimbal = 0;
  const cases = [];
  for (let n = 0; n < 2000; n++) cases.push([rnd(-180, 180), rnd(-89, 89), rnd(-180, 180)]);
  for (const ry of [90, -90]) for (let n = 0; n < 50; n++) cases.push([rnd(-180, 180), ry, rnd(-180, 180)]);
  for (const rpy of cases) {
    const R = C.rotationFromRPY(rpy);
    const back = K.rotationToRPY(K.poseMatrix(R, [0, 0, 0]));
    const R2 = C.rotationFromRPY(back);
    const e = Math.max(...R.map((v, i) => Math.abs(v - R2[i])));
    if (Math.abs(rpy[1]) === 90) gimbal = Math.max(gimbal, e);
    else maxErr = Math.max(maxErr, e);
  }
  log(`[Euler ZYX] 왕복 후 회전행렬 최대 오차: 일반 ${maxErr.toExponential(2)}, 짐벌락(Ry=±90°) ${gimbal.toExponential(2)}`);
}

// 3) 캡슐-장애물 거리 경계 케이스 (평행/꼭짓점/내부/회전)
{
  const box = C.compileObstacles([{ id: 'b', type: 'box', pos: [0, 0, 0], size: [200, 100, 50], rot: [30, -20, 45] }])[0];
  const cyl = C.compileObstacles([{ id: 'c', type: 'cylinder', pos: [0, 0, 0], size: [100, 100, 200], rot: [0, 90, 0] }])[0];
  const brute = (seg, ob) => {
    let m = Infinity;
    for (let i = 0; i <= 20000; i++) {
      const t = i / 20000, p = seg.a.map((v, k) => v + (seg.b[k] - v) * t);
      m = Math.min(m, C.capsuleObstacleDistance({ a: p, b: p, r: 0 }, ob));
    }
    return m - seg.r;
  };
  // 로컬 좌표에서 정의한 선분을 월드로
  const toWorld = (ob, p) => [0, 1, 2].map((r) => ob.R[r * 3] * p[0] + ob.R[r * 3 + 1] * p[1] + ob.R[r * 3 + 2] * p[2]).map((v, i) => v + ob.pos[i]);
  const mk = (ob, a, b, r = 10) => ({ a: toWorld(ob, a), b: toWorld(ob, b), r });
  const cases = [
    ['박스 면과 평행 (z=+60)', box, mk(box, [-300, 0, 60], [300, 0, 60]), 60 - 25 - 10],
    ['박스 꼭짓점 방향', box, mk(box, [150, 100, 75], [300, 200, 150]), Math.hypot(50, 50, 50) - 10],
    ['박스 완전 내부', box, mk(box, [-20, 0, 0], [20, 0, 0]), -25 - 10],
    ['박스 관통', box, mk(box, [-400, 0, 0], [400, 0, 0]), -25 - 10],
    ['원기둥 축과 평행 (r=80)', cyl, mk(cyl, [80, 0, -300], [80, 0, 300]), 30 - 10],
    ['원기둥 윗면 모서리', cyl, mk(cyl, [80, 0, 130], [200, 0, 200]), Math.hypot(30, 30) - 10],
  ];
  for (const [name, ob, seg, expect] of cases) {
    const fast = C.capsuleObstacleDistance(seg, ob);
    log(`[거리] ${name}: 계산 ${fast.toFixed(2)} / 기대 ${expect.toFixed(2)} / brute ${brute(seg, ob).toFixed(2)}`);
  }
}

// 4) IK: 관절 한계, 수렴 실패, 특이점 근처
{
  let viol = 0, fail = 0, total = 0, okNear = 0, nearTotal = 0, maxErrNear = 0;
  for (const r of robots) {
    for (let n = 0; n < 40; n++) {
      const qt = randQ(r);
      const T = K.forwardKinematics(r, qt).frames[6];
      const res = K.solveIK(r, T, randQ(r));
      total++;
      if (!res.ok) fail++;
      if (res.joints.some((v, i) => v < r.jointLimitsDeg[i][0] - 1e-9 || v > r.jointLimitsDeg[i][1] + 1e-9)) viol++;
    }
    // J5 ≈ 0.5° 목표에서 근처 시드
    for (let n = 0; n < 10; n++) {
      const qt = randQ(r); qt[4] = 0.5;
      const T = K.forwardKinematics(r, qt).frames[6];
      const res = K.solveIK(r, T, qt.map((v) => v + rnd(-3, 3)));
      nearTotal++;
      if (res.ok) okNear++;
      else maxErrNear = Math.max(maxErrNear, res.posErr);
    }
  }
  // 도달 불가 목표
  const r0 = robots[0];
  const far = K.poseMatrix(C.rotationFromRPY([180, 0, 0]), [r0.reachMm * 3, 0, 500]);
  const resFar = K.solveIK(r0, far, K.homeJoints(r0));
  log(`[IK] 단일시드 랜덤 성공 ${total - fail}/${total}, 관절한계 위반 ${viol}건, J5≈0.5° 근처시드 성공 ${okNear}/${nearTotal} (실패 시 최대 위치오차 ${maxErrNear.toFixed(2)} mm), 도달불가 → ok=${resFar.ok}, NaN=${resFar.joints.some(Number.isNaN)}`);
}

// 5) Self collision 제외쌍 (4,6) 실제 침범 여부 + 무작위 자세 최소거리
{
  log('[Self] 모델 | (4,6) 최소거리 (J5 전범위) | (2,4) trim 없이 최소거리(정상 자세) | 무작위 20000 자세 최소 self 거리');
  for (const r of robots) {
    let min46 = Infinity;
    for (let j5 = r.jointLimitsDeg[4][0]; j5 <= r.jointLimitsDeg[4][1]; j5 += 1) {
      const q = K.homeJoints(r).slice(); q[4] = j5;
      const segs = K.linkSegments(r, K.forwardKinematics(r, q).frames);
      const a = segs.find((s) => s.link === 4), b = segs.find((s) => s.link === 6);
      min46 = Math.min(min46, C.segmentSegmentDistance(a.a, a.b, b.a, b.b) - a.r - b.r);
    }
    const ctx = S.createSafetyContext(r, { features: { ...OFF, selfCollision: true }, thresholds: TH, obstacles: [], floor: false });
    let minSelf = Infinity;
    for (let n = 0; n < 20000; n++) {
      const q = randQ(r);
      const e = S.evaluatePose(ctx, q);
      minSelf = Math.min(minSelf, e.self.minDistance);
    }
    log(`  ${r.name} | ${min46.toFixed(0)} mm | - | ${minSelf.toFixed(0)} mm`);
  }
}

// 6) 터널링: 얇은 판(10 mm)을 한 번에 크게 건너뛰는 이동
{
  const r = robots[1];
  const home = K.homeJoints(r);
  const fk = K.forwardKinematics(r, home);
  const wc = K.origin(fk.frames[4]);
  const ang = Math.atan2(wc[1], wc[0]) + 30 * K.DEG;
  const R = Math.hypot(wc[0], wc[1]);
  const plate = { id: 'p', type: 'box', pos: [R * Math.cos(ang), R * Math.sin(ang), wc[2]], size: [10, 10, 300], rot: [0, 0, ang * K.RAD] };
  const ctx = S.createSafetyContext(r, { features: { ...OFF, obstacleCollision: true }, thresholds: { ...TH, obstacleMarginMm: 0 }, obstacles: [plate], floor: false });
  const base = S.evaluatePose(ctx, home);
  const q1 = home.slice(); q1[0] += 60;
  const res = S.sweepCheck(ctx, base, q1);
  log(`[터널링] 10mm 판을 J1 60° 한 스텝으로 통과 시도 → ok=${res.ok} (정지 J1=${res.last.q[0].toFixed(2)}°), 시작 min=${base.obstacle.minDistance.toFixed(0)}mm`);
}

// 7) 복구 규칙 구멍: 이미 위반 중일 때 다른 대상으로 새로 침범
{
  const r = robots[1];
  const home = K.homeJoints(r);
  // A: 선회 링크(link1)를 감싸는 원기둥 (J2 이동과 무관하게 침범량 일정)
  const A = { id: 'A', type: 'sphere', pos: [0, 0, r.dh[0].d * 0.6], size: [r.linkRadiiMm[0] * 3, r.linkRadiiMm[0] * 3, r.linkRadiiMm[0] * 3], rot: [0, 0, 0] };
  const ctx0 = S.createSafetyContext(r, { features: { ...OFF, obstacleCollision: true }, thresholds: TH, obstacles: [A], floor: false });
  const baseA = S.evaluatePose(ctx0, home);
  // B: J2를 앞으로 숙이면 닿는 위치에 박스
  const q1 = home.slice(); q1[1] += 25;
  const tcp1 = K.forwardKinematics(r, q1).tcp.pos;
  const B = { id: 'B', type: 'box', pos: [tcp1[0], tcp1[1], tcp1[2] - 40], size: [150, 150, 150], rot: [0, 0, 0] };
  const ctx = S.createSafetyContext(r, { features: { ...OFF, obstacleCollision: true }, thresholds: TH, obstacles: [A, B], floor: false });
  const base = S.evaluatePose(ctx, home);
  const res = S.sweepCheck(ctx, base, q1);
  const end = S.evaluatePose(ctx, res.last.q);
  const hitB = end.obstacle.hits.filter((h) => h.obstacleId === 'B');
  const dB = Math.min(...end.segments.filter((s) => s.link > 0).map((s) => C.capsuleObstacleDistance(s, C.compileObstacles([B])[0])));
  log(`[복구규칙] A 침범 severity=${(TH.obstacleMarginMm - baseA.obstacle.minDistance).toFixed(0)} 상태에서 B 쪽으로 J2 +25° → ok=${res.ok}, 도달 J2=${res.last.q[1].toFixed(1)}, B와 거리 ${dB.toFixed(0)} mm (B 침범 링크 ${hitB.length}개)`);

  // 특이점: 손목 특이점(J5=1°) 상태에서 팔꿈치 특이점으로 진입
  const ctxS = S.createSafetyContext(r, { features: { ...OFF, singularity: true }, thresholds: TH, obstacles: [], floor: false });
  // 팔꿈치 펴짐 J3 각 찾기
  let best = 0, bv = Infinity;
  for (let j3 = r.jointLimitsDeg[2][0]; j3 <= r.jointLimitsDeg[2][1]; j3 += 0.1) {
    const q = home.slice(); q[2] = j3; q[4] = 1;
    const e = SG.checkSingularity(r, q, K.forwardKinematics(r, q).frames, TH);
    if (e.metrics.elbowDeg < bv) { bv = e.metrics.elbowDeg; best = j3; }
  }
  const qs = home.slice(); qs[4] = 1;
  const baseS = S.evaluatePose(ctxS, qs);
  const qe = qs.slice(); qe[2] = best;
  const resS = S.sweepCheck(ctxS, baseS, qe);
  const endS = S.evaluatePose(ctxS, resS.last.q);
  log(`[복구규칙] 손목 특이점(J5=1°) 상태에서 J3→${best.toFixed(1)}° (팔꿈치 펴짐) → ok=${resS.ok}, 도달 elbow=${endS.singularity.metrics.elbowDeg.toFixed(2)}° (임계 3°), kinds=${endS.singularity.kinds}`);
}

// 8) 특이점 경고/정지 구간, 조작성 공식
{
  const r = robots[0];
  const q = K.homeJoints(r).slice();
  const at = (j5) => { q[4] = j5; return SG.checkSingularity(r, q, K.forwardKinematics(r, q).frames, TH).level; };
  const J = K.jacobian(r, K.homeJoints(r));
  const L = r.reachMm;
  const Jn = J.map((row, k) => (k < 3 ? row.map((v) => v / L) : row));
  const JJt = Jn.map((a) => Jn.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)));
  const det = (M) => { const A = M.map((x) => x.slice()); let d = 1; for (let c = 0; c < 6; c++) { let p = c; for (let rr = c + 1; rr < 6; rr++) if (Math.abs(A[rr][c]) > Math.abs(A[p][c])) p = rr; if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; d = -d; } d *= A[c][c]; for (let rr = c + 1; rr < 6; rr++) { const f = A[rr][c] / A[c][c]; for (let k = c; k < 6; k++) A[rr][k] -= f * A[c][k]; } } return d; };
  log(`[특이점] J5=11°:${at(11)} 9°:${at(9)} 4.9°:${at(4.9)} / w(코드)=${SG.manipulability(r, K.homeJoints(r), K.forwardKinematics(r, K.homeJoints(r)).frames).toFixed(5)} vs sqrt(det(JJᵀ))(정규화)=${Math.sqrt(det(JJt)).toFixed(5)}`);
}

// 9) 성능: 장애물 10개 + 모든 기능, 최대속도 1 tick 이동의 sweepCheck 시간
{
  const r = robots[2];
  const obs = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    obs.push({ id: 'o' + i, type: ['box', 'sphere', 'cylinder'][i % 3], pos: [Math.cos(a) * r.reachMm * 0.9, Math.sin(a) * r.reachMm * 0.9, 600], size: [300, 300, 600], rot: [10, 20, 30] });
  }
  const ctx = S.createSafetyContext(r, { features: { selfCollision: true, obstacleCollision: true, singularity: true }, thresholds: TH, obstacles: obs, floor: true });
  const dq = r.maxJointSpeedDegS.map((v) => v / 60);
  let worst = 0, sum = 0, n = 0;
  for (let k = 0; k < 300; k++) {
    const q0 = randQ(r);
    const base = S.evaluatePose(ctx, q0);
    const q1 = q0.map((v, i) => v + dq[i] * (rand() < 0.5 ? -1 : 1));
    const t0 = performance.now();
    S.sweepCheck(ctx, { ...base, violations: [] }, q1);
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms); sum += ms; n++;
  }
  log(`[성능] ${r.name} 전 관절 최대속도 1 tick sweepCheck: 평균 ${(sum / n).toFixed(3)} ms, 최대 ${worst.toFixed(3)} ms (Node)`);
}
