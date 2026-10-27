// Pick & Place 작업 계획 (PRD_v.1.1.0 FR-24). DOM 비의존 — 브라우저(main.js, 플래너 Worker 사용)와 Node 테스트에서 함께 쓴다.
// 구간: ① 현재 → 파지 접근점(자동 경로) ② 직선 하강 ③ 닫기(파지) ④ 직선 상승
//       ⑤ → 놓기 접근점(자동 경로, 파지 물체 포함) ⑥ 직선 하강 ⑦ 열기(놓기) ⑧ 직선 상승
// 계획 시점의 물체 위치를 정적 장애물로 보고(스냅샷), 집을 물체는 장애물에서 뺀다(①~④는 파지 대상, ⑤~⑦은 로봇의 일부).
import { forwardKinematics, multiply, poseMatrix, origin, rotationOf, transpose3, rotationToRPY } from './kinematics.js';
import { toolMatrix, inverseToolMatrix, objectWidthAlong, toolSegments } from './gripper.js';
import { createSafetyContext, evaluatePose, motionValid, attachedSegment } from './safety.js';
import { compileObstacles, checkObstacleCollision } from './collision.js';
import { linearMove, pathTrajectory, concatTrajectories } from './trajectory.js';

export const TASK_DEFAULTS = { approachMm: 100, graspDir: 'top' };
export const OBJECT_MOVED_TOLERANCE_MM = 10; // 파지 직전 물체 위치 재확인 허용 오차 (FR-24)
const PLACE_RAISE_STEP_MM = 5; // 놓기점이 너무 낮으면 이 간격으로 올려 본다
const PLACE_RAISE_MAX_MM = 400;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const n = Math.hypot(...a);
  return n < 1e-9 ? null : a.map((v) => v / n);
};
const colOf = (T, i) => [T[i], T[4 + i], T[8 + i]];

/** 강체 변환의 역행렬 (4x4 row-major) */
export function invertRigid(T) {
  const Rt = transpose3(rotationOf(T));
  const p = origin(T);
  return poseMatrix(Rt, [0, 1, 2].map((r) => -(Rt[r * 3] * p[0] + Rt[r * 3 + 1] * p[1] + Rt[r * 3 + 2] * p[2])));
}

/** TCP 자세 T를 접근축(TCP Z)의 반대 방향으로 mm만큼 물린 자세 (접근점·상승점) */
export function backOff(T, mm) {
  const z = colOf(T, 2);
  return poseMatrix(rotationOf(T), origin(T).map((v, i) => v - z[i] * mm));
}

/**
 * 파지 TCP 자세. 손가락(X)은 물체 폭이 최대 벌림 폭 안에 드는 방향 중 지금 TCP X와 가장 가까운 쪽으로 고른다(J6 회전 최소).
 * 손가락 끝은 물체 안쪽으로 dep만큼 들어간다: 그리퍼 몸체가 물체 윗면에서 여유거리 + 5 mm 떨어지도록, 최대 물체 절반 깊이.
 * @param ob { type, size, pos, R } 물체 현재 자세
 * @param dir 'top' = 위에서 수직(접근 −Z), 'keep' = 현재 TCP 방향 유지
 * @returns {{ T, widthMm } | { error }}
 */
export function graspPose(spec, ob, dir, currentTcp, marginMm) {
  const cx = colOf(currentTcp, 0);
  let z, cands;
  if (dir === 'keep') {
    z = colOf(currentTcp, 2);
    cands = [cx];
    if (ob.type === 'box') for (let i = 0; i < 3; i++) cands.push([ob.R[i], ob.R[3 + i], ob.R[6 + i]]);
  } else {
    z = [0, 0, -1];
    cands = [];
    if (ob.type === 'box') for (let i = 0; i < 3; i++) cands.push([ob.R[i], ob.R[3 + i], ob.R[6 + i]]);
    cands.push(cx, [1, 0, 0], [0, 1, 0]);
  }
  let best = null;
  for (const c of cands) {
    // 접근축에 수직인 성분만 남긴다
    let x = norm(c.map((v, i) => v - dot(c, z) * z[i]));
    if (!x) continue;
    if (dot(x, cx) < 0) x = x.map((v) => -v);
    const width = objectWidthAlong(ob, ob.R, x);
    if (width > spec.maxOpenMm - 2) continue;
    if (!best || dot(x, cx) > best.align + 1e-9) best = { x, width, align: dot(x, cx) };
  }
  if (!best) {
    const minW = Math.min(...cands.map((c) => norm(c.map((v, i) => v - dot(c, z) * z[i]))).filter(Boolean).map((x) => objectWidthAlong(ob, ob.R, x)));
    return { error: `물체 폭(${minW.toFixed(0)} mm)이 그리퍼 최대 벌림 폭(${spec.maxOpenMm} mm)보다 커서 집을 수 없습니다` };
  }
  const x = best.x, y = cross(z, x);
  const R = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  const half = objectWidthAlong(ob, ob.R, z) / 2; // 접근축 방향 물체 반 길이
  const fingerLen = spec.lengthMm - spec.bodyHeightMm;
  const dep = Math.min(half, fingerLen - marginMm - 5);
  if (dep < 5) return { error: `그리퍼 손가락(${fingerLen} mm)이 짧아 여유거리(${marginMm} mm)를 지키며 물체를 감쌀 수 없습니다` };
  const p = ob.pos.map((v, i) => v + z[i] * (dep - half));
  // 손가락 끝(TCP)이 바닥 여유거리 안으로 들어가지 않게: 위에서 집을 때만 해당
  if (dir !== 'keep' && p[2] < marginMm + 2) {
    const top = ob.pos[2] + half;
    p[2] = marginMm + 2;
    if (top - p[2] < 5) return { error: '물체가 너무 낮아 손가락이 바닥 여유거리 안으로 들어가야 합니다' };
  }
  return { T: poseMatrix(R, p), widthMm: best.width };
}

/**
 * Pick & Place 계획.
 * @param input { robot, q0, spec, object{ id, name, type, size, pos, R }, placeT(놓기 TCP 4x4), graspDir, approachMm,
 *                obstacles(스냅샷, 집을 물체 포함), thresholds, floor, avoidSingularity }
 * @param deps { plan(req) => Promise<planPath 결과> }  req = { start, goal, obstacles, tool, attached, physicsMode }
 * @returns {Promise<{ ok: true, steps, vertices, trajectory, placeRaisedMm, expectedObjectPos }
 *                   | { ok: false, stage, reason, message }>}
 *   steps: [{ kind: 'move', label, trajectory } | { kind: 'grip', cmd: 'close'|'open', objectId, objectPos? }]
 *   vertices: [{ q, label, kind: 'start'|'via'|'pick'|'place'|'end' }]
 */
export async function planPickPlace(input, { plan }) {
  const { robot, q0, spec, object, placeT, graspDir = TASK_DEFAULTS.graspDir, approachMm = TASK_DEFAULTS.approachMm,
    obstacles, thresholds, floor, avoidSingularity = false } = input;
  const L = spec.lengthMm;
  const tool = { spec, opening: spec.maxOpenMm };
  const others = obstacles.filter((o) => o.id !== object.id);
  const fail = (stage, message, reason = 'task') => ({ ok: false, stage, reason, message: `${stage}: ${message}` });
  const features = { selfCollision: true, obstacleCollision: true, singularity: avoidSingularity };
  const ctxFor = (attached) => createSafetyContext(robot, { features, thresholds, obstacles: others, floor, tool, attached, physicsMode: true });
  const toPose = (T) => ({ type: 'pose', pos: origin(T), rpy: rotationToRPY(T) });
  const tcpOf = (q) => multiply(forwardKinematics(robot, q).frames[6], toolMatrix(L));

  // 직선 구간: TCP 직선 보간 후 세분 검사(실행 시 기준 여유거리)
  const linear = (ctx, qa, T, stage) => {
    const res = linearMove(robot, qa, T, { toolLengthMm: L });
    if (!res.ok) return { error: fail(stage, res.message, res.reason === 'ik' ? 'ik-failed' : 'linear') };
    const pts = res.trajectory.points;
    for (let k = 1; k < pts.length; k++) {
      if (!motionValid(ctx, pts[k - 1], pts[k], (e) => e.violations.length === 0)) {
        const e = evaluatePose(ctx, pts[k]);
        const what = e.violations.map((v) => v.key).join(', ');
        return { error: fail(stage, `직선 경로에 충돌/특이점이 있습니다 (${what || '구간 검사'})`, 'collision') };
      }
    }
    return { tr: res.trajectory, q: pts.at(-1) };
  };

  // ---- 파지 자세·접근점 ----
  const g = graspPose(spec, object, graspDir, tcpOf(q0), thresholds.obstacleMarginMm);
  if (g.error) return fail('파지점', g.error, 'grasp');
  const Tpick = g.T;
  const TpickApp = backOff(Tpick, approachMm);

  // ① 현재 → 파지 접근점
  const r1 = await plan({ start: q0, goal: toPose(TpickApp), obstacles: others, tool, attached: null, physicsMode: true });
  if (!r1.ok) return fail('파지 접근점 이동', r1.message, r1.reason);
  const qPickApp = r1.path.at(-1);
  // ② 직선 하강
  const ctxPick = ctxFor(null);
  const s2 = linear(ctxPick, qPickApp, Tpick, '파지 하강');
  if (s2.error) return s2.error;
  const qPick = s2.q;
  // ③ 파지: 플랜지 기준 물체 상대 자세
  const T6pick = forwardKinematics(robot, qPick).frames[6];
  const rel = multiply(invertRigid(T6pick), poseMatrix(object.R, object.pos));
  const held = { id: object.id, type: object.type, size: object.size.slice(), rel, ignore: [] };
  // ④ 직선 상승: 집을 때 이미 맞닿아 있던 받침(바닥·아래 물체)은 이 구간에서 제외 (실행 중에는 떨어지면 다시 검사)
  const touching = evaluatePose(ctxFor(held), qPick).obstacle?.hits.filter((h) => h.link === 9).map((h) => h.obstacleId) ?? [];
  const s4 = linear(ctxFor({ ...held, ignore: [...new Set(touching)] }), qPick, TpickApp, '파지 상승');
  if (s4.error) return s4.error;
  const qPickUp = s4.q;

  // ---- 놓기점: 파지 물체(보수적 캡슐)가 바닥·물체 여유거리 안이면 위로 올린다 ----
  const compiled = compileObstacles(others.filter((o) => o.visible !== false));
  const placeClear = (T) => {
    const T6 = multiply(T, inverseToolMatrix(L));
    const segs = [...toolSegments(spec, T6, g.widthMm), attachedSegment(held, T6)].filter((s) => s.link !== 8); // 물리 모드: 손가락은 제외
    return !checkObstacleCollision(segs, compiled, thresholds.obstacleMarginMm + 1, { floor }).hit;
  };
  let raised = 0;
  let Tplace = placeT;
  while (!placeClear(Tplace)) {
    raised += PLACE_RAISE_STEP_MM;
    if (raised > PLACE_RAISE_MAX_MM) return fail('놓기점', '파지한 물체가 바닥·다른 물체와 겹칩니다. 놓을 위치를 옮기세요.', 'goal-collision');
    Tplace = backOff(placeT, raised);
  }
  const TplaceApp = backOff(Tplace, approachMm);

  // ⑤ 파지 접근점 → 놓기 접근점 (파지 물체를 로봇 형상에 포함)
  const r5 = await plan({ start: qPickUp, goal: toPose(TplaceApp), obstacles: others, tool, attached: held, physicsMode: true });
  if (!r5.ok) return fail('놓기 접근점 이동', r5.message, r5.reason);
  const qPlaceApp = r5.path.at(-1);
  // ⑥ 직선 하강 (파지 물체 포함)
  const s6 = linear(ctxFor(held), qPlaceApp, Tplace, '놓기 하강');
  if (s6.error) return s6.error;
  const qPlace = s6.q;
  // ⑧ 직선 상승 (놓은 물체는 손가락 사이에 있으므로 검사에서 제외)
  const s8 = linear(ctxPick, qPlace, TplaceApp, '놓기 상승');
  if (s8.error) return s8.error;

  const tr1 = pathTrajectory(robot, r1.path, r1.blends);
  const tr5 = pathTrajectory(robot, r5.path, r5.blends);
  const steps = [
    // 계획은 열린 손가락을 전제로 검사한다 → 시작할 때 연다 (4-1, M-3)
    { kind: 'grip', cmd: 'open', label: '그리퍼 열기', objectId: object.id },
    { kind: 'move', label: '파지 접근점 이동', trajectory: tr1 },
    { kind: 'move', label: '파지 하강', trajectory: s2.tr },
    { kind: 'grip', cmd: 'close', label: '파지', objectId: object.id, objectPos: object.pos.slice() },
    { kind: 'move', label: '파지 상승', trajectory: s4.tr },
    { kind: 'move', label: '놓기 접근점 이동', trajectory: tr5 },
    { kind: 'move', label: '놓기 하강', trajectory: s6.tr },
    { kind: 'grip', cmd: 'open', label: '놓기', objectId: object.id },
    { kind: 'move', label: '놓기 상승', trajectory: s8.tr },
  ];
  // 경유점 (표시·Waypoint 저장): A, ①의 중간점, 파지 접근점, 파지점(닫기), 파지 접근점, ⑤의 중간점, 놓기 접근점, 놓기점(열기), 끝(B)
  const vertices = [
    ...r1.path.map((q, i) => ({ q, kind: i === 0 ? 'start' : 'via' })),
    { q: qPick, kind: 'pick' },
    { q: qPickUp, kind: 'via' },
    ...r5.path.slice(1).map((q) => ({ q, kind: 'via' })),
    { q: qPlace, kind: 'place' },
    { q: s8.q, kind: 'end' },
  ];
  vertices.forEach((v, i) => (v.label = v.kind === 'start' ? 'A' : v.kind === 'end' ? 'B' : String(i)));
  const expectedObjectPos = origin(multiply(forwardKinematics(robot, qPlace).frames[6], rel));
  return {
    ok: true,
    steps,
    vertices,
    trajectory: concatTrajectories(steps.filter((s) => s.kind === 'move').map((s) => s.trajectory)),
    placeRaisedMm: raised,
    expectedObjectPos,
    rel,
  };
}
