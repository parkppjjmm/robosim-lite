// 궤적 생성 (관절 보간 / 직선 보간) 및 시간 샘플링. DOM 비의존 — 2-C 플래너 결과 실행에도 사용.
// 궤적 형식: { points: number[][] (관절값), times: number[] (s, 오름차순), duration: number, marks: [{ time, id }] }
import { forwardKinematics, solveIK, interpolatePose, poseError, multiply, RAD } from './kinematics.js';
import { toolMatrix, inverseToolMatrix } from './gripper.js';

// 재생 속도 100% 기준값. 200%에서 관절 최대속도에 도달하도록 100% = 최대속도의 50%로 둔다.
export const BASE_JOINT_RATIO = 0.5;
export const BASE_TCP_MM_S = 250;
export const BASE_TCP_DEG_S = 90;

const LINEAR_STEP_MM = 5;
const LINEAR_STEP_DEG = 1;
const MAX_JOINT_JUMP_DEG = 10; // 직선 보간 샘플 사이 관절 변화 한계 (넘으면 특이점 통과/자세 반전으로 판단)

const baseSpeeds = (robot) => robot.maxJointSpeedDegS.map((v) => v * BASE_JOINT_RATIO);

/**
 * 관절 보간 (동기화 PTP). 코사인 속도 프로파일 s = (1 - cos(πτ)) / 2 의 최고속도 (π/2)·Δ/T가
 * 각 관절의 기준 속도를 넘지 않도록 이동 시간 T를 정한다.
 */
export function jointMove(robot, q0, q1) {
  const v = baseSpeeds(robot);
  const T = Math.max(0, ...q0.map((a, i) => (Math.PI / 2) * Math.abs(q1[i] - a) / v[i]));
  if (T < 1e-6) return { points: [q0.slice(), q1.slice()], times: [0, 0], duration: 0, marks: [] };
  const n = Math.max(2, Math.ceil(T * 60));
  const points = [], times = [];
  for (let k = 0; k <= n; k++) {
    const s = (1 - Math.cos((Math.PI * k) / n)) / 2;
    points.push(q0.map((a, i) => a + (q1[i] - a) * s));
    times.push((T * k) / n);
  }
  return { points, times, duration: T, marks: [] };
}

/**
 * 직선 보간: TCP를 직선(위치) + slerp(자세)로 이동. 샘플마다 이전 해를 시드로 IK를 풀어 연속성을 유지한다.
 * 각 구간 시간은 TCP 기준 속도와 관절 기준 속도 중 느린 쪽에 맞춘다.
 * @param targetT 목표 TCP 자세 (그리퍼가 있으면 손가락 끝, 없으면 플랜지)
 * @param qEnd 지정 시 마지막 해가 이 관절값(같은 자세 구성)과 일치해야 한다 (Waypoint 이동)
 * @param toolLengthMm 그리퍼 길이 (FR-21): TCP가 직선으로 움직이도록 TCP 자세를 보간한 뒤 플랜지 목표로 바꿔 IK를 푼다
 * @returns {{ ok: true, trajectory } | { ok: false, reason: 'ik'|'jump'|'config', at: number, message: string }}
 */
export function linearMove(robot, q0, targetT, { qEnd, toolLengthMm = 0 } = {}) {
  const v = baseSpeeds(robot);
  const tool = toolLengthMm ? toolMatrix(toolLengthMm) : null;
  const toFlange = toolLengthMm ? inverseToolMatrix(toolLengthMm) : null;
  const F0 = forwardKinematics(robot, q0).frames[6];
  const T0 = tool ? multiply(F0, tool) : F0;
  const total = poseError(T0, targetT);
  const n = Math.max(1, Math.ceil(Math.max(total.pos / LINEAR_STEP_MM, (total.rot * RAD) / LINEAR_STEP_DEG)));
  const dp = total.pos / n, dr = (total.rot * RAD) / n;

  const points = [q0.slice()], times = [0];
  let q = q0, t = 0;
  for (let k = 1; k <= n; k++) {
    const Tk = interpolatePose(T0, targetT, k / n);
    const res = solveIK(robot, toFlange ? multiply(Tk, toFlange) : Tk, q, { maxIter: 60 });
    if (!res.ok) {
      return { ok: false, reason: 'ik', at: k / n, message: '도달할 수 없는 구간이 있습니다 (작업 영역/관절 한계 밖)' };
    }
    const jump = Math.max(...res.joints.map((a, i) => Math.abs(a - q[i])));
    if (jump > MAX_JOINT_JUMP_DEG) {
      return { ok: false, reason: 'jump', at: k / n, message: '특이점 부근을 지나 관절이 급격히 회전해야 합니다' };
    }
    t += Math.max(dp / BASE_TCP_MM_S, dr / BASE_TCP_DEG_S, ...res.joints.map((a, i) => Math.abs(a - q[i]) / v[i]));
    q = res.joints;
    points.push(q);
    times.push(t);
  }
  if (qEnd) {
    if (Math.max(...q.map((a, i) => Math.abs(a - qEnd[i]))) > 1) {
      return { ok: false, reason: 'config', at: 1, message: '목표와 자세 구성(팔꿈치/손목 방향)이 달라 직선으로 갈 수 없습니다' };
    }
    points[points.length - 1] = qEnd.slice();
  }
  return { ok: true, trajectory: { points, times, duration: t, marks: [] } };
}

/** 여러 궤적을 이어 붙인다. marks[i]가 있으면 i번째 궤적 끝 시각에 표시를 남긴다. */
export function concatTrajectories(list, markIds = []) {
  const points = [], times = [], marks = [];
  let offset = 0;
  list.forEach((tr, i) => {
    tr.points.forEach((p, k) => {
      if (points.length && k === 0) return; // 이음매 중복 제거
      points.push(p);
      times.push(tr.times[k] + offset);
    });
    offset += tr.duration;
    if (markIds[i] !== undefined) marks.push({ time: offset, id: markIds[i] });
  });
  if (!points.length) return { points: [], times: [], duration: 0, marks };
  return { points, times, duration: offset, marks };
}

/** 시각 t의 관절값 (구간 선형 보간) */
export function sampleTrajectory(tr, t) {
  const { points, times } = tr;
  if (t <= 0 || points.length === 1) return points[0].slice();
  if (t >= tr.duration) return points[points.length - 1].slice();
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const s = span > 0 ? (t - times[lo]) / span : 1;
  return points[lo].map((a, i) => a + (points[hi][i] - a) * s);
}

// 가속 시간: 기준 속도까지 0.4 s (가속도 = 기준속도 / 0.4)
export const BASE_ACCEL_TIME_S = 0.4;
// 경로 이산화 간격: 이웃한 점 사이 관절 변화 최대값 (deg). 실행 궤적은 이 점들을 직선으로 잇는다.
const PATH_STEP_DEG = 0.5;

const norm6 = (v) => Math.hypot(...v);

/**
 * 모서리 블렌딩 곡선: prev→q→next 꼭짓점을 2차 베지에(제어점 = q)로 둥글게 깎는다.
 * 곡선 시작 A = q - δ·û₁, 끝 B = q + δ·û₂ (δ: 관절공간 거리, deg). A와 B를 포함한 표본점을 반환한다.
 * 플래너(충돌 검증)와 궤적 생성이 같은 점을 쓰므로, 검증한 꺾은선이 그대로 실행된다.
 */
export function cornerCurve(prev, q, next, delta) {
  const d1 = q.map((v, i) => v - prev[i]), d2 = next.map((v, i) => v - q[i]);
  const l1 = norm6(d1), l2 = norm6(d2);
  const A = q.map((v, i) => v - (d1[i] / l1) * delta);
  const B = q.map((v, i) => v + (d2[i] / l2) * delta);
  const n = Math.max(8, Math.ceil((2 * delta) / PATH_STEP_DEG));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, a = (1 - t) ** 2, b = 2 * t * (1 - t), c = t * t;
    pts.push(q.map((v, i) => a * A[i] + b * v + c * B[i]));
  }
  return pts;
}

/** 블렌딩 가능한 최대 δ: 인접 구간 길이의 40% (양쪽 모서리 블렌드가 한 구간에서 겹치지 않음) */
export const maxBlend = (prev, q, next) =>
  0.4 * Math.min(norm6(q.map((v, i) => v - prev[i])), norm6(next.map((v, i) => v - q[i])));

// 블렌드 없이 이 각도보다 크게 꺾이는 경유점은 정지 후 출발한다 (작은 꺾임은 곡률 속도 제한으로 통과)
const STOP_TURN_DEG = 30;

/**
 * 경유점 + 모서리 블렌드 → 촘촘한 경로점. 블렌드가 0이고 크게 꺾이는 경유점은 정지점(stops)으로 표시한다.
 * @returns {{ points: number[][], stops: Set<number> }}
 */
export function blendGeometry(vertices, blends = []) {
  const points = [vertices[0].slice()];
  const stops = new Set([0]);
  const lineTo = (target) => {
    const from = points[points.length - 1];
    const n = Math.max(1, Math.ceil(Math.max(...target.map((v, i) => Math.abs(v - from[i]))) / PATH_STEP_DEG));
    for (let k = 1; k <= n; k++) points.push(from.map((v, i) => v + ((target[i] - v) * k) / n));
  };
  for (let i = 1; i < vertices.length - 1; i++) {
    const delta = blends[i] ?? 0;
    if (delta > 0) {
      const curve = cornerCurve(vertices[i - 1], vertices[i], vertices[i + 1], delta);
      lineTo(curve[0]);
      for (const p of curve.slice(1)) points.push(p);
    } else {
      lineTo(vertices[i]);
      const a = vertices[i].map((v, k) => v - vertices[i - 1][k]), b = vertices[i + 1].map((v, k) => v - vertices[i][k]);
      const cos = a.reduce((s, v, k) => s + v * b[k], 0) / (norm6(a) * norm6(b) || 1);
      if (Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI) > STOP_TURN_DEG) stops.add(points.length - 1);
    }
  }
  lineTo(vertices[vertices.length - 1]);
  stops.add(points.length - 1);
  return { points, stops };
}

/**
 * 경유점 목록 → 실행 궤적 (경로 계획 결과 실행용, PRD FR-13 5단계).
 * 블렌드된 모서리와 작게 꺾이는 경유점은 멈추지 않고 지나가고, 크게 꺾이는 경유점에서만 정지한다.
 * 경로를 따라 속도 한계를 구한 뒤 앞/뒤 방향 가속도 패스로 속도 프로파일을 만든다:
 * - 구간 k의 진행 속도 한계 = min_i(v_i / |u_ki|)  (u = 단위 접선, deg 기준)
 * - 진행 가속도 한계 = min_i(a_i / |u_ki|)
 * - 곡선에서의 법선 가속도: |Δu_i|·v²/h ≤ a_i  →  v ≤ sqrt(a_i·h / |Δu_i|)
 */
export function pathTrajectory(robot, vertices, blends = []) {
  const vmax = baseSpeeds(robot);
  const amax = vmax.map((x) => x / BASE_ACCEL_TIME_S);
  const { points, stops } = blendGeometry(vertices, blends);
  const n = points.length;
  if (n < 2) return { points: [vertices[0].slice()], times: [0], duration: 0, marks: [] };

  const h = [], u = [], segV = [], segA = [];
  for (let k = 0; k < n - 1; k++) {
    const d = points[k + 1].map((v, i) => v - points[k][i]);
    const len = norm6(d);
    h.push(len);
    const dir = len > 1e-12 ? d.map((v) => v / len) : [0, 0, 0, 0, 0, 0];
    u.push(dir);
    let vs = Infinity, as = Infinity;
    dir.forEach((c, i) => {
      if (Math.abs(c) > 1e-12) {
        vs = Math.min(vs, vmax[i] / Math.abs(c));
        as = Math.min(as, amax[i] / Math.abs(c));
      }
    });
    segV.push(vs);
    segA.push(as);
  }
  // 점별 속도 상한
  const cap = new Array(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    if (stops.has(k)) continue;
    let c = Math.min(segV[k - 1], segV[k]);
    const hk = (h[k - 1] + h[k]) / 2;
    u[k].forEach((x, i) => {
      const du = Math.abs(x - u[k - 1][i]);
      if (du > 1e-12) c = Math.min(c, Math.sqrt((amax[i] * hk) / du));
    });
    cap[k] = Number.isFinite(c) ? c : 0;
  }
  const v = cap.slice();
  for (let k = 0; k < n - 1; k++) v[k + 1] = Math.min(v[k + 1], Math.sqrt(v[k] ** 2 + 2 * segA[k] * h[k]));
  for (let k = n - 2; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] ** 2 + 2 * segA[k] * h[k]));

  const times = [0];
  let t = 0;
  for (let k = 0; k < n - 1; k++) {
    const sum = v[k] + v[k + 1];
    t += h[k] < 1e-12 ? 0 : sum > 1e-9 ? (2 * h[k]) / sum : Math.sqrt((4 * h[k]) / segA[k]);
    times.push(t);
  }
  return { points, times, duration: t, marks: [] };
}

/**
 * 궤적을 fromIndex 지점부터 처음까지 거꾸로 되돌아가는 궤적 (계획 경로의 "처음으로").
 * 같은 경로를 되밟으므로 장애물 회피가 유지된다. startQ가 있으면 그 자세에서 fromIndex 점으로 먼저 이동한다.
 */
export function reverseTrajectory(robot, tr, fromIndex, startQ) {
  const tEnd = tr.times[fromIndex];
  const points = tr.points.slice(0, fromIndex + 1).reverse().map((q) => q.slice());
  let times = tr.times.slice(0, fromIndex + 1).reverse().map((t) => tEnd - t);
  if (startQ) {
    const v = baseSpeeds(robot);
    const lead = Math.max(1 / 60, ...startQ.map((a, i) => Math.abs(points[0][i] - a) / v[i]));
    points.unshift(startQ.slice());
    times = [0, ...times.map((t) => t + lead)];
  }
  return { points, times, duration: times[times.length - 1], marks: [] };
}
