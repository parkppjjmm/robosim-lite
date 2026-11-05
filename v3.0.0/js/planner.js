// 장애물 회피 경로 계획 코어 (PRD FR-12~FR-14). DOM 비의존 — planner.worker.js에서 실행하고 Node에서도 테스트한다.
// 구성: (목표가 TCP면) 다중 시드 IK → 직선 경로 시도 → 관절공간 RRT-Connect → Shortcut smoothing
//       → CHOMP 스타일 최적화(optimizer.js) → 모서리 블렌딩
// 시간 파라미터화는 trajectory.pathTrajectory()가 담당한다 (메인 스레드와 같은 함수 사용).
import { homeJoints, solveIKMulti, poseMatrix, multiply } from './kinematics.js';
import { inverseToolMatrix } from './gripper.js';
import { createSafetyContext, evaluatePose, motionValid, SWEEP_STEP_MM } from './safety.js';
import { rotationFromRPY } from './collision.js';
import { cornerCurve, maxBlend } from './trajectory.js';
import { optimizePath } from './optimizer.js';

const YIELD_MS = 40; // 이 시간마다 이벤트 루프에 양보 (취소 메시지 수신, 진행률 전송)
const SHORTCUT_MAX_MS = 200; // smoothing 시간 상한
const BLEND_MAX_MS = 150; // 모서리 블렌딩 시간 상한
const OPTIMIZE_MAX_MS = 250; // 궤적 최적화 시간 상한
const BLEND_FRACTIONS = [1, 0.5, 0.25]; // maxBlend 대비 시도할 블렌드 크기 (큰 것부터)

/**
 * @param {object} req { robot, obstacles, thresholds, floor, start, goal, reference?, avoidSingularity?, features?, timeoutMs, deterministic? }
 *   deterministic (v3.0.0): { shortcutIters, maxSamples } 또는 true — 시간 예산 대신 반복 횟수로 후처리를 끝내
 *   PC 속도와 무관하게 같은 결과를 낸다(헤드리스 학습·평가용). 없으면 기존(시간 예산) 동작.
 *   start / goal: { type: 'joints', joints } | { type: 'pose', pos: number[], rpy: number[] } (start는 관절값 배열도 허용)
 *   reference: TCP 지정 시 여러 IK 해 중 가까운 해를 고르는 기준 관절값 (보통 현재 자세)
 *   avoidSingularity: 특이점 회피 여부 (없으면 features.singularity를 따른다)
 *   tool / attached / physicsMode: 그리퍼({ spec, opening })·파지한 물체·물리 모드 (FR-21, 22) — 안전 검사와 같은 모델로 계획
 *   pose 목표의 pos/rpy는 TCP 기준 (그리퍼가 있으면 손가락 끝) → 내부에서 플랜지 목표로 바꿔 IK를 푼다
 * @param {{ onProgress?: (p) => void, isCancelled?: () => boolean }} hooks
 * @returns {Promise<{ ok: true, path: number[][], blends: number[], stats } | { ok: false, reason: string, message: string, stats }>}
 *   blends[i]: 경유점 i의 모서리 블렌드 크기 (관절공간 deg, 0 = 정지점)
 *   reason: 'start-collision' | 'goal-collision' | 'ik-failed'(도달 불가) | 'singularity-blocked' | 'timeout' | 'cancelled'
 */
export async function planPath(req, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const t0 = now();
  const timeoutMs = req.timeoutMs ?? 5000;
  const det = req.deterministic ? { shortcutIters: 200, maxSamples: 40000, ...(req.deterministic === true ? {} : req.deterministic) } : null;
  let samples = 0;
  const { robot } = req;
  // 장애물 회피가 목적이므로 충돌 검사는 감지 토글과 무관하게 항상 켠다. 특이점 회피는 감지 기능이 켜졌을 때만.
  const avoidSingularity = req.avoidSingularity ?? !!req.features?.singularity;
  // 세분 검사 사이에서 거리가 최대 SWEEP_STEP_MM/2 줄어들 수 있으므로 여유거리를 그만큼 키워서 계획한다
  // → 실행 시 사용자 여유거리 아래로 내려가지 않는다.
  const pad = SWEEP_STEP_MM / 2;
  const toolCtx = { tool: req.tool ?? null, attached: req.attached ?? null, physicsMode: !!req.physicsMode };
  const toolLengthMm = req.tool ? req.tool.spec.lengthMm : 0;
  const ctx = createSafetyContext(robot, {
    features: { selfCollision: true, obstacleCollision: true, singularity: avoidSingularity },
    thresholds: { ...req.thresholds, selfMarginMm: req.thresholds.selfMarginMm + pad, obstacleMarginMm: req.thresholds.obstacleMarginMm + pad },
    obstacles: req.obstacles,
    floor: req.floor,
    ...toolCtx,
  });
  const stats = { timeMs: 0, nodes: 0, direct: false, rawVertices: 0, vertices: 0, blended: 0, checks: 0, optimized: null };
  const done = (result) => ({ ...result, stats: { ...stats, timeMs: Math.round(now() - t0) } });

  // 자세 유효성: 위반 없음. 샘플(중간 노드)은 특이점 경고 구간(임계값 2배 이내)도 피한다.
  const validPose = (e) => {
    stats.checks++;
    return e.violations.length === 0;
  };
  const validNode = (e) => validPose(e) && (!avoidSingularity || e.singularity.level === 'ok');
  const edgeOk = (a, b) => motionValid(ctx, a, b, validPose);

  // 실행 시 기준(사용자 여유거리) 컨텍스트: 계획 여유(+pad) 때문에 거부된 것인지 구분해서 안내한다
  const rawCtx = createSafetyContext(robot, { features: ctx.features, thresholds: req.thresholds, obstacles: req.obstacles, floor: req.floor, ...toolCtx });
  const poseMessage = (q, label) =>
    evaluatePose(rawCtx, q).violations.length
      ? `${label} 자세가 이미 충돌/특이점 상태입니다.`
      : `${label} 자세가 계획 여유거리(설정값 + ${pad} mm) 안에 있습니다. 장애물에서 조금 더 떨어진 자세를 지정하세요.`;
  const cancelled = async () => {
    await yieldToEventLoop();
    return isCancelled();
  };

  // ---- 시작(A) / 목표(B): 관절값이면 그대로, TCP면 다중 해 IK → 충돌/특이점 없는 해만 ----
  const reference = req.reference ?? homeJoints(robot);
  const resolve = async (spec, label, seed) => {
    if (Array.isArray(spec)) spec = { type: 'joints', joints: spec };
    if (spec.type !== 'pose') {
      const q = spec.joints.slice();
      return validPose(evaluatePose(ctx, q)) ? { sols: [q] } : { fail: { reason: `${label === '시작' ? 'start' : 'goal'}-collision`, message: poseMessage(q, label) } };
    }
    if (await cancelled()) return { fail: { reason: 'cancelled', message: '경로 계획을 취소했습니다.' } };
    const Ttcp = poseMatrix(rotationFromRPY(spec.rpy), spec.pos);
    const T = toolLengthMm ? multiply(Ttcp, inverseToolMatrix(toolLengthMm)) : Ttcp; // TCP → 플랜지
    const sols = solveIKMulti(robot, T, { seeds: [seed, reference, homeJoints(robot)], reference: seed });
    if (!sols.length) return { fail: { reason: 'ik-failed', message: reachMessage(robot, spec, label, toolLengthMm) } };
    const ok = sols.filter((q) => validPose(evaluatePose(ctx, q)));
    if (!ok.length) {
      return { fail: { reason: `${label === '시작' ? 'start' : 'goal'}-collision`, message: `${label} TCP의 관절해 ${sols.length}개가 모두 충돌/특이점 상태입니다.` } };
    }
    return { sols: ok };
  };
  const startRes = await resolve(req.start, '시작', reference);
  if (startRes.fail) return done({ ok: false, ...startRes.fail });
  const goalRes = await resolve(req.goal, '목표', startRes.sols[0]);
  if (goalRes.fail) return done({ ok: false, ...goalRes.fail });
  let start = startRes.sols[0];
  let goals = goalRes.sols;
  // 손목 특이점(J5 = 0)은 관절공간을 둘로 나눈다. 회피가 켜져 있으면 J5 부호가 같은 시작/목표 해끼리만 잇는다.
  if (avoidSingularity) {
    const pair = startRes.sols.map((s) => ({ s, g: goals.filter((g) => Math.sign(g[4]) === Math.sign(s[4])) })).find((x) => x.g.length);
    if (!pair) {
      return done({ ok: false, reason: 'singularity-blocked', message: '손목 특이점(J5 = 0°)을 지나야만 갈 수 있는 목표입니다. 계획 옵션의 특이점 회피를 끄거나 손목 방향(J5 부호)이 같은 목표를 지정하세요.' });
    }
    start = pair.s;
    goals = pair.g;
  }

  // ---- 1) 직선(관절공간) 경로로 충분한지 먼저 확인 ----
  for (const g of goals) {
    if (await cancelled()) return done({ ok: false, reason: 'cancelled', message: '경로 계획을 취소했습니다.' });
    if (edgeOk(start, g)) {
      stats.direct = true;
      stats.rawVertices = 2;
      return finish([start, g]);
    }
  }

  // ---- 2) RRT-Connect ----
  // 거리: 관절별 레버암(홈 자세 기준)으로 가중 → 대략 링크 끝 이동량(mm)에 비례
  const w = ctx.levers.map((l) => l * (Math.PI / 180)); // = leverBounds (그리퍼·파지 물체 포함)
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (w[i] * (v - b[i])) ** 2, 0));
  const stepMm = Math.max(120, robot.reachMm * 0.12);
  // 회전 범위가 360°를 넘는 관절(J4, J6 등)은 시작/목표 주변 ±180°만 샘플링 (불필요한 한 바퀴 회전 방지)
  const allQ = [start, ...goals];
  const bounds = robot.jointLimitsDeg.map(([lo, hi], i) => {
    if (hi - lo <= 360) return [lo, hi];
    const vals = allQ.map((q) => q[i]);
    return [Math.max(lo, Math.min(...vals) - 180), Math.min(hi, Math.max(...vals) + 180)];
  });
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0) >>> 0) / 4294967296;
  const sample = () => bounds.map(([lo, hi]) => lo + (hi - lo) * rand());

  const makeTree = (roots) => ({ nodes: roots.map((q) => ({ q, parent: -1 })) });
  let A = makeTree([start]);
  let B = makeTree(goals);
  A.isStart = true;

  const nearest = (tree, q) => {
    let best = 0, bd = Infinity;
    tree.nodes.forEach((n, i) => {
      const d = dist(n.q, q);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const steer = (from, to) => {
    const d = dist(from, to);
    if (d <= stepMm) return { q: to.slice(), reached: true };
    const s = stepMm / d;
    return { q: from.map((v, i) => v + (to[i] - v) * s), reached: false };
  };
  // extend: 'trapped' | 'advanced' | 'reached'
  const extend = (tree, target) => {
    const ni = nearest(tree, target);
    const { q, reached } = steer(tree.nodes[ni].q, target);
    const e = evaluatePose(ctx, q);
    if (!(reached ? validPose(e) : validNode(e))) return { status: 'trapped' };
    if (!motionValid(ctx, tree.nodes[ni].q, q, validPose)) return { status: 'trapped' };
    tree.nodes.push({ q, parent: ni });
    return { status: reached ? 'reached' : 'advanced', index: tree.nodes.length - 1 };
  };
  const connect = (tree, target) => {
    let r;
    do r = extend(tree, target);
    while (r.status === 'advanced');
    return r;
  };
  const trace = (tree, i) => {
    const out = [];
    for (; i >= 0; i = tree.nodes[i].parent) out.push(tree.nodes[i].q);
    return out;
  };

  let lastYield = now();
  let path = null;
  while (!path) {
    const elapsed = now() - t0;
    if (det ? samples > det.maxSamples : elapsed > timeoutMs) {
      stats.nodes = A.nodes.length + B.nodes.length;
      return done({ ok: false, reason: 'timeout', message: `${(timeoutMs / 1000).toFixed(0)}초 안에 경로를 찾지 못했습니다. 장애물 배치나 목표를 확인하세요.` });
    }
    if (now() - lastYield > YIELD_MS) {
      await yieldToEventLoop();
      lastYield = now();
      if (isCancelled()) return done({ ok: false, reason: 'cancelled', message: '경로 계획을 취소했습니다.' });
      onProgress({ phase: 'search', ratio: Math.min(0.95, elapsed / timeoutMs), nodes: A.nodes.length + B.nodes.length });
    }
    const qr = sample();
    samples++;
    if (!validNode(evaluatePose(ctx, qr))) continue;
    const ra = extend(A, qr);
    if (ra.status !== 'trapped') {
      const rb = connect(B, A.nodes[ra.index].q);
      if (rb.status === 'reached') {
        const fromA = trace(A, ra.index).reverse();
        const fromB = trace(B, rb.index);
        path = [...fromA, ...fromB.slice(1)];
        if (!A.isStart) path.reverse();
      }
    }
    [A, B] = [B, A];
  }
  stats.nodes = A.nodes.length + B.nodes.length;
  stats.rawVertices = path.length;

  // ---- 3) Shortcut smoothing ----
  onProgress({ phase: 'smooth', ratio: 0.96, nodes: stats.nodes });
  const smoothBudget = Math.min(SHORTCUT_MAX_MS, Math.max(30, timeoutMs - (now() - t0)));
  path = shortcut(path, edgeOk, det ? Infinity : smoothBudget, rand, det ? det.shortcutIters : Infinity);
  return finish(path);

  /** 직선 경로와 탐색 경로 공통 마무리: 궤적 최적화 → 모서리 블렌딩 */
  async function finish(p) {
    // ---- 4) 궤적 최적화: 장애물에서 멀어지고(ε까지) 매끄러워지도록. 검증 통과 시에만 채택 ----
    onProgress({ phase: 'optimize', ratio: 0.97, nodes: stats.nodes });
    if (await cancelled()) return done({ ok: false, reason: 'cancelled', message: '경로 계획을 취소했습니다.' });
    const tOpt = now();
    const opt = optimizePath(p, ctx, { edgeOk, avoidSingularity, budgetMs: det ? Infinity : OPTIMIZE_MAX_MS });
    stats.optimized = {
      ms: Math.round(now() - tOpt),
      applied: opt.applied,
      iterations: opt.iterations,
      clearanceBefore: Math.round(opt.clearanceBefore),
      clearanceAfter: Math.round(opt.clearanceAfter),
    };
    p = opt.path;
    stats.vertices = p.length;

    // ---- 5) 모서리 블렌딩: 경유점에서 멈추지 않도록 둥글게 깎는다 (충돌 검증 통과한 크기만) ----
    onProgress({ phase: 'blend', ratio: 0.98, nodes: stats.nodes });
    const tBlend = now();
    const blends = blendCorners(p, edgeOk, det ? Infinity : BLEND_MAX_MS);
    stats.blendMs = Math.round(now() - tBlend);
    stats.blended = blends.filter((b) => b > 0).length;
    return done({ ok: true, path: p, blends, goal: p[p.length - 1] });
  }
}

/**
 * 각 내부 경유점에 대해 가장 큰 유효 블렌드를 고른다. 곡선 표본점 사이 직선(실행 궤적과 동일)을 모두 검사한다.
 * 블렌드 구간은 인접 구간의 40% 이내라 서로 겹치지 않으므로 경유점별로 독립적으로 정할 수 있다.
 */
function blendCorners(path, edgeOk, budgetMs) {
  const blends = new Array(path.length).fill(0);
  const t0 = now();
  for (let i = 1; i < path.length - 1 && now() - t0 < budgetMs; i++) {
    const max = maxBlend(path[i - 1], path[i], path[i + 1]);
    for (const f of BLEND_FRACTIONS) {
      const curve = cornerCurve(path[i - 1], path[i], path[i + 1], max * f);
      let ok = true;
      for (let k = 1; k < curve.length && ok; k++) ok = edgeOk(curve[k - 1], curve[k]);
      if (ok) {
        blends[i] = max * f;
        break;
      }
    }
  }
  return blends;
}

/**
 * Shortcut smoothing: 그리디(가장 먼 직결 가능 점) 1회 후, 남은 시간 동안 무작위 두 점 직결 시도.
 */
function shortcut(path, edgeOk, budgetMs, rand, maxIters = Infinity) {
  // 그리디: 앞에서부터 가장 멀리 직선으로 갈 수 있는 점으로 점프
  const greedy = [path[0]];
  for (let i = 0; i < path.length - 1; ) {
    let j = path.length - 1;
    while (j > i + 1 && !edgeOk(path[i], path[j])) j--;
    greedy.push(path[j]);
    i = j;
  }
  let p = greedy;
  // 무작위: 구간 중간점끼리 연결해서 꼭짓점을 깎는다
  const t0 = now();
  let iter = 0;
  while (now() - t0 < budgetMs && iter++ < maxIters && p.length > 2) {
    const i = Math.floor(rand() * (p.length - 1));
    const j = Math.floor(rand() * (p.length - 1));
    if (Math.abs(i - j) < 1) continue;
    const [a, b] = i < j ? [i, j] : [j, i];
    const sa = rand(), sb = rand();
    const qa = p[a].map((v, k) => v + (p[a + 1][k] - v) * sa);
    const qb = p[b].map((v, k) => v + (p[b + 1][k] - v) * sb);
    if (edgeOk(qa, qb)) p = [...p.slice(0, a + 1), qa, qb, ...p.slice(b + 1)];
  }
  // 거의 일직선인 중간점 제거. 새로 생기는 구간 p[i-1] → p[i+1]은 반드시 다시 검사한다
  // (작은 꺾임이라도 긴 구간에서는 링크 끝이 수십 mm 벗어날 수 있음).
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const prev = out[out.length - 1], q = p[i], next = p[i + 1];
    const d1 = q.map((v, k) => v - prev[k]), d2 = next.map((v, k) => v - q[k]);
    const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
    const nearlyStraight = n1 < 1e-6 || n2 < 1e-6 || d1.reduce((s, v, k) => s + v * d2[k], 0) / (n1 * n2) > 0.9999;
    if (!(nearlyStraight && edgeOk(prev, next))) out.push(q);
  }
  out.push(p[p.length - 1]);
  return out;
}

/**
 * IK 해가 없을 때 원인 안내: 손목 중심이 팔(상완+전완) 길이 밖이면 작업 영역 밖, 안이면 자세(방향)/관절 한계 문제
 */
function reachMessage(robot, { pos, rpy }, label, toolLengthMm = 0) {
  const R = rotationFromRPY(rpy);
  const d6 = robot.dh[5].d + toolLengthMm; // 손목 중심 = TCP에서 접근축 반대로 (d6 + 그리퍼 길이)
  const wc = [pos[0] - R[2] * d6, pos[1] - R[5] * d6, pos[2] - R[8] * d6];
  const [p1, p2, p3, p4] = robot.dh;
  const radial = Math.hypot(wc[0], wc[1]) - Math.abs(p1.a);
  const dist = Math.hypot(radial, wc[2] - p1.d);
  const arm = Math.abs(p2.a) + Math.hypot(p3.a, p4.d);
  return dist > arm
    ? `${label} TCP가 작업 영역 밖입니다 (Out of Reach: 손목 중심까지 ${dist.toFixed(0)} mm, 팔 길이 ${arm.toFixed(0)} mm).`
    : `${label} TCP 위치는 작업 영역 안이지만, 지정한 자세(Rx/Ry/Rz)로는 관절 한계 안에서 도달할 수 없습니다 (Out of Reach).`;
}

const now = () => performance.now();
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
