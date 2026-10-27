// 특이점 감지 (PRD FR-10). DOM 비의존.
import { jacobian, origin, wristCenter, RAD } from './kinematics.js';

const KIND_LABEL = { wrist: '손목', elbow: '팔꿈치', shoulder: '어깨' };
export const singularityLabel = (kind) => KIND_LABEL[kind];

const angleBetween = (u, v) => {
  const nu = Math.hypot(...u), nv = Math.hypot(...v);
  if (nu < 1e-9 || nv < 1e-9) return 0;
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
  return Math.acos(Math.max(-1, Math.min(1, c))) * RAD;
};

/** 각도를 가장 가까운 180°의 배수까지의 거리로 변환 (0 ~ 90) */
const distToMultipleOf180 = (deg) => {
  const m = ((deg % 180) + 180) % 180;
  return Math.min(m, 180 - m);
};

/**
 * 특이점 판정
 * - 손목: J5가 0°(또는 ±180°)에 근접 → J4, J6 축 일치
 * - 팔꿈치: 상완(J2→J3)과 전완(J3→손목중심)이 일직선 (완전히 펴짐/접힘)
 * - 어깨: 손목 중심이 J1 축에 근접
 * 각 값이 임계값 미만이면 'stop', 임계값의 2배 미만이면 'warn'
 * @returns {{ level: 'ok'|'warn'|'stop', kinds: string[], warnKinds: string[], severity: number,
 *             manipulability: number, metrics: {wristDeg:number, elbowDeg:number, shoulderMm:number} }}
 *   severity: 임계값 대비 침범 정도의 최대값 (0 이하 = 정상, 클수록 특이점에 가까움)
 */
export function checkSingularity(robot, jointsDeg, frames, thresholds) {
  const wc = wristCenter(frames);
  const o1 = origin(frames[1]), o2 = origin(frames[2]);
  const elbowRaw = angleBetween([o2[0] - o1[0], o2[1] - o1[1], o2[2] - o1[2]], [wc[0] - o2[0], wc[1] - o2[1], wc[2] - o2[2]]);
  const metrics = {
    wristDeg: distToMultipleOf180(jointsDeg[4]),
    elbowDeg: Math.min(elbowRaw, 180 - elbowRaw),
    shoulderMm: Math.hypot(wc[0], wc[1]),
  };
  const checks = [
    ['wrist', metrics.wristDeg, thresholds.wristDeg],
    ['elbow', metrics.elbowDeg, thresholds.elbowDeg],
    ['shoulder', metrics.shoulderMm, thresholds.shoulderMm],
  ];
  const kinds = [], warnKinds = [];
  let severity = -Infinity;
  for (const [kind, value, limit] of checks) {
    if (limit <= 0) continue;
    severity = Math.max(severity, (limit - value) / limit);
    if (value < limit) kinds.push(kind);
    else if (value < limit * 2) warnKinds.push(kind);
  }
  return {
    level: kinds.length ? 'stop' : warnKinds.length ? 'warn' : 'ok',
    kinds,
    warnKinds,
    severity,
    manipulability: manipulability(robot, jointsDeg, frames),
    metrics,
  };
}

/**
 * Yoshikawa 조작성 w = sqrt(det(J·Jᵀ)). 6x6 정방 행렬이므로 |det(J)|와 같다.
 * 선속도 행은 최대 도달거리로 나눠 단위를 맞춘다 (무차원, 0 = 특이점).
 */
export function manipulability(robot, jointsDeg, frames) {
  const J = jacobian(robot, jointsDeg, frames);
  const L = robot.reachMm;
  const M = J.map((row, k) => (k < 3 ? row.map((v) => v / L) : row.slice()));
  return Math.abs(determinant(M));
}

/** 부분 피벗팅 가우스 소거 행렬식 */
function determinant(M) {
  const n = M.length;
  const A = M.map((r) => r.slice());
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return 0;
    if (p !== c) {
      [A[p], A[c]] = [A[c], A[p]];
      det = -det;
    }
    det *= A[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return det;
}
