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

// 드로스 스키머 (PRD_v.1.1.1 FR-27): 수직 봉 + 사각 스쿱(바닥판·뒤/좌우 턱, 앞쪽(+X)은 열림). 개폐 없음.
// 플랜지 좌표계: 봉은 z = 0 ~ lengthMm, 바닥판 윗면 중심 = TCP(z = lengthMm), 턱은 바닥판 위(플랜지 쪽)로 lipMm 높이.
export const SKIMMER_SPEC = {
  kind: 'skimmer', lengthMm: 700, rodDiaMm: 50, plateXMm: 360, plateYMm: 360, plateThickMm: 10, lipMm: 80, wallMm: 10,
  // 그리퍼 공통 필드 (레버암·패널 표시용): 개폐가 없으므로 벌림 0
  maxOpenMm: 0, fingerThickMm: 0, fingerWidthMm: 0, bodyDiaMm: 50, bodyHeightMm: 0, actuationS: 0.3, maxPayloadKg: 60,
};

// 측면 로봇(소형·협동 로봇)용 툴 (v1.1.1 FR-31~33)
// 모드 1(제거): 작은 스키머 — 대형용과 같은 구조, 치수만 작다
export const SKIMMER_SMALL_SPEC = {
  ...SKIMMER_SPEC, lengthMm: 350, rodDiaMm: 30, plateXMm: 200, plateYMm: 200, plateThickMm: 6, lipMm: 50, wallMm: 6, bodyDiaMm: 30, maxPayloadKg: 5,
};
// 모드 2(보조 밀기): 밀대(Rake) — 수직 봉 끝에 가로 날. 툴 X = 미는 방향(날의 두께 방향), 툴 Y = 날 폭 방향.
// TCP = 날 아래 끝 중심(z = lengthMm). 날은 z = lengthMm − bladeHMm ~ lengthMm (플랜지 쪽 = 위)
export const RAKE_SPEC = {
  kind: 'rake', lengthMm: 350, rodDiaMm: 30, bladeWMm: 300, bladeHMm: 120, bladeTMm: 8,
  maxOpenMm: 0, fingerThickMm: 0, fingerWidthMm: 0, bodyDiaMm: 30, bodyHeightMm: 0, actuationS: 0.3, maxPayloadKg: 5,
};

// 파지 폭 판정 공통 기준 (v1.1.1, m-9): 물체 폭이 min(현재 벌림, 최대 벌림) + 이 값 이하일 때만 손가락 사이에 들어간다
export const GRASP_WIDTH_TOL_MM = 1;
/** 손가락 사이에 들어가는 폭인가 (수동 닫기·Pick & Place 공통) */
export const fitsBetweenFingers = (widthMm, openingMm, spec) =>
  widthMm <= Math.min(openingMm, spec.maxOpenMm) + GRASP_WIDTH_TOL_MM && widthMm <= spec.maxOpenMm;

/** 툴이 플랜지에서 가장 멀리 나가는 거리 (세분 검사 레버암 상한용, mm) */
export function toolExtentMm(spec) {
  if (spec.kind === 'skimmer') return spec.lengthMm + spec.plateThickMm + Math.hypot(spec.plateXMm, spec.plateYMm) / 2;
  if (spec.kind === 'rake') return spec.lengthMm + Math.hypot(spec.bladeWMm / 2, spec.bladeTMm / 2);
  return spec.lengthMm + Math.max(spec.bodyDiaMm / 2, spec.maxOpenMm / 2 + spec.fingerThickMm);
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
  if (spec.kind === 'skimmer') return skimmerSegments(spec, T6);
  if (spec.kind === 'rake') return rakeSegments(spec, T6);
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

/**
 * 스키머 캡슐 (안전 검사용, 모두 link 7 = 툴): 봉 1개 + 바닥판·턱을 덮는 X방향 캡슐 3개(보수적).
 * 캡슐 반경 = max(판 폭/6, 턱 높이) → 턱 끝(플랜지 쪽)과 바닥판 아랫면을 모두 덮는다.
 */
function skimmerSegments(spec, T6) {
  const L = spec.lengthMm, hx = spec.plateXMm / 2, hy = spec.plateYMm / 2;
  const rr = spec.rodDiaMm / 2;
  const r = Math.max(hy / 3, spec.lipMm, spec.plateThickMm);
  const x = Math.max(0, hx - r);
  const yOff = Math.max(0, hy - r);
  const zc = L; // 바닥판 윗면(TCP) 높이 — 반경 r로 턱 끝(L − lipMm)과 바닥판 아랫면(L + 두께)을 모두 덮는다
  const segs = [{ link: 7, part: 'rod', a: apply(T6, [0, 0, rr]), b: apply(T6, [0, 0, L - spec.lipMm]), r: rr, name: '스키머 봉' }];
  for (const y of [-yOff, 0, yOff]) {
    segs.push({ link: 7, part: 'plate', a: apply(T6, [-x, y, zc]), b: apply(T6, [x, y, zc]), r, name: '스키머 스쿱' });
  }
  return segs;
}

/**
 * 스키머 스쿱의 물리 형상 (박스 4개: 바닥판, 뒤 턱, 좌·우 턱). 운동학 바디로 드로스를 떠서 옮긴다.
 * @returns [{ box: { center(mm), R(row-major 3x3), half(mm) } }]
 */
export function skimmerBoxes(spec, T6) {
  const L = spec.lengthMm, hx = spec.plateXMm / 2, hy = spec.plateYMm / 2, t = spec.wallMm, h = spec.lipMm;
  const R = [T6[0], T6[1], T6[2], T6[4], T6[5], T6[6], T6[8], T6[9], T6[10]];
  const local = [
    [[0, 0, L + spec.plateThickMm / 2], [hx, hy, spec.plateThickMm / 2]],
    [[-hx + t / 2, 0, L - h / 2], [t / 2, hy, h / 2]],
    [[0, hy - t / 2, L - h / 2], [hx, t / 2, h / 2]],
    [[0, -hy + t / 2, L - h / 2], [hx, t / 2, h / 2]],
  ];
  return local.map(([c, half]) => ({ link: 7, part: 'scoop', box: { center: apply(T6, c), R, half } }));
}

/** 밀대 캡슐 (link 7): 봉 + 날을 덮는 툴 Y방향 캡슐 1개 (반경 = 날 높이/2 → 날 두께 방향으로는 보수적) */
function rakeSegments(spec, T6) {
  const L = spec.lengthMm, rr = spec.rodDiaMm / 2;
  const r = spec.bladeHMm / 2;
  const y = Math.max(0, spec.bladeWMm / 2 - r);
  return [
    { link: 7, part: 'rod', a: apply(T6, [0, 0, rr]), b: apply(T6, [0, 0, L - spec.bladeHMm]), r: rr, name: '밀대 봉' },
    { link: 7, part: 'plate', a: apply(T6, [0, -y, L - r]), b: apply(T6, [0, y, L - r]), r, name: '밀대 날' },
  ];
}

/** 밀대 날의 물리 형상 (박스 1개) */
export function rakeBoxes(spec, T6) {
  const R = [T6[0], T6[1], T6[2], T6[4], T6[5], T6[6], T6[8], T6[9], T6[10]];
  return [{ link: 7, part: 'scoop', box: { center: apply(T6, [0, 0, spec.lengthMm - spec.bladeHMm / 2]), R, half: [spec.bladeTMm / 2, spec.bladeWMm / 2, spec.bladeHMm / 2] } }];
}

/** 툴 물리 형상: 스키머 = 스쿱 박스 4개, 밀대 = 날 박스 1개, 그 밖 = 없음(캡슐 사용) */
export function toolBoxes(spec, T6) {
  if (spec?.kind === 'skimmer') return skimmerBoxes(spec, T6);
  if (spec?.kind === 'rake') return rakeBoxes(spec, T6);
  return [];
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
    if (!fitsBetweenFingers(width, opening, spec)) continue; // 손가락 사이에 들어갈 수 없음 (m-9 공통 기준)
    if (Math.abs(lx) > (opening - width) / 2 + 1) continue; // 한쪽 손가락과 겹침
    if (Math.abs(ly) > (spec.fingerWidthMm + depthY) / 2) continue; // 손가락 폭 밖
    if (lz < spec.bodyHeightMm - depthZ / 2 || lz > spec.lengthMm + depthZ / 2) continue; // 손가락 길이 구간 밖
    const dist = Math.hypot(lx, ly, lz - spec.lengthMm);
    if (!best || dist < best.dist) best = { id: ob.id, widthMm: width, dist };
  }
  return best && { id: best.id, widthMm: best.widthMm };
}
