// 평행 2지 그리퍼 (PRD_v.1.1.0 FR-21, FR-22). DOM 비의존 — 안전 검사·플래너 Worker·Node 테스트에서 재사용.
// 그리퍼 좌표계 = 플랜지 좌표계: Z = 접근 방향, X = 손가락이 벌어지는 방향, Y = 손가락 폭 방향.
// 몸체: 플랜지(z = 0) ~ z = bodyH, 손가락: z = bodyH ~ z = length. TCP = 손가락 끝 중심 (z = length).

// 로봇 크기(sizeClass)별 기본 치수 (결정 1: 크기별 3종 + 사용자 수정)
export const GRIPPER_DEFAULTS = {
  small: { lengthMm: 100, maxOpenMm: 60, fingerThickMm: 10, fingerWidthMm: 16, bodyDiaMm: 50, bodyHeightMm: 40, actuationS: 0.25, maxPayloadKg: 5 },
  medium: { lengthMm: 150, maxOpenMm: 120, fingerThickMm: 15, fingerWidthMm: 25, bodyDiaMm: 80, bodyHeightMm: 60, actuationS: 0.3, maxPayloadKg: 20 },
  large: { lengthMm: 250, maxOpenMm: 250, fingerThickMm: 25, fingerWidthMm: 45, bodyDiaMm: 140, bodyHeightMm: 100, actuationS: 0.5, maxPayloadKg: 150 },
};

// 사용자 입력 범위 (PRD FR-21)
export const GRIPPER_LIMITS = {
  lengthMm: [30, 600],
  maxOpenMm: [10, 400],
  fingerThickMm: [3, 100],
  fingerWidthMm: [3, 100],
  bodyDiaMm: [10, 400],
  bodyHeightMm: [5, 400],
  actuationS: [0.05, 3],
  maxPayloadKg: [0.1, 500],
};

export const GRIPPER_FIELDS = [
  ['lengthMm', '길이 (TCP 오프셋)', 'mm'],
  ['maxOpenMm', '최대 벌림 폭', 'mm'],
  ['fingerThickMm', '손가락 두께', 'mm'],
  ['fingerWidthMm', '손가락 폭', 'mm'],
  ['bodyDiaMm', '몸체 지름', 'mm'],
  ['bodyHeightMm', '몸체 높이', 'mm'],
  ['actuationS', '개폐 시간', 's'],
  ['maxPayloadKg', '최대 파지 질량', 'kg'],
];

/** 로봇에 적용할 그리퍼 치수: 크기별 기본값 위에 로봇별 사용자 수정값을 덮어쓴다 */
export function gripperSpec(robot, overrides = {}) {
  const base = GRIPPER_DEFAULTS[robot.sizeClass] ?? GRIPPER_DEFAULTS.medium;
  return { ...base, ...sanitizeGripperOverride(overrides[robot.id]) };
}

/** 사용자 수정값 검증: 범위 안의 숫자만 남긴다 */
export function sanitizeGripperOverride(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(GRIPPER_LIMITS)) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

/** 플랜지 → TCP 변환 (Z축 방향 lengthMm 이동), 4x4 row-major */
export function toolMatrix(lengthMm) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, lengthMm, 0, 0, 0, 1];
}

/** TCP → 플랜지 변환 (toolMatrix의 역) */
export function inverseToolMatrix(lengthMm) {
  return toolMatrix(-lengthMm);
}

/** 플랜지 좌표계의 점 → 월드 (T: 4x4 row-major) */
function apply(T, [x, y, z]) {
  return [
    T[0] * x + T[1] * y + T[2] * z + T[3],
    T[4] * x + T[5] * y + T[6] * z + T[7],
    T[8] * x + T[9] * y + T[10] * z + T[11],
  ];
}

/**
 * 그리퍼 캡슐 (안전 검사·물리 바디용). link 7 = 몸체, link 8 = 손가락(좌·우).
 * @param T6 플랜지 자세 (4x4), opening 현재 벌림 폭 (손가락 안쪽 면 사이, mm)
 */
export function toolSegments(spec, T6, opening) {
  const { bodyDiaMm, bodyHeightMm, fingerThickMm, lengthMm } = spec;
  const rb = bodyDiaMm / 2;
  const z0 = Math.min(rb, bodyHeightMm / 2), z1 = Math.max(bodyHeightMm - rb, bodyHeightMm / 2);
  const rf = fingerThickMm / 2;
  const fz0 = bodyHeightMm + rf, fz1 = Math.max(fz0, lengthMm - rf);
  const x = opening / 2 + rf;
  return [
    { link: 7, a: apply(T6, [0, 0, z0]), b: apply(T6, [0, 0, z1]), r: rb, name: '그리퍼 몸체' },
    { link: 8, a: apply(T6, [x, 0, fz0]), b: apply(T6, [x, 0, fz1]), r: rf, name: '그리퍼 손가락' },
    { link: 8, a: apply(T6, [-x, 0, fz0]), b: apply(T6, [-x, 0, fz1]), r: rf, name: '그리퍼 손가락' },
  ];
}

/** 물체(OBB/구/원기둥)를 월드 방향 axis로 투영한 전체 폭 (mm). R: 물체 회전(row-major 3x3) */
export function objectWidthAlong(ob, R, axis) {
  if (ob.type === 'sphere') return ob.size[0];
  const [sx, sy, sz] = ob.size;
  // 로컬 축 i의 월드 방향 = R의 i번째 열
  const proj = (i) => Math.abs(R[i] * axis[0] + R[3 + i] * axis[1] + R[6 + i] * axis[2]);
  if (ob.type === 'cylinder') {
    // 원기둥 축(로컬 Z) 방향 성분 + 원형 단면의 투영 폭
    const c = proj(2);
    return sz * c + sx * Math.sqrt(Math.max(0, 1 - c * c));
  }
  return sx * proj(0) + sy * proj(1) + sz * proj(2);
}

/**
 * 파지 대상 찾기 (FR-22): 손가락 사이 영역에 중심이 있고, 손가락 방향 폭이 현재 벌림 폭 이하인 물체 중 가장 가까운 것.
 * @param objects [{ id, type, size, pos(mm), R }]
 * @returns {{ id, widthMm } | null}
 */
export function findGraspCandidate(spec, T6, opening, objects) {
  const xg = [T6[0], T6[4], T6[8]];
  const yg = [T6[1], T6[5], T6[9]];
  const zg = [T6[2], T6[6], T6[10]];
  const o = [T6[3], T6[7], T6[11]];
  let best = null;
  for (const ob of objects) {
    const d = [ob.pos[0] - o[0], ob.pos[1] - o[1], ob.pos[2] - o[2]];
    const lx = d[0] * xg[0] + d[1] * xg[1] + d[2] * xg[2];
    const ly = d[0] * yg[0] + d[1] * yg[1] + d[2] * yg[2];
    const lz = d[0] * zg[0] + d[1] * zg[1] + d[2] * zg[2];
    const width = objectWidthAlong(ob, ob.R, xg);
    const depthY = objectWidthAlong(ob, ob.R, yg);
    const depthZ = objectWidthAlong(ob, ob.R, zg);
    if (width > opening + 1) continue; // 손가락 사이에 들어갈 수 없음
    if (Math.abs(lx) > (opening - width) / 2 + 1) continue; // 한쪽 손가락과 겹침
    if (Math.abs(ly) > (spec.fingerWidthMm + depthY) / 2) continue; // 손가락 폭 밖
    if (lz < spec.bodyHeightMm - depthZ / 2 || lz > spec.lengthMm + depthZ / 2) continue; // 손가락 길이 구간 밖
    const dist = Math.hypot(lx, ly, lz - spec.lengthMm);
    if (!best || dist < best.dist) best = { id: ob.id, widthMm: width, dist };
  }
  return best && { id: best.id, widthMm: best.widthMm };
}
