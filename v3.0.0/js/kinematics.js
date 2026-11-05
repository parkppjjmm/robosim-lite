// 순수 기구학 모듈 (DOM / Three.js 의존 없음 — Worker, Node에서도 import 가능)
// 좌표계: 로봇 베이스 기준, Z-up, 단위 mm / deg (내부 계산은 rad)
// 행렬: 길이 16 배열, row-major (T[r * 4 + c])

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(A, B) {
  const C = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      C[r * 4 + c] =
        A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + A[r * 4 + 3] * B[12 + c];
    }
  }
  return C;
}

// 표준 DH: Rz(theta) · Tz(d) · Tx(a) · Rx(alpha)
export function dhMatrix(theta, d, a, alpha) {
  const ct = Math.cos(theta), st = Math.sin(theta);
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  return [
    ct, -st * ca, st * sa, a * ct,
    st, ct * ca, -ct * sa, a * st,
    0, sa, ca, d,
    0, 0, 0, 1,
  ];
}

export const origin = (T) => [T[3], T[7], T[11]];
export const axisX = (T) => [T[0], T[4], T[8]];
export const axisY = (T) => [T[1], T[5], T[9]];
export const axisZ = (T) => [T[2], T[6], T[10]];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * 순기구학
 * @returns {{frames: number[][], tcp: {pos: number[], rpy: number[]}}}
 *   frames[0] = 베이스, frames[i] = 관절 i 이후 프레임 (frames[6] = 플랜지/TCP)
 */
export function forwardKinematics(robot, jointsDeg) {
  const frames = [identity()];
  let T = frames[0];
  robot.dh.forEach((p, i) => {
    T = multiply(T, dhMatrix((jointsDeg[i] + p.offset) * DEG, p.d, p.a, p.alpha * DEG));
    frames.push(T);
  });
  return { frames, tcp: { pos: origin(T), rpy: rotationToRPY(T) } };
}

/**
 * 회전행렬 → 오일러각 [Rx, Ry, Rz] (deg)
 * 규약: R = Rz(rz) · Ry(ry) · Rx(rx)  (고정축 X→Y→Z 순서 회전, ZYX 오일러)
 */
export function rotationToRPY(T) {
  const r20 = T[8], r21 = T[9], r22 = T[10], r10 = T[4], r00 = T[0];
  const ry = Math.atan2(-r20, Math.hypot(r00, r10));
  let rx, rz;
  if (Math.abs(Math.cos(ry)) < 1e-9) {
    // 짐벌락: rz = 0 으로 고정
    rz = 0;
    rx = Math.atan2(-T[6], T[5]);
  } else {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  }
  return [rx * RAD, ry * RAD, rz * RAD];
}

/** 기하 야코비안 6x6 (행: vx, vy, vz, wx, wy, wz / 열: J1..J6, 각속도 단위 rad 기준) */
export function jacobian(robot, jointsDeg, frames = forwardKinematics(robot, jointsDeg).frames) {
  const pe = origin(frames[6]);
  const J = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let i = 0; i < 6; i++) {
    const z = axisZ(frames[i]);
    const v = cross(z, sub(pe, origin(frames[i])));
    for (let k = 0; k < 3; k++) {
      J[k][i] = v[k];
      J[k + 3][i] = z[k];
    }
  }
  return J;
}

/** 손목 중심 (J4/J5/J6 축 교점) */
export const wristCenter = (frames) => origin(frames[4]);

// 7~9: 그리퍼 몸체·손가락, 파지한 물체 (v1.1.0 FR-21, 22 — gripper.js / safety.js)
export const LINK_NAMES = ['베이스', '링크1(선회)', '링크2(상완)', '링크3(엘보)', '링크4(전완)', '링크5(손목)', '링크6(플랜지)', '그리퍼 몸체', '그리퍼 손가락', '파지한 물체'];

/**
 * 링크를 캡슐(선분 + 반경)로 근사한 목록. 렌더링과 충돌 검사(collision.js)가 함께 사용한다.
 * link: 0 = 베이스(고정), 1..6 = 관절 i가 움직이는 링크
 */
export function linkSegments(robot, frames) {
  const r = robot.linkRadiiMm;
  const d1 = robot.dh[0].d;
  const baseH = d1 * 0.3;
  const o1 = origin(frames[1]), o2 = origin(frames[2]), o3 = origin(frames[3]);
  const wc = origin(frames[4]), flange = origin(frames[6]);
  const toolDir = axisZ(frames[6]);
  const wristEnd = add(wc, scale(toolDir, robot.dh[5].d * 0.5));

  const segs = [
    { link: 0, a: [0, 0, 0], b: [0, 0, baseH], r: r[0] * 1.25 },
    { link: 1, a: [0, 0, baseH], b: [0, 0, d1], r: r[0] },
  ];
  if (Math.abs(robot.dh[0].a) > 1) segs.push({ link: 1, a: [0, 0, d1], b: o1, r: r[0] });
  segs.push(
    { link: 2, a: o1, b: o2, r: r[1] },
    { link: 3, a: o2, b: o3, r: r[2] },
    { link: 4, a: o3, b: wc, r: r[3] },
    { link: 5, a: wc, b: wristEnd, r: r[4] },
    { link: 6, a: wristEnd, b: flange, r: r[5] },
  );
  for (const seg of segs) seg.name = LINK_NAMES[seg.link];
  return segs;
}

export function clampJoints(robot, jointsDeg) {
  return jointsDeg.map((q, i) => {
    const [lo, hi] = robot.jointLimitsDeg[i];
    const v = Number.isFinite(q) ? q : 0;
    return Math.min(hi, Math.max(lo, v));
  });
}

/** 기본(홈) 자세: 상완 수직, 전완 수평, 툴 하향 */
export function homeJoints(robot) {
  return clampJoints(robot, robot.homeDeg ?? [0, 0, 0, 0, 90, 0]);
}

/**
 * (검증 스크립트용) 최대 도달거리: J1 축으로부터 손목 중심까지의 최대 수평거리 (카탈로그 정의와 동일)
 * J2/J3를 관절 한계 내에서 격자 탐색한다.
 */
export function maxReach(robot, stepDeg = 0.5) {
  const [l2, h2] = robot.jointLimitsDeg[1];
  const [l3, h3] = robot.jointLimitsDeg[2];
  let best = 0;
  for (let q2 = l2; q2 <= h2; q2 += stepDeg) {
    for (let q3 = l3; q3 <= h3; q3 += stepDeg) {
      const { frames } = forwardKinematics(robot, [0, q2, q3, 0, 0, 0]);
      const wc = wristCenter(frames);
      best = Math.max(best, Math.hypot(wc[0], wc[1]));
    }
  }
  return best;
}

// ---------- 회전 / 포즈 유틸 (3x3 row-major) ----------

export const rotationOf = (T) => [T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]];

export function poseMatrix(R, p) {
  return [R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1];
}

export function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return C;
}

export const transpose3 = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];

/** 축-각 벡터 w (rad, |w| = 각도) → 회전행렬 (Rodrigues) */
export function expRotation(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + x * x * v, x * y * v - z * s, x * z * v + y * s,
    y * x * v + z * s, c + y * y * v, y * z * v - x * s,
    z * x * v - y * s, z * y * v + x * s, c + z * z * v,
  ];
}

/** 회전행렬 → 축-각 벡터 (rad) */
export function logRotation(R) {
  const cos = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180° 근처: 대각 성분에서 축 복원
    const xx = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[4] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    let axis;
    if (xx >= yy && xx >= zz) axis = [xx, R[1] / (2 * xx), R[2] / (2 * xx)];
    else if (yy >= zz) axis = [R[1] / (2 * yy), yy, R[5] / (2 * yy)];
    else axis = [R[2] / (2 * zz), R[5] / (2 * zz), zz];
    const n = Math.hypot(...axis);
    return axis.map((v) => (v / n) * th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** 두 포즈 사이 보간 (위치 선형, 회전 slerp), s ∈ [0, 1] */
export function interpolatePose(T0, T1, s) {
  const R0 = rotationOf(T0);
  const w = logRotation(mul3(transpose3(R0), rotationOf(T1)));
  const R = mul3(R0, expRotation(scale(w, s)));
  const p0 = origin(T0), p1 = origin(T1);
  return poseMatrix(R, [p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s, p0[2] + (p1[2] - p0[2]) * s]);
}

/** 포즈 오차: 위치 [mm], 회전 [rad] (월드 기준 축-각, current → target) */
export function poseError(current, target) {
  const ep = sub(origin(target), origin(current));
  const er = logRotation(mul3(rotationOf(target), transpose3(rotationOf(current))));
  return { ep, er, pos: Math.hypot(...ep), rot: Math.hypot(...er) };
}

/** n x n 선형계 A x = b (부분 피벗팅 가우스 소거) */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ---------- 역기구학 (Damped Least Squares) ----------

/**
 * 수치 IK: Δq = Jᵀ (J Jᵀ + λ² I)⁻¹ e
 * 회전 오차는 특성 길이(도달거리의 절반)를 곱해 mm 단위로 맞춘다. 관절 한계는 매 반복 클램프.
 * @param targetT 목표 플랜지 포즈 (4x4 row-major)
 * @param seedDeg 초기 관절값
 * @returns {{ ok: boolean, joints: number[], posErr: number, rotErrDeg: number, iterations: number }}
 */
export function solveIK(robot, targetT, seedDeg, opts = {}) {
  const { maxIter = 150, tolMm = 0.01, tolDeg = 0.005, maxStepDeg = 8 } = opts;
  const W = robot.reachMm * 0.5;
  const lambda2 = (robot.reachMm * 0.01) ** 2;
  let q = clampJoints(robot, seedDeg);
  let err = null;
  for (let it = 0; it <= maxIter; it++) {
    const { frames } = forwardKinematics(robot, q);
    err = poseError(frames[6], targetT);
    if (err.pos < tolMm && err.rot * RAD < tolDeg) {
      return { ok: true, joints: q, posErr: err.pos, rotErrDeg: err.rot * RAD, iterations: it };
    }
    if (it === maxIter) break;
    const J = jacobian(robot, q, frames).map((row, k) => (k < 3 ? row : row.map((v) => v * W)));
    const e = [...err.ep, ...err.er.map((v) => v * W)];
    const JJt = J.map((ri) => J.map((rj) => ri.reduce((s, v, k) => s + v * rj[k], 0)));
    for (let i = 0; i < 6; i++) JJt[i][i] += lambda2;
    const y = solveLinear(JJt, e);
    if (!y) break;
    let dq = [0, 1, 2, 3, 4, 5].map((c) => J.reduce((s, row, r) => s + row[c] * y[r], 0) * RAD);
    const maxAbs = Math.max(...dq.map(Math.abs));
    if (maxAbs > maxStepDeg) dq = dq.map((v) => (v * maxStepDeg) / maxAbs);
    q = clampJoints(robot, q.map((v, i) => v + dq[i]));
  }
  return { ok: false, joints: q, posErr: err.pos, rotErrDeg: err.rot * RAD, iterations: maxIter };
}

/** 결정적 의사난수 (시드 고정 → 같은 입력이면 같은 해) */
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 다중 시드 IK: 서로 다른 해(자세 구성)를 모아 reference에 가까운 순으로 반환한다.
 * @param seeds 우선 시도할 시드 목록 (예: 현재 자세, 홈)
 * @returns {number[][]} 관절해 목록 (중복 제거, 최대 maxSolutions개)
 */
export function solveIKMulti(robot, targetT, { seeds = [], reference = seeds[0], randomSeeds = 24, maxSolutions = 8 } = {}) {
  const rand = mulberry32(12345);
  const all = [...seeds];
  for (let n = 0; n < randomSeeds; n++) all.push(robot.jointLimitsDeg.map(([lo, hi]) => lo + (hi - lo) * rand()));
  const found = [];
  for (const seed of all) {
    const res = solveIK(robot, targetT, seed, { maxIter: 120 });
    if (!res.ok) continue;
    if (found.some((q) => q.every((v, i) => Math.abs(v - res.joints[i]) < 1))) continue;
    found.push(res.joints);
  }
  const ref = reference ?? homeJoints(robot);
  const dist = (q) => q.reduce((s, v, i) => s + Math.abs(v - ref[i]), 0);
  return found.sort((a, b) => dist(a) - dist(b)).slice(0, maxSolutions);
}
