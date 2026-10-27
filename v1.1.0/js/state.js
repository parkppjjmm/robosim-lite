// 앱 상태 관리 + localStorage 영구 저장 (PRD 6.4, v1.1.0 저장 스키마 v2: PRD_v.1.1.0 6.4)
import { clampJoints, homeJoints } from './kinematics.js';
import { DEFAULT_PHYSICS, PHYSICS_LIMITS } from './physics.js';
import { sanitizeGripperOverride } from './gripper.js';

export const STORAGE_KEY = 'robosim-lite:v1';
const BACKUP_KEY = 'robosim-lite:backup';
export const SCHEMA_VERSION = 2;
const SAVE_DEBOUNCE_MS = 300;
const MAX_ALARM_LOG = 100;

// schemaVersion n → n+1 변환 함수. 스키마가 바뀌면 여기에 추가한다.
// 새 필드의 기본값은 sanitize()가 채우므로, 여기서는 구조가 바뀌는 부분만 처리한다.
const MIGRATIONS = {
  // v1(v1.0.0) → v2(v1.1.0): 시뮬레이션 모드·중력(settings), 물체 물성(obstacles[].physics), 작업 셀(cell) 추가.
  // v1.0.0 데이터는 고정 모드 + 기본 물성으로 열려서 v1.0.0과 똑같이 동작한다.
  1: (d) => ({ ...d, schemaVersion: 2, settings: { ...(d.settings ?? {}), simMode: 'static' } }),
};

let catalog = null;
let state = null;
let saveTimer = null;
const listeners = new Set();
const saveListeners = new Set();

export const DEFAULT_FEATURES = {
  selfCollision: false,
  obstacleCollision: false,
  singularity: false,
  autoPathPlanning: false,
};

export const DEFAULT_THRESHOLDS = {
  selfMarginMm: 10,
  obstacleMarginMm: 20,
  wristDeg: 5,
  shoulderMm: 50,
  elbowDeg: 3,
};

export const DEFAULT_SETTINGS = {
  floorEnabled: true, // 바닥(z=0) 장애물 검사
  muted: false, // 알람음 음소거
  playMode: 'joint', // Waypoint 재생 보간: 'joint' | 'linear'
  speedPct: 100, // 재생 속도 10~200%
  cartFrame: 'world', // 직교 조그 기준: 'world' | 'tool'
  cartStepMm: 10,
  cartStepDeg: 5,
  theme: 'dark', // UI 테마: 'dark' | 'light'
  collapsed: {}, // 우측 패널 섹션 접힘 상태 { [sectionKey]: true }
  planAvoidSingularity: true, // 경로 계획 시 특이점 회피 (감지 토글과 별개)
  simMode: 'static', // 시뮬레이션 모드: 'static'(고정, v1.0.0 동작) | 'physics'(물리) — 전체 단위로만 선택
  gravity: [0, 0, -9.81], // 물리 모드 중력 (m/s², 로봇 좌표계 Z-up)
  // 그리퍼 (PRD_v.1.1.0 FR-21): overrides = { [robotId]: { lengthMm, ... } } — 크기별 기본값 위에 로봇별로 덮어쓴다
  gripper: { enabled: false, overrides: {} },
};


// 설정값 검증 규칙 (저장 데이터 복원 시 사용)
const SETTINGS_RULES = {
  floorEnabled: (v) => typeof v === 'boolean',
  muted: (v) => typeof v === 'boolean',
  playMode: (v) => v === 'joint' || v === 'linear',
  speedPct: (v) => Number.isFinite(v) && v >= 10 && v <= 200,
  cartFrame: (v) => v === 'world' || v === 'tool',
  cartStepMm: (v) => [1, 10, 50].includes(v),
  cartStepDeg: (v) => [1, 5, 15].includes(v),
  theme: (v) => v === 'dark' || v === 'light',
  collapsed: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((b) => typeof b === 'boolean'),
  planAvoidSingularity: (v) => typeof v === 'boolean',
  simMode: (v) => v === 'static' || v === 'physics',
  gravity: (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 50),
};

/** 그리퍼 설정 검증: 알 수 없는 로봇 id·범위 밖 값은 버린다 */
function sanitizeGripper(raw) {
  const out = { enabled: false, overrides: {} };
  if (!raw || typeof raw !== 'object') return out;
  out.enabled = raw.enabled === true;
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [id, o] of Object.entries(raw.overrides)) {
      if (!findRobot(id)) continue;
      const clean = sanitizeGripperOverride(o);
      if (Object.keys(clean).length) out.overrides[id] = clean;
    }
  }
  return out;
}

/** 물성 검증: 범위를 벗어나거나 형식이 다르면 기본값 */
export function sanitizePhysics(raw) {
  const out = { ...DEFAULT_PHYSICS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(PHYSICS_LIMITS)) {
    const v = raw[k];
    if (k === 'massKg' && v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export function findRobot(id) {
  return catalog.robots.find((r) => r.id === id) ?? null;
}

export function defaultCamera(robot) {
  const s = Math.max(robot.reachMm, 700);
  return { pos: [s * 1.6, s * 1.6, s * 1.25], target: [0, 0, s * 0.35] };
}

function createDefaultState() {
  const robot = catalog.robots[0];
  return {
    schemaVersion: SCHEMA_VERSION,
    selectedMaker: robot.maker,
    selectedRobotId: robot.id,
    joints: homeJoints(robot),
    features: { ...DEFAULT_FEATURES },
    thresholds: { ...DEFAULT_THRESHOLDS },
    settings: { ...DEFAULT_SETTINGS, gripper: { enabled: false, overrides: {} } }, // gripper는 중첩 객체 → 기본값과 공유하지 않도록 새로 만든다
    obstacles: [],
    waypoints: [],
    lastPlan: null,
    alarmLog: [],
    camera: defaultCamera(robot),
    cell: { conveyors: [], feeders: [], sensors: [] }, // v1.1.1 작업 셀 (v1.1.0은 빈 값 유지)
  };
}

const OBSTACLE_TYPES = ['box', 'sphere', 'cylinder'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** 저장 데이터 검증: 알려진 키만 타입 확인 후 기본값 위에 덮어쓴다. */
function sanitize(raw) {
  const s = createDefaultState();
  if (typeof raw !== 'object' || raw === null) return s;

  const robot = findRobot(raw.selectedRobotId);
  if (robot) {
    s.selectedRobotId = robot.id;
    s.selectedMaker = robot.maker;
    s.joints = homeJoints(robot);
    s.camera = defaultCamera(robot);
  }
  if (catalog.makers.some((m) => m.id === raw.selectedMaker)) s.selectedMaker = raw.selectedMaker;

  const current = findRobot(s.selectedRobotId);
  if (Array.isArray(raw.joints) && raw.joints.length === 6 && raw.joints.every(isNum)) {
    s.joints = clampJoints(current, raw.joints);
  }
  if (raw.features && typeof raw.features === 'object') {
    for (const k of Object.keys(DEFAULT_FEATURES)) {
      if (typeof raw.features[k] === 'boolean') s.features[k] = raw.features[k];
    }
  }
  if (raw.thresholds && typeof raw.thresholds === 'object') {
    for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
      if (isNum(raw.thresholds[k]) && raw.thresholds[k] >= 0) s.thresholds[k] = raw.thresholds[k];
    }
  }
  if (raw.settings && typeof raw.settings === 'object') {
    for (const [k, valid] of Object.entries(SETTINGS_RULES)) {
      if (valid(raw.settings[k])) s.settings[k] = raw.settings[k];
    }
    s.settings.gripper = sanitizeGripper(raw.settings.gripper);
  }
  if (Array.isArray(raw.obstacles)) {
    s.obstacles = raw.obstacles.filter(
      (o) =>
        o && typeof o.id === 'string' && OBSTACLE_TYPES.includes(o.type) &&
        isVec3(o.pos) && isVec3(o.size) && o.size.every((v) => v > 0) && (o.rot === undefined || isVec3(o.rot)),
    ).map((o) => ({ name: o.id, rot: [0, 0, 0], visible: true, ...o, physics: sanitizePhysics(o.physics) }));
  }
  if (Array.isArray(raw.waypoints)) {
    s.waypoints = raw.waypoints
      .filter((w) => w && typeof w.id === 'string' && Array.isArray(w.joints) && w.joints.length === 6 && w.joints.every(isNum))
      // Waypoint는 관절값이라 로봇별로 의미가 다르다 → robotId로 소속 로봇을 기록
      .map((w) => {
        const owner = findRobot(w.robotId) ?? current;
        return { id: w.id, name: typeof w.name === 'string' ? w.name : w.id, robotId: owner.id, joints: clampJoints(owner, w.joints) };
      });
  }
  // 계획 결과: 경유점(관절값)만 저장하고 궤적은 복원 시 다시 계산한다
  // 경유점이 그 로봇의 관절 한계 밖이면 (손상/수정된 데이터) 계획 결과를 버린다
  const lp = raw.lastPlan;
  const lpRobot = lp && findRobot(lp.robotId);
  const withinLimits = (q) => lpRobot.jointLimitsDeg.every(([lo, hi], i) => q[i] >= lo - 1e-6 && q[i] <= hi + 1e-6);
  if (lpRobot && Array.isArray(lp.path) && lp.path.length >= 2 &&
      lp.path.every((q) => Array.isArray(q) && q.length === 6 && q.every(isNum) && withinLimits(q))) {
    // blends: 경유점별 모서리 블렌드 (없거나 형식이 다르면 0 = 경유점마다 정지)
    const blends = Array.isArray(lp.blends) && lp.blends.length === lp.path.length && lp.blends.every((b) => isNum(b) && b >= 0)
      ? lp.blends : lp.path.map(() => 0);
    s.lastPlan = { robotId: lp.robotId, path: lp.path, blends, stats: typeof lp.stats === 'object' && lp.stats ? lp.stats : {}, createdAt: lp.createdAt };
  }
  if (Array.isArray(raw.alarmLog)) {
    const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    s.alarmLog = raw.alarmLog
      .filter((e) => e && typeof e.time === 'string' && isStrArr(e.types) && isStrArr(e.messages))
      .map((e) => ({ time: e.time, types: e.types, messages: e.messages }))
      .slice(-MAX_ALARM_LOG);
  }
  if (raw.camera && isVec3(raw.camera.pos) && isVec3(raw.camera.target)) {
    s.camera = { pos: raw.camera.pos, target: raw.camera.target };
  }
  if (raw.cell && typeof raw.cell === 'object') {
    for (const k of Object.keys(s.cell)) if (Array.isArray(raw.cell[k])) s.cell[k] = raw.cell[k];
  }
  return s;
}

function migrate(raw) {
  let data = raw;
  let v = data.schemaVersion;
  while (v < SCHEMA_VERSION && MIGRATIONS[v]) {
    data = MIGRATIONS[v](data);
    v = data.schemaVersion;
  }
  return v === SCHEMA_VERSION ? data : null;
}

/**
 * 카탈로그(robots.json)를 받아 저장된 상태를 복원한다.
 * @returns {{ state: object, notice: string | null }} notice는 복구/초기화 시 사용자 안내 문구
 */
export function initState(robotCatalog) {
  catalog = robotCatalog;
  let notice = null;
  let text = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    notice = '브라우저 저장소에 접근할 수 없어 이번 세션의 변경 내용은 저장되지 않습니다.';
  }

  if (text == null) {
    state = createDefaultState();
  } else {
    try {
      const raw = JSON.parse(text);
      const migrated = Number.isInteger(raw?.schemaVersion) ? migrate(raw) : null;
      if (!migrated) throw new Error(`지원하지 않는 schemaVersion: ${raw?.schemaVersion}`);
      state = sanitize(migrated);
    } catch (err) {
      console.warn('[state] 저장 데이터 복원 실패, 기본값으로 시작합니다.', err);
      try {
        localStorage.setItem(BACKUP_KEY, text);
      } catch { /* 백업 실패는 무시 */ }
      state = createDefaultState();
      notice = '저장 데이터가 손상되었거나 호환되지 않아 기본값으로 시작합니다. (원본은 백업됨)';
    }
  }
  return { state, notice };
}

export const getState = () => state;

/**
 * 상태 갱신. patch는 객체(얕은 병합) 또는 (state) => patch 함수.
 * 변경된 최상위 키 목록과 함께 구독자에게 알린다.
 */
export function setState(patch) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  if (!p) return;
  state = { ...state, ...p };
  const keys = Object.keys(p);
  listeners.forEach((fn) => fn(state, keys));
  scheduleSave();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 저장 상태 알림: 'pending' | 'saved' | 'error' */
export function onSaveStatus(fn) {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}

function emitSave(status, detail) {
  saveListeners.forEach((fn) => fn(status, detail));
}

function scheduleSave() {
  emitSave('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

/** 대기 중인 저장을 즉시 수행 (페이지 이탈 시에도 호출) */
export function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    emitSave('saved');
  } catch (err) {
    console.error('[state] 저장 실패', err);
    emitSave('error', err);
  }
}

// debounce 대기 중 새로고침/탭 닫기 시 데이터 손실 방지
addEventListener('pagehide', () => saveTimer && flushSave());
addEventListener('beforeunload', () => saveTimer && flushSave());

/** 상태 전체 교체 후 모든 키 변경으로 알리고 즉시 저장 */
function replaceState(next) {
  state = next;
  listeners.forEach((fn) => fn(state, Object.keys(state)));
  flushSave();
}

/** 저장 데이터 삭제 → 기본값 (PRD FR-16 초기화) */
export function resetState() {
  replaceState(createDefaultState());
}

/** 현재 상태를 JSON 문자열로 (PRD FR-16 내보내기) */
export function exportState() {
  return JSON.stringify(state, null, 2);
}

/**
 * 내보낸 JSON으로 상태 복원 (PRD FR-16 가져오기). 로드 시와 같은 migrate/sanitize를 거친다.
 * @throws {Error} 형식이 맞지 않으면 (상태는 바뀌지 않음)
 */
export function importState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 아닙니다.');
  }
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.schemaVersion)) {
    throw new Error('RoboSim Lite 데이터 파일이 아닙니다 (schemaVersion 없음).');
  }
  const migrated = migrate(raw);
  if (!migrated) throw new Error(`지원하지 않는 schemaVersion: ${raw.schemaVersion}`);
  replaceState(sanitize(migrated));
}
