// 경량 CHOMP 스타일 궤적 최적화 (PRD FR-13 4단계, FR-14 특이점 비용). DOM 비의존 — 플래너 Worker에서 실행한다.
// 경로를 고정 개수의 관절공간 점으로 나누고, 다음 비용을 공변(A⁻¹) 경사하강으로 줄인다.
//   J(ξ) = Σ ‖q_{k+1} − q_k‖²            (매끄러움: 관절 속도 제곱합, deg²)
//        + w · Σ [c(d_obs, ε) + c(d_self, ε_self)]   (장애물/자기충돌 거리 비용, d = 여유거리 밖으로 남은 거리 mm)
//        + w · Σ c_s(s_k)                (특이점 근접 비용, 특이점 회피가 켜졌을 때만)
// c(d)는 CHOMP의 거리 비용: d ≥ ε면 0, 0 ≤ d < ε면 (ε − d)²/(2ε), d < 0이면 ε/2 − d.
// 최적화 결과는 원래 경로처럼 촘촘한 구간 검사(edgeOk)를 통과할 때만 채택한다.
import { forwardKinematics } from './kinematics.js';
import { robotSegments } from './safety.js';
import { checkObstacleCollision, checkSelfCollision } from './collision.js';
import { checkSingularity } from './singularity.js';

const GRAD_STEP_DEG = 0.5; // 수치 미분 간격
const MAX_STEP_DEG = 2; // 반복당 경로점 최대 이동량
const SNAPSHOT_EVERY = 5; // 중간 결과 저장 간격 (검증 실패 시 되돌아갈 후보)

const distanceCost = (d, eps) => (d >= eps ? 0 : d >= 0 ? (eps - d) ** 2 / (2 * eps) : eps / 2 - d);

/**
 * @param {number[][]} path 유효한 경로 (양 끝 고정)
 * @param {object} ctx 계획용 안전 컨텍스트 (여유거리에 계획 여유가 더해진 것)
 * @param {{ edgeOk: (a, b) => boolean, avoidSingularity: boolean, budgetMs: number, maxIter?: number }} opts
 * @returns {{ path: number[][], applied: boolean, iterations: number, clearanceBefore: number, clearanceAfter: number }}
 *   clearance: 내부 경로점(고정된 시작·목표 제외) 중 최소 (장애물·자기충돌 거리 − 계획 여유거리), mm
 */
export function optimizePath(path, ctx, { edgeOk, avoidSingularity, budgetMs, maxIter = 40 }) {
  const t0 = performance.now();
  const { robot, thresholds: t } = ctx;
  const eps = Math.max(60, robot.reachMm * 0.1); // 장애물 거리 비용이 작용하는 범위 (mm)
  const epsSelf = 30; // 자기충돌은 평소에도 가까운 링크가 많으므로 좁은 범위만
  // 비용 균형: 접촉(d = 0) 비용 w·ε/2가 경로를 몇 도 줄여 얻는 매끄러움 이득(수십 deg²)보다 훨씬 크게 → 장애물 쪽으로 당겨지지 않음
  const w = 10;
  const limits = robot.jointLimitsDeg;

  // 1) 경로를 길이 기준으로 균등하게 나눈다 (끝점 포함 N개)
  const lengths = path.slice(1).map((q, i) => Math.hypot(...q.map((v, j) => v - path[i][j])));
  const total = lengths.reduce((s, v) => s + v, 0);
  const n = Math.min(40, Math.max(12, Math.ceil(total / 6)));
  const xi = resample(path, lengths, total, n);

  // 거리 측정: 충돌 검사는 여유거리 밖의 먼 장애물을 경계구 하한값으로 건너뛰므로,
  // 비용 범위(ε)까지는 정확한 거리가 나오도록 판정 거리를 여유거리 + ε로 넓혀서 잰다.
  const measure = (q) => {
    const { frames } = forwardKinematics(robot, q);
    const segs = robotSegments(ctx, frames); // 그리퍼·파지 물체 포함 (안전 검사와 같은 모델)
    return {
      obs: checkObstacleCollision(segs, ctx.compiled, t.obstacleMarginMm + eps, { floor: ctx.floor, skip: ctx.obstacleSkip, skipFloor: ctx.floorSkip }).minDistance - t.obstacleMarginMm,
      self: checkSelfCollision(segs, ctx.selfPairs, t.selfMarginMm + epsSelf).minDistance - t.selfMarginMm,
      sing: avoidSingularity ? singMargin(checkSingularity(robot, q, frames, t)) : Infinity,
    };
  };
  const clearance = (q) => {
    const m = measure(q);
    return Math.min(m.obs, m.self);
  };
  // 특이점 근접도: 경고 구간(임계값 2배) 바깥까지 얼마나 남았는지를 임계값 단위로 (0 이하 = 경고 구간 안)
  function singMargin(s) {
    const m = s.metrics;
    return Math.min(
      t.wristDeg > 0 ? m.wristDeg / t.wristDeg - 2 : Infinity,
      t.elbowDeg > 0 ? m.elbowDeg / t.elbowDeg - 2 : Infinity,
      t.shoulderMm > 0 ? m.shoulderMm / t.shoulderMm - 2 : Infinity,
    );
  }
  const pointCost = (q) => {
    const m = measure(q);
    let c = w * (distanceCost(m.obs, eps) + distanceCost(m.self, epsSelf));
    if (avoidSingularity) c += w * eps * distanceCost(m.sing, 1);
    return c;
  };
  const totalCost = (pts) => {
    let c = 0;
    for (let k = 1; k < pts.length; k++) c += pts[k].reduce((s, v, j) => s + (v - pts[k - 1][j]) ** 2, 0);
    for (let k = 1; k < pts.length - 1; k++) c += pointCost(pts[k]);
    return c;
  };
  const minClearance = (pts) => Math.min(...pts.slice(1, -1).map(clearance));

  const clearanceBefore = minClearance(xi);
  // 모든 경로점이 비용 범위(ε) 밖이면 최적화할 것이 없다 (직선 경로는 이미 가장 매끄럽다)
  if (xi.slice(1, -1).every((q) => pointCost(q) === 0)) {
    return { path, applied: false, iterations: 0, clearanceBefore, clearanceAfter: clearanceBefore };
  }
  let cost = totalCost(xi);
  let step = MAX_STEP_DEG;
  const snapshots = [xi.map((q) => q.slice())];
  let iterations = 0;

  for (let it = 0; it < maxIter && performance.now() - t0 < budgetMs; it++) {
    // 2) 경사: 매끄러움(해석적) + 거리/특이점(수치 미분)
    const grad = xi.map(() => new Array(6).fill(0));
    for (let k = 1; k < n - 1; k++) {
      const c0 = pointCost(xi[k]);
      for (let j = 0; j < 6; j++) {
        grad[k][j] = 2 * (2 * xi[k][j] - xi[k - 1][j] - xi[k + 1][j]);
        if (c0 > 0) { // 비용이 0인 점(모든 대상에서 ε 이상 떨어짐)은 거리 경사도 0
          const q = xi[k].slice();
          q[j] += GRAD_STEP_DEG;
          grad[k][j] += (pointCost(q) - c0) / GRAD_STEP_DEG;
        }
      }
    }
    // 3) 공변 경사: A⁻¹·g (A = 1차 차분 행렬 KᵀK, 삼중대각) → 경로 전체로 매끄럽게 퍼진 갱신
    const dir = preconditioned(grad, n);
    const maxAbs = Math.max(...dir.flat().map(Math.abs));
    if (maxAbs < 1e-6) break;
    // 4) 단계 크기: 최대 이동량을 step으로 맞추고, 비용이 늘면 절반으로 줄여 재시도
    let accepted = false;
    while (step > 0.05) {
      const cand = xi.map((q, k) =>
        k === 0 || k === n - 1 ? q : q.map((v, j) => clamp(v - (dir[k][j] / maxAbs) * step, limits[j])),
      );
      const c = totalCost(cand);
      if (c < cost) {
        for (let k = 1; k < n - 1; k++) xi[k] = cand[k];
        cost = c;
        accepted = true;
        step = Math.min(MAX_STEP_DEG, step * 1.2);
        break;
      }
      step /= 2;
    }
    if (!accepted) break;
    iterations = it + 1;
    if (iterations % SNAPSHOT_EVERY === 0) snapshots.push(xi.map((q) => q.slice()));
  }
  if (iterations % SNAPSHOT_EVERY !== 0) snapshots.push(xi.map((q) => q.slice()));

  // 5) 검증: 최신 결과 → (실패 시) 중간 결과 순으로 최대 2개만 구간 검사. 통과한 것을 단순화해서 채택.
  //    둘 다 실패하면 원래 경로를 유지한다 (계획 시간 상한을 지키기 위해 더 거슬러 올라가지 않음).
  const candidates = [snapshots.length - 1, Math.floor(snapshots.length / 2)].filter((v, i, a) => v >= 1 && a.indexOf(v) === i);
  for (const s of candidates) {
    const pts = snapshots[s];
    if (pts.every((q, k) => k === 0 || edgeOk(pts[k - 1], q))) {
      return { path: simplify(pts, edgeOk), applied: true, iterations, clearanceBefore, clearanceAfter: minClearance(pts) };
    }
  }
  return { path, applied: false, iterations, clearanceBefore, clearanceAfter: clearanceBefore };
}

function resample(path, lengths, total, n) {
  const out = [path[0].slice()];
  let seg = 0, acc = 0;
  for (let k = 1; k < n - 1; k++) {
    const target = (total * k) / (n - 1);
    while (seg < lengths.length - 1 && acc + lengths[seg] < target) acc += lengths[seg++];
    const s = lengths[seg] > 0 ? (target - acc) / lengths[seg] : 0;
    out.push(path[seg].map((v, j) => v + (path[seg + 1][j] - v) * s));
  }
  out.push(path[path.length - 1].slice());
  return out;
}

/** 내부 점에 대해 (KᵀK) x = g 를 관절별로 푼다 (대각 2, 비대각 −1, Thomas 알고리즘) */
function preconditioned(grad, n) {
  const m = n - 2;
  const out = grad.map((g) => g.slice());
  for (let j = 0; j < 6; j++) {
    const c = new Array(m), d = new Array(m);
    for (let i = 0; i < m; i++) {
      const denom = 2 + (i > 0 ? c[i - 1] : 0);
      c[i] = -1 / denom;
      d[i] = (grad[i + 1][j] + (i > 0 ? d[i - 1] : 0)) / denom;
    }
    for (let i = m - 1; i >= 0; i--) out[i + 1][j] = d[i] - c[i] * (i < m - 1 ? out[i + 2][j] : 0);
  }
  return out;
}

/** 거의 직선 위에 있는 점 제거 (편차 0.5° 미만이고 직결 구간이 유효할 때) */
function simplify(pts, edgeOk) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const prev = out[out.length - 1], q = pts[k], next = pts[k + 1];
    const d = q.map((v, j) => v - prev[j]), e = next.map((v, j) => v - prev[j]);
    const len2 = e.reduce((s, v) => s + v * v, 0);
    const s = len2 > 0 ? Math.max(0, Math.min(1, d.reduce((a, v, j) => a + v * e[j], 0) / len2)) : 0;
    const dev = Math.max(...q.map((v, j) => Math.abs(v - (prev[j] + e[j] * s))));
    if (!(dev < 0.5 && edgeOk(prev, next))) out.push(q);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
