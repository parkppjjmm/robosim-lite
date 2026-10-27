// 자세 안전 평가 (충돌 + 특이점) 및 이동 구간 세분 검사. DOM 비의존 — 플래너 Worker에서도 재사용.
import { forwardKinematics, linkSegments, homeJoints, multiply, DEG } from './kinematics.js';
import { toolSegments } from './gripper.js';
import { buildSelfPairs, checkSelfCollision, checkObstacleCollision, compileObstacles } from './collision.js';
import { checkSingularity } from './singularity.js';

export const SWEEP_STEP_MM = 8; // 세분 검사 시 링크 위 임의 점의 최대 이동량 (터널링 방지)
const SEVERITY_EPS = 1e-3;

/**
 * 로봇·환경별 검사 컨텍스트 (환경이 바뀔 때만 다시 만든다)
 * 숨김 처리된 장애물은 충돌 검사에서 제외한다.
 */
export function createSafetyContext(robot, { features, thresholds, obstacles, floor, tool = null, attached = null, physicsMode = false }) {
  const { frames } = forwardKinematics(robot, homeJoints(robot));
  const ctx = {
    robot,
    features,
    thresholds,
    floor,
    // 그리퍼 (PRD_v.1.1.0 FR-21): { spec, opening } — opening은 개폐 중 바뀌므로 ctx.tool.opening을 직접 갱신한다
    tool: tool && { spec: tool.spec, opening: tool.opening },
    // 파지한 물체 (FR-22): { id, type, size, rel(플랜지 기준 4x4) } — 로봇의 일부로 다른 물체·바닥과의 충돌을 검사
    attached,
    physicsMode,
    levers: leverBounds(robot, tool?.spec, attached),
    compiled: compileObstacles(obstacles.filter((o) => o.visible !== false)),
  };
  ctx.selfPairs = buildSelfPairs(robot, robotSegments(ctx, frames));
  // 물리 모드: 손가락은 물체와 닿아도 됨(파지 동작), 파지한 물체는 로봇의 일부라 자기 자신과 비교하지 않음 (PRD 4.3)
  // attached.ignore: 집을 때 이미 맞닿아 있던 대상(받침 물체, 'floor') — 들어 올려 떨어질 때까지 파지 물체(9)의 검사에서 제외
  // releasedId: 방금 놓은 물체 — 그리퍼 몸체(7)에서 떨어질 때까지 제외 (놓자마자 알람이 나지 않도록)
  ctx.releasedId = null;
  ctx.obstacleSkip = (seg, ob) =>
    (ctx.attached && ob.id === ctx.attached.id) ||
    (ctx.physicsMode && seg.link === 8) ||
    (seg.link === 9 && !!ctx.attached?.ignore?.includes(ob.id)) ||
    (seg.link === 7 && ob.id === ctx.releasedId);
  ctx.floorSkip = (seg) => seg.link === 9 && !!ctx.attached?.ignore?.includes('floor');
  return ctx;
}

/** 로봇 링크 캡슐 + 그리퍼(7, 8) + 파지한 물체(9) */
export function robotSegments(ctx, frames) {
  const segs = linkSegments(ctx.robot, frames);
  if (ctx.tool) segs.push(...toolSegments(ctx.tool.spec, frames[6], ctx.tool.opening));
  if (ctx.attached) segs.push(attachedSegment(ctx.attached, frames[6]));
  return segs;
}

/** 파지한 물체를 감싸는 캡슐 (가장 긴 축 방향, 나머지 단면을 덮는 반경 → 보수적) */
function attachedSegment(att, T6) {
  const T = multiply(T6, att.rel);
  const col = (i) => [T[i], T[4 + i], T[8 + i]];
  const o = [T[3], T[7], T[11]];
  const [sx, sy, sz] = att.size.map((v) => v / 2);
  if (att.type === 'sphere') return { link: 9, a: o, b: o, r: sx, name: '파지한 물체' };
  if (att.type === 'cylinder') {
    const z = col(2);
    const h = Math.max(0, sz - sx);
    return { link: 9, a: o.map((v, i) => v - z[i] * h), b: o.map((v, i) => v + z[i] * h), r: sx, name: '파지한 물체' };
  }
  const half = [sx, sy, sz];
  const k = half.indexOf(Math.max(...half));
  const others = half.filter((_, i) => i !== k);
  const r = Math.hypot(...others);
  const h = Math.max(0, half[k] - r * 0.5);
  const ax = col(k);
  return { link: 9, a: o.map((v, i) => v - ax[i] * h), b: o.map((v, i) => v + ax[i] * h), r, name: '파지한 물체' };
}

/**
 * 한 자세의 안전 평가. 활성화된 기능만 위반(violations)으로 보고한다.
 * 특이점 지표(조작성 등)는 표시용으로 항상 계산한다.
 * 위반은 대상별로 나눠 보고한다: { type, key, severity }
 *   key: SELF = 'S:링크a-링크b', OBSTACLE = 'O:링크:장애물id', SINGULARITY = 'G:종류'
 *   severity: 클수록 심각 (충돌 = 여유거리 대비 침범 mm, 특이점 = 임계값 대비 비율)
 */
export function evaluatePose(ctx, q) {
  const { frames, tcp } = forwardKinematics(ctx.robot, q);
  const segments = robotSegments(ctx, frames);
  const { features: f, thresholds: t } = ctx;
  const violations = [];

  // 같은 대상(key)이 여러 캡슐에서 걸리면 가장 심한 값만 남긴다
  const byKey = new Map();
  const add = (type, key, severity) => {
    const prev = byKey.get(key);
    if (!prev || severity > prev.severity) byKey.set(key, { type, key, severity });
  };

  let self = null;
  if (f.selfCollision) {
    self = checkSelfCollision(segments, ctx.selfPairs, t.selfMarginMm);
    self.pairs.forEach(([a, b], k) => add('SELF', `S:${a}-${b}`, t.selfMarginMm - self.dists[k]));
  }
  let obstacle = null;
  if (f.obstacleCollision) {
    obstacle = checkObstacleCollision(segments, ctx.compiled, t.obstacleMarginMm, { floor: ctx.floor, skip: ctx.obstacleSkip, skipFloor: ctx.floorSkip });
    for (const h of obstacle.hits) add('OBSTACLE', `O:${h.link}:${h.obstacleId}`, t.obstacleMarginMm - h.d);
  }
  const singularity = checkSingularity(ctx.robot, q, frames, t);
  if (f.singularity) {
    const m = singularity.metrics;
    const value = { wrist: m.wristDeg, elbow: m.elbowDeg, shoulder: m.shoulderMm };
    const limit = { wrist: t.wristDeg, elbow: t.elbowDeg, shoulder: t.shoulderMm };
    for (const kind of singularity.kinds) add('SINGULARITY', `G:${kind}`, (limit[kind] - value[kind]) / limit[kind]);
  }
  violations.push(...byKey.values());
  return { q, frames, tcp, segments, self, obstacle, singularity, violations };
}

/** 위반 목록의 유형 (중복 제거) */
export const violationTypes = (violations) => [...new Set(violations.map((v) => v.type))];

/**
 * 위반이 있어도 "이전보다 나빠지지 않는" 이동은 허용한다 (Reset 후 위반 자세에서 빠져나오기 위함).
 * 비교는 대상(key)별로 한다: 이전에 없던 대상과의 새 위반은 항상 차단하고,
 * 이미 위반 중이던 대상은 침범이 깊어질 때만 차단한다.
 */
export function blockedViolations(next, prev) {
  return next.violations.filter((v) => {
    const p = prev.violations.find((x) => x.key === v.key);
    return !p || v.severity > p.severity + SEVERITY_EPS;
  });
}

/**
 * 관절 i 회전 시 그 뒤 링크 위 점의 회전 반경 상한 (mm). 자세와 무관한 보수적 상한:
 * 관절 i 이후 DH 링크 길이(|a| + |d|)의 합 + 최대 캡슐 반경 (삼각부등식).
 * 자세별 실제 반경을 쓰면 접힌 자세에서 펴진 자세로 갈 때 과소평가되어 세분이 부족해진다.
 */
export function leverBounds(robot, toolSpec = null, attached = null) {
  const rMax = Math.max(...robot.linkRadiiMm) * 1.25;
  // 그리퍼·파지한 물체가 있으면 플랜지 너머로 그만큼 더 멀리 나간다
  const extra =
    (toolSpec ? toolSpec.lengthMm + Math.max(toolSpec.bodyDiaMm / 2, toolSpec.maxOpenMm / 2 + toolSpec.fingerThickMm) : 0) +
    (attached ? Math.hypot(...attached.size) / 2 : 0);
  return robot.dh.map((_, i) => robot.dh.slice(i).reduce((s, p) => s + Math.abs(p.a) + Math.abs(p.d), 0) + rMax + extra);
}

/** 파지 상태 변경 (FR-22): 파지한 물체 설정/해제 후 세분 검사용 레버암 상한도 갱신 */
export function setAttached(ctx, attached) {
  ctx.attached = attached;
  ctx.levers = leverBounds(ctx.robot, ctx.tool?.spec, attached);
}

/**
 * q0 → q1 이동을 세분해서 검사한다 (적용 전 검사).
 * @param base q0의 evaluatePose 결과
 * @returns {{ ok: true, last: object } | { ok: false, last: object, hit: object, blocked: object[] }}
 *   last = 마지막 안전 자세의 평가, hit = 처음 막힌 자세의 평가
 */
export function sweepCheck(ctx, base, q1) {
  const q0 = base.q;
  const travel = travelMm(ctx, q0, q1);
  if (travel === 0) return { ok: true, last: base };
  const minStep = Math.min(1, SWEEP_STEP_MM / travel);
  let prev = base;
  let s = 0;
  while (s < 1) {
    // 보수적 전진: 현재 자세의 여유로 "이만큼 움직여도 새 위반이 생길 수 없는" 구간은 건너뛴다.
    // 위반 중이거나 여유가 작으면 기존과 같은 SWEEP_STEP_MM 간격으로 검사한다.
    s = Math.min(1, s + Math.max(minStep, safeFraction(ctx, prev, q0, q1, travel)));
    const e = evaluatePose(ctx, q0.map((v, i) => v + (q1[i] - v) * s));
    const blocked = blockedViolations(e, prev);
    if (blocked.length) return { ok: false, last: prev, hit: e, blocked };
    prev = e;
  }
  return { ok: true, last: prev };
}

/**
 * e 자세에서 q0→q1 진행률로 얼마나 더 가도 활성 기능의 위반이 새로 생길 수 없는지 (0~1).
 * - 장애물: 링크 위 점의 이동량 ≤ travel·Δs → 거리 감소도 그 이하
 * - Self: 두 링크가 모두 움직이므로 거리 감소 ≤ 2·travel·Δs
 * - 특이점: |J5| 변화 ≤ |ΔJ5|·Δs, 팔꿈치 각 변화 ≤ |ΔJ3|·Δs (각도가 J3에만 의존), 손목중심 이동 ≤ travel·Δs
 * 위반 중인 기능이 하나라도 있으면 0 (기본 간격 사용).
 */
function safeFraction(ctx, e, q0, q1, travel) {
  const { features: f, thresholds: t } = ctx;
  if (e.violations.length) return 0;
  let frac = Infinity;
  if (f.obstacleCollision) frac = Math.min(frac, (e.obstacle.minDistance - t.obstacleMarginMm) / travel);
  if (f.selfCollision) frac = Math.min(frac, (e.self.minDistance - t.selfMarginMm) / (2 * travel));
  if (f.singularity) {
    const m = e.singularity.metrics;
    const d5 = Math.abs(q1[4] - q0[4]), d3 = Math.abs(q1[2] - q0[2]);
    if (t.wristDeg > 0 && d5 > 0) frac = Math.min(frac, (m.wristDeg - t.wristDeg) / d5);
    if (t.elbowDeg > 0 && d3 > 0) frac = Math.min(frac, (m.elbowDeg - t.elbowDeg) / d3);
    if (t.shoulderMm > 0) frac = Math.min(frac, (m.shoulderMm - t.shoulderMm) / travel);
  }
  return Number.isFinite(frac) ? Math.max(0, frac) : 1;
}

/** q0 → q1 동안 링크 위 임의 점의 이동량 상한 (mm) */
function travelMm(ctx, q0, q1) {
  let travel = 0;
  for (let i = 0; i < 6; i++) travel += Math.abs(q1[i] - q0[i]) * DEG * ctx.levers[i];
  return travel;
}

/** q0 → q1 동안 링크 위 임의 점의 스텝당 이동량이 SWEEP_STEP_MM 이하가 되도록 나눈 스텝 수 */
function substepCount(ctx, q0, q1) {
  return Math.max(1, Math.ceil(travelMm(ctx, q0, q1) / SWEEP_STEP_MM));
}

/**
 * 엄격한 구간 검사 (경로 계획용): q0 → q1 사이 모든 세분 자세가 valid(evaluation)를 만족해야 한다.
 * sweepCheck와 달리 "나빠지지 않는 위반"도 허용하지 않는다. (q0 자체는 호출자가 이미 검사했다고 가정)
 */
export function motionValid(ctx, q0, q1, valid) {
  const n = substepCount(ctx, q0, q1);
  for (let k = 1; k <= n; k++) {
    if (!valid(evaluatePose(ctx, q0.map((v, i) => v + ((q1[i] - v) * k) / n)))) return false;
  }
  return true;
}
