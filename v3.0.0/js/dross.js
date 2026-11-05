// 드로스 제거 작업 셀 (PRD_v.1.1.1 FR-25~FR-30). DOM 비의존 — 브라우저(main.js, 플래너 Worker 사용)와 Node 테스트에서 함께 쓴다.
// 용융 아연 도금 라인(CGL)의 아연 포트(Zinc Pot)를 단순화한 환경:
//   아연 포트(벽 4면) + 욕면(수면 z = BATH_Z_MM, 부력) + 강판·스나우트(Strip/Snout) + 드로스 박스(Dross Box)
//   드로스 = 욕면에 떠 있는 작은 구(입자). 로봇은 스키머(수직 봉 + 사각 스쿱)로 드로스를 떠서 드로스 박스에 버린다.
// 좌표: 로봇 베이스 기준 Z-up, mm. 로봇은 원점에서 +X 방향의 포트를 마주 본다(대형 로봇, 도달거리 2.4 m 이상).
import { forwardKinematics, multiply, poseMatrix, origin, rotationToRPY, solveIK } from './kinematics.js';
import { toolMatrix, inverseToolMatrix } from './gripper.js';
import { createSafetyContext, evaluatePose, motionValid } from './safety.js';
import { linearMove, jointMove, pathTrajectory, concatTrajectories } from './trajectory.js';

// ---- 셀 배치 (mm) ----
export const BATH_Z_MM = 700; // 욕면 높이
export const POT = { x0: 1100, x1: 3700, y0: -900, y1: 900, wall: 100, rimZ: 800 }; // 안쪽 치수, 벽 두께, 테두리 높이
export const SNOUT = { x0: 2300, x1: 2500, z0: 560, z1: 1200 }; // 강판·스나우트 영역 (포트 폭 전체를 가로지름)
export const BIN = { x0: 250, x1: 950, y0: -1650, y1: -1050, h: 550, wall: 40 }; // 드로스 박스 바깥 치수
/** 로봇 쪽 작업 영역 (포트 안쪽 ~ 스나우트 앞) */
export const WORK_ZONE = { x0: POT.x0, x1: SNOUT.x0, y0: POT.y0, y1: POT.y1 };
export const FAR_ZONE = { x0: SNOUT.x1, x1: POT.x1, y0: POT.y0, y1: POT.y1 };
export const DROSS_MIN_REACH_MM = 2400; // 이 배치를 쓸 수 있는 로봇 도달거리 (대형)

// ---- 측면 로봇 (v1.1.1 FR-31~34): 포트 좌·우 벽 바깥 받침대 위에 소형·협동 로봇을 1대씩 ----
// side: +1 = 왼쪽(+Y), −1 = 오른쪽(−Y). yaw = 로봇 정면(+X 로컬)이 포트 안쪽을 보도록 Z축 회전(deg)
export const SIDE_SLOTS = {
  left: { id: 'left', label: '왼쪽', side: 1, base: [1700, 1250, 800], yaw: -90 },
  right: { id: 'right', label: '오른쪽', side: -1, base: [1700, -1250, 800], yaw: 90 },
};
export const PEDESTAL = { sx: 400, sy: 400 }; // 받침대 (높이 = 슬롯 base Z)
// 측면 로봇 전용 드로스 박스 (모드 1에서 사용). 380 × 380, 높이 450. 왼쪽 기준(오른쪽은 Y 대칭).
// X 위치는 로봇 베이스에서 +X로 binDist(mm) 떨어진 곳 — 로봇마다 덤프가 되는 거리가 달라 설치할 때 고른다(cell-robot.js pickSideBinDist)
export const SIDE_BIN = { half: 190, y0: 1080, y1: 1460, h: 450, wall: 30 };
export const SIDE_BIN_DISTS = [750, 650, 550, 850, 450];
// 로봇별 측면 박스 거리 (cell-robot.js pickSideBinDist로 미리 계산한 값, 좌·우 같음. null = 모드 1 불가).
// 다시 계산: tests/cell-robots.mjs가 표의 값과 계산 결과가 같은지 확인한다. 표에 없는 로봇은 계산 없이 750을 쓴다
export const SIDE_BIN_TABLE = {
  'abb-irb1200-5-09': 750, 'kuka-kr6-r900': 750, 'fanuc-lrmate200id': 550, 'nachi-mz07': 550,
  'ur-ur5e': 650, 'ur-ur10e': 750, 'ur-ur20': 650,
};
export const sideBinDistFor = (robotId) => (robotId in SIDE_BIN_TABLE ? SIDE_BIN_TABLE[robotId] : SIDE_BIN_DISTS[0]);
// 측면 구역 경계 |y| (모드 1): 대형 로봇은 안쪽, 측면 로봇은 바깥 띠를 맡는다
export const SIDE_SPLIT_Y = 470;
export const SIDE_BUFFER_MM = 60; // 구역 경계 양쪽 여유
/** 슬롯의 측면 박스 (월드 좌표) */
export function sideBin(slot, binDist = SIDE_BIN_DISTS[0]) {
  const S = SIDE_SLOTS[slot];
  const [y0, y1] = S.side > 0 ? [SIDE_BIN.y0, SIDE_BIN.y1] : [-SIDE_BIN.y1, -SIDE_BIN.y0];
  const cx = S.base[0] + binDist;
  return { x0: cx - SIDE_BIN.half, x1: cx + SIDE_BIN.half, y0, y1, h: SIDE_BIN.h, wall: SIDE_BIN.wall, id: slot };
}

// ---- 드로스·용융 아연 물성 ----
export const ZINC_DENSITY = 6600; // kg/m³ (용융 아연)
export const DROSS_DENSITY = 3800; // kg/m³ (상부 드로스·산화물 덩어리 근사 → 약 60% 잠김)
export const FLUID_DRAG = 10; // 1/s, 잠긴 비율에 비례하는 점성 저항
export const DROSS_DIAMETER_MM = [40, 90];
export const MAX_PARTICLES = 800;

// ---- 사용자 설정 (state.cell.dross) ----
export const DROSS_DEFAULTS = { enabled: false, count: 160, ratePerMin: 0, seed: 1, immersionMm: 60, sweepMmS: 120 };
// 측면 로봇 설정 (v1.1.1 FR-31): 슬롯별 { robotId(없으면 null), mode(1 제거 | 2 보조 밀기) }
export const SIDE_DEFAULTS = { left: { robotId: null, mode: 1 }, right: { robotId: null, mode: 1 } };
export const DROSS_LIMITS = { count: [0, 400], ratePerMin: [0, 120], seed: [1, 99999], immersionMm: [20, 75], sweepMmS: [30, 250] };
export const DROSS_FIELDS = [
  ['count', '초기 드로스 (작업 영역)', '개', 10],
  ['ratePerMin', '드로스 발생률', '개/분', 5],
  ['seed', '난수 시드 (배치 재현)', '', 1],
  ['immersionMm', '스쿱 잠김 깊이', 'mm', 5],
  ['sweepMmS', '스윕 속도', 'mm/s', 10],
];

/** 저장 데이터 검증: 범위 밖·형식 오류는 기본값 */
export function sanitizeDross(raw, robotOk = () => true) {
  const out = { ...DROSS_DEFAULTS, sides: { left: { ...SIDE_DEFAULTS.left }, right: { ...SIDE_DEFAULTS.right } } };
  if (!raw || typeof raw !== 'object') return out;
  for (const slot of ['left', 'right']) {
    const v = raw.sides?.[slot];
    if (!v || typeof v !== 'object') continue;
    if (typeof v.robotId === 'string' && robotOk(v.robotId)) out.sides[slot].robotId = v.robotId;
    if (v.mode === 1 || v.mode === 2) out.sides[slot].mode = v.mode;
  }
  out.enabled = raw.enabled === true;
  for (const [k, [lo, hi]] of Object.entries(DROSS_LIMITS)) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = k === 'seed' || k === 'count' ? Math.round(v) : v;
  }
  return out;
}

/** 이 로봇으로 드로스 셀을 쓸 수 있는가 */
export const drossRobotOk = (robot) => robot.reachMm >= DROSS_MIN_REACH_MM;

const box = (id, name, center, size, extra = {}) => ({ id, name, type: 'box', pos: center, size, rot: [0, 0, 0], visible: true, fixture: true, ...extra });

/**
 * 고정 설비 목록 (안전 검사·경로 계획·물리의 고정 바디). id는 'cell:'로 시작한다.
 * part: 화면 표시용 분류 (pot | snout | bin)
 */
export function drossFixtures(sides = {}) {
  const { x0, x1, y0, y1, wall: w, rimZ } = POT;
  const extra = [];
  for (const slot of Object.keys(SIDE_SLOTS)) {
    if (!sides[slot]?.robotId) continue;
    const S = SIDE_SLOTS[slot];
    extra.push(box(`cell:ped-${slot}`, `${S.label} 측면 로봇 받침대`, [S.base[0], S.base[1], S.base[2] / 2], [PEDESTAL.sx, PEDESTAL.sy, S.base[2]], { part: 'pedestal', slot }));
    const b = sideBin(slot, sides[slot].binDist), bw = b.wall, bcx = (b.x0 + b.x1) / 2, bcy = (b.y0 + b.y1) / 2, bdx = b.x1 - b.x0, bdy = b.y1 - b.y0;
    const nm = `${S.label} 드로스 박스`;
    extra.push(
      box(`cell:sbin-${slot}-floor`, nm, [bcx, bcy, bw / 2], [bdx, bdy, bw], { part: 'bin', slot }),
      box(`cell:sbin-${slot}-x0`, nm, [b.x0 + bw / 2, bcy, b.h / 2], [bw, bdy, b.h], { part: 'bin', slot }),
      box(`cell:sbin-${slot}-x1`, nm, [b.x1 - bw / 2, bcy, b.h / 2], [bw, bdy, b.h], { part: 'bin', slot }),
      box(`cell:sbin-${slot}-y0`, nm, [bcx, b.y0 + bw / 2, b.h / 2], [bdx, bw, b.h], { part: 'bin', slot }),
      box(`cell:sbin-${slot}-y1`, nm, [bcx, b.y1 - bw / 2, b.h / 2], [bdx, bw, b.h], { part: 'bin', slot }),
    );
  }
  const cx = (x0 + x1) / 2, lenX = x1 - x0 + 2 * w;
  const b = BIN, bw = b.wall, bcx = (b.x0 + b.x1) / 2, bcy = (b.y0 + b.y1) / 2, bdx = b.x1 - b.x0, bdy = b.y1 - b.y0;
  return [
    box('cell:pot-near', '아연 포트 벽(앞)', [x0 - w / 2, 0, rimZ / 2], [w, y1 - y0 + 2 * w, rimZ], { part: 'pot' }),
    box('cell:pot-far', '아연 포트 벽(뒤)', [x1 + w / 2, 0, rimZ / 2], [w, y1 - y0 + 2 * w, rimZ], { part: 'pot' }),
    box('cell:pot-left', '아연 포트 벽(좌)', [cx, y1 + w / 2, rimZ / 2], [lenX, w, rimZ], { part: 'pot' }),
    box('cell:pot-right', '아연 포트 벽(우)', [cx, y0 - w / 2, rimZ / 2], [lenX, w, rimZ], { part: 'pot' }),
    box('cell:snout', '강판 · 스나우트', [(SNOUT.x0 + SNOUT.x1) / 2, 0, (SNOUT.z0 + SNOUT.z1) / 2], [SNOUT.x1 - SNOUT.x0, y1 - y0, SNOUT.z1 - SNOUT.z0], { part: 'snout' }),
    box('cell:bin-floor', '드로스 박스', [bcx, bcy, bw / 2], [bdx, bdy, bw], { part: 'bin' }),
    box('cell:bin-x0', '드로스 박스', [b.x0 + bw / 2, bcy, b.h / 2], [bw, bdy, b.h], { part: 'bin' }),
    box('cell:bin-x1', '드로스 박스', [b.x1 - bw / 2, bcy, b.h / 2], [bw, bdy, b.h], { part: 'bin' }),
    box('cell:bin-y0', '드로스 박스', [bcx, b.y0 + bw / 2, b.h / 2], [bdx, bw, b.h], { part: 'bin' }),
    box('cell:bin-y1', '드로스 박스', [bcx, b.y1 - bw / 2, b.h / 2], [bdx, bw, b.h], { part: 'bin' }),
    ...extra,
  ];
}

/** 집계용 드로스 박스 목록 (대형 + 있는 측면 박스) */
export function drossBins(sides = {}) {
  const out = [{ ...BIN, id: 'main' }];
  for (const slot of Object.keys(SIDE_SLOTS)) if (sides[slot]?.robotId) out.push(sideBin(slot, sides[slot].binDist));
  return out;
}

/** 물리 월드의 액체 욕 설정 (PhysicsWorld.setFluid) */
export const drossFluid = () => ({ zMm: BATH_Z_MM, bounds: [POT.x0, POT.x1, POT.y0, POT.y1], densityKgM3: ZINC_DENSITY, drag: FLUID_DRAG });

/** 재현 가능한 난수 (mulberry32) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inZone = (z, x, y) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;

/**
 * 드로스 입자 관리: 초기 배치, 시간에 따른 발생, 상태 집계. PhysicsWorld의 입자 API를 쓴다.
 * 같은 설정·시드 → 같은 배치와 같은 발생 순서 (결정성, NFR-10).
 */
export class DrossField {
  constructor(physics, cfg) {
    this.physics = physics;
    this.cfg = { ...DROSS_DEFAULTS, ...cfg };
    this.rand = rng(this.cfg.seed);
    this.spawnAcc = 0;
    this.spawned = 0;
    physics.setFluid(drossFluid());
  }

  /** 겹치지 않는 위치 찾기 (최대 tries번). 벽 근처(띠 350 mm)에 60% 확률로 몰리게 한다 (영상의 벽면 퇴적 모습) */
  samplePos(zone, r, existing, tries = 30) {
    const R = this.rand;
    for (let k = 0; k < tries; k++) {
      let x = zone.x0 + r + R() * (zone.x1 - zone.x0 - 2 * r);
      let y = zone.y0 + r + R() * (zone.y1 - zone.y0 - 2 * r);
      if (R() < 0.6) {
        // 좌·우 벽 띠 또는 앞(또는 뒤) 벽 띠
        const band = 350 * R();
        const side = R();
        if (side < 0.4) y = zone.y1 - r - band;
        else if (side < 0.8) y = zone.y0 + r + band;
        else x = zone === WORK_ZONE ? zone.x0 + r + band : zone.x1 - r - band;
      }
      const ok = existing.every(([ex, ey, er]) => (ex - x) ** 2 + (ey - y) ** 2 >= (er + r + 2) ** 2);
      if (ok) return [x, y];
    }
    return null;
  }

  /** 초기 드로스: 작업 영역 count개 + 스나우트 너머(다른 로봇 담당 영역) count/2개 (장면 재현용) */
  init() {
    const placed = [];
    const add = (zone, n) => {
      for (let i = 0; i < n; i++) {
        const r = (DROSS_DIAMETER_MM[0] + this.rand() * (DROSS_DIAMETER_MM[1] - DROSS_DIAMETER_MM[0])) / 2;
        const xy = this.samplePos(zone, r, placed);
        if (!xy) continue;
        placed.push([xy[0], xy[1], r]);
        this.physics.addParticle({ pos: [xy[0], xy[1], BATH_Z_MM - r * 0.15], rMm: r, densityKgM3: DROSS_DENSITY });
      }
    };
    add(WORK_ZONE, this.cfg.count);
    add(FAR_ZONE, Math.round(this.cfg.count / 2));
  }

  /** 물리 스텝마다: 발생률에 따라 작업 영역 욕면에 새 드로스를 떨어뜨린다 (시뮬레이션 시간 기준) */
  tick(dt) {
    if (!(this.cfg.ratePerMin > 0) || this.physics.particles.length >= MAX_PARTICLES) return;
    this.spawnAcc += dt;
    const every = 60 / this.cfg.ratePerMin;
    while (this.spawnAcc >= every) {
      this.spawnAcc -= every;
      const r = (DROSS_DIAMETER_MM[0] + this.rand() * (DROSS_DIAMETER_MM[1] - DROSS_DIAMETER_MM[0])) / 2;
      const { n, buf } = this.physics.particleState();
      const near = [];
      for (let i = 0; i < n; i++) if (Math.abs(buf[i * 4 + 2] - BATH_Z_MM) < 150) near.push([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 3]]);
      const xy = this.samplePos(WORK_ZONE, r, near, 12);
      if (!xy) continue;
      this.physics.addParticle({ pos: [xy[0], xy[1], BATH_Z_MM + r], rMm: r, densityKgM3: DROSS_DENSITY });
      this.spawned++;
    }
  }

  /**
   * 상태 집계 (FR-29): 욕면(작업 영역 / 스나우트 너머), 운반 중, 드로스 박스, 바닥(흘림), 범위 이탈.
   * coverage: 작업 영역 욕면 대비 드로스 단면적 비율 (%)
   */
  /**
   * @param bins 집계할 드로스 박스 목록 (drossBins) — 박스별 개수는 s.bins[id]
   */
  stats(bins = [{ ...BIN, id: 'main' }]) {
    const ps = this.physics.particles;
    const { buf } = this.physics.particleState();
    const s = { work: 0, far: 0, carried: 0, bin: 0, spilled: 0, out: 0, binKg: 0, workKg: 0, coverage: 0, total: ps.length, spawned: this.spawned, bins: {} };
    let area = 0;
    const inner = bins.map((b) => ({ id: b.id, h: b.h, x0: b.x0 + b.wall, x1: b.x1 - b.wall, y0: b.y0 + b.wall, y1: b.y1 - b.wall }));
    for (const b of inner) s.bins[b.id] = 0;
    ps.forEach((p, i) => {
      if (p.out) return void s.out++;
      const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
      const onBath = Math.abs(z - BATH_Z_MM) < p.r + 40;
      const inBin = inner.find((b) => inZone(b, x, y) && z < b.h + 60);
      if (inBin) {
        s.bin++;
        s.bins[inBin.id]++;
        s.binKg += p.massKg;
      } else if (onBath && inZone(WORK_ZONE, x, y)) {
        s.work++;
        s.workKg += p.massKg;
        area += Math.PI * p.r * p.r;
      } else if (onBath && inZone(FAR_ZONE, x, y)) s.far++;
      else if (z < 200 && !inZone(POT, x, y)) s.spilled++;
      else s.carried++;
    });
    s.coverage = (100 * area) / ((WORK_ZONE.x1 - WORK_ZONE.x0) * (WORK_ZONE.y1 - WORK_ZONE.y0));
    return s;
  }
}

// ---------------------------------------------------------------------------
// 스키밍 사이클 계획 (FR-28)
// ---------------------------------------------------------------------------

export const SKIM = {
  approachAboveMm: 120, // 레인 시작점: 욕면 위 접근 높이 (TCP)
  liftZMm: 980, // 들어 올린 높이 (TCP): 포트 테두리 + 스쿱 캡슐 + 여유
  dumpTiltDeg: 105, // 덤프 기울기 (앞쪽(열린 쪽)이 아래로)
  carryTiltDeg: 12, // 운반 중 뒤로 기울임 (앞쪽이 위로): 담은 드로스가 뒤 턱 쪽으로 굴러 열린 앞쪽으로 빠지지 않게
  dumpWaitS: 1.2,
  loadedMmS: 150, // 드로스를 담은 채 이동하는 속도 (흘림 감소)
  verticalMmS: 150,
  laneOverlap: 0.85, // 레인 간격 = 스쿱 폭 × 이 값
  clearanceMm: 30, // 벽·스나우트와의 추가 여유 (안전 검사 여유거리에 더함)
};

/** 수평 스쿱 자세 (TCP Z = 아래, TCP X = 열린 앞쪽 방향 dir) */
export function levelPose(p, dir) {
  const n = Math.hypot(dir[0], dir[1]);
  const X = [dir[0] / n, dir[1] / n, 0];
  const Z = [0, 0, -1];
  const Y = [X[1], -X[0], 0]; // Z × X
  return poseMatrix([X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]], p);
}

/** 진행 방향 dir을 yawDeg만큼 돌린 방향 (Z축 기준, 반시계 +) */
export function rotateDir(dir, yawDeg) {
  if (!yawDeg) return dir;
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [dir[0] * c - dir[1] * s, dir[0] * s + dir[1] * c];
}

/**
 * 방향을 바꾼 스쿱 자세 (v3.0.0): 열린 앞면 = 진행 방향 dir을 yawDeg 돌린 방향(J6 회전), tiltDeg만큼 앞을 숙임(+) / 듦(−).
 * yaw 0·tilt 0이면 levelPose와 같다.
 */
export function orientedPose(p, dir, yawDeg = 0, tiltDeg = 0) {
  const T = levelPose(p, rotateDir(dir, yawDeg));
  return tiltDeg ? tiltPose(T, tiltDeg) : T;
}

/** 앞쪽이 아래로 가도록 툴 Y축 기준으로 기울인 자세 (덤프): R · Ry(−θ) */
export function tiltPose(T, deg) {
  const t = (-deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const Ry = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  return multiply(T, Ry);
}

/**
 * 스윕 레인 목록: 스쿱이 벽·스나우트와 여유거리를 지키는 범위에서 Y방향으로 나눈다.
 * 레인 = 스나우트 쪽(xs)에서 내려가 포트 앞벽 쪽(xe)으로 당겨 오는 직선.
 */
export function skimLanes(spec, marginMm, { yLo = -Infinity, yHi = Infinity } = {}) {
  const hx = spec.plateXMm / 2, hy = spec.plateYMm / 2;
  const m = marginMm + SKIM.clearanceMm;
  // 레인 중심 Y 범위: 포트 벽 여유 + (모드 1 측면 로봇이 있으면) 구역 경계 − 스쿱 반폭 − 경계 여유
  const lo = Math.max(POT.y0 + hy + m, yLo), hi = Math.min(POT.y1 - hy - m, yHi);
  const xs = SNOUT.x0 - hx - m, xe = POT.x0 + hx + m;
  const n = Math.max(1, Math.ceil((hi - lo) / (spec.plateYMm * SKIM.laneOverlap)) + 1);
  return Array.from({ length: n }, (_, i) => ({ index: i, y: n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1), xs, xe }));
}

/** 대형 로봇 레인 Y 범위: 모드 1 측면 로봇이 있는 쪽은 구역 경계 안쪽만 (FR-33) */
export function mainLaneRange(spec, sides = {}) {
  const hy = spec.plateYMm / 2;
  const lim = SIDE_SPLIT_Y - SIDE_BUFFER_MM - hy;
  return {
    yHi: sides.left?.robotId && sides.left.mode === 1 ? lim : Infinity,
    yLo: sides.right?.robotId && sides.right.mode === 1 ? -lim : -Infinity,
  };
}

/**
 * 드로스가 가장 많은 레인 고르기 (탐욕 선택). 같으면 직전 레인에서 먼 쪽(같은 자리 반복 방지).
 * @param particles { n, buf } (particleState)
 * @returns {{ lane, count }}
 */
export function chooseLane(lanes, particles, spec, lastIndex = -1) {
  const hy = spec.plateYMm / 2, hx = spec.plateXMm / 2;
  const { n, buf } = particles;
  let best = null;
  for (const lane of lanes) {
    let count = 0;
    for (let i = 0; i < n; i++) {
      const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2], r = buf[i * 4 + 3];
      if (r > 0 && Math.abs(z - BATH_Z_MM) < r + 40 && inLane(lane, x, y, hx, hy)) count++;
    }
    const score = count + (lastIndex >= 0 ? Math.abs(lane.index - lastIndex) * 1e-3 : 0);
    if (!best || score > best.score) best = { lane, count, score };
  }
  return best;
}

/** 레인 띠 안인가: 기본 레인(xs→xe, y 고정) 또는 일반 레인(start→end 선분, 폭 = 2·반폭) — 좌표는 월드 */
function inLane(lane, x, y, hx, hy) {
  if (!lane.start) return Math.abs(y - lane.y) < hy && x > lane.xe - hx && x < lane.xs + hx;
  const [ax, ay] = lane.startW ?? lane.start, [bx, by] = lane.endW ?? lane.end;
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
  const u = ((x - ax) * dx + (y - ay) * dy) / L; // 진행 방향 성분
  const v = Math.abs((x - ax) * dy - (y - ay) * dx) / L; // 옆 방향 거리
  return u > -hx && u < L + hx && v < (lane.halfWidth ?? hy);
}

/** 드로스 박스 위 덤프 방향 후보: 로봇에서 멀어지는 방향부터 (기울이면 플랜지가 그 방향으로 나간다) */
function dumpDirections(center) {
  const base = Math.atan2(center[1], center[0]);
  return [0, 45, -45, 90, -90, 135, -135, 180].map((d) => {
    const a = base + (d * Math.PI) / 180;
    return [Math.cos(a), Math.sin(a)];
  });
}

/**
 * 계획 공통 도구: 안전 컨텍스트, 직선 보간(+세분 검사), 관절 보간 대안, 레인 접근(직선 → 높이 올린 직선 → plan/관절 보간)
 * 좌표는 그 로봇의 베이스 좌표계다(측면 로봇은 호출자가 로컬로 바꿔서 넘긴다).
 */
function motionKit({ robot, spec, obstacles, thresholds, floor = true, avoidSingularity = false }) {
  const L = spec.lengthMm;
  const tool = { spec, opening: 0 };
  const features = { selfCollision: true, obstacleCollision: true, singularity: avoidSingularity };
  const ctx = createSafetyContext(robot, { features, thresholds, obstacles, floor, tool, physicsMode: true });
  const ok = (e) => e.violations.length === 0;
  const tcpOf = (q) => multiply(forwardKinematics(robot, q).frames[6], toolMatrix(L));
  // ease: 드로스를 담고 움직이는 구간만 부드럽게 출발·정지 (빈 스쿱 이동은 빠르게)
  const linear = (qa, T, speed, ease = false) => {
    const res = linearMove(robot, qa, T, { toolLengthMm: L, tcpSpeedMmS: speed, ease });
    if (!res.ok) return { error: res.message };
    const pts = res.trajectory.points;
    for (let k = 1; k < pts.length; k++) {
      if (!motionValid(ctx, pts[k - 1], pts[k], ok)) {
        const e = evaluatePose(ctx, pts[k]);
        return { error: `직선 경로에 충돌/특이점이 있습니다 (${e.violations.map((v) => v.key).join(', ') || '구간 검사'})` };
      }
    }
    return { tr: res.trajectory, q: pts.at(-1) };
  };
  const joint = (qa, T) => {
    const ik = solveIK(robot, multiply(T, inverseToolMatrix(L)), qa, { maxIter: 100 });
    if (!ik.ok) return { error: '도달할 수 없는 자세입니다' };
    if (!ok(evaluatePose(ctx, ik.joints)) || !motionValid(ctx, qa, ik.joints, ok)) return { error: '관절 보간 경로에 충돌이 있습니다' };
    return { tr: jointMove(robot, qa, ik.joints), q: ik.joints };
  };
  const toPose = (T) => ({ type: 'pose', pos: origin(T), rpy: rotationToRPY(T) });
  /** 목표까지: 직선 → [현재 xy, 높이] → [목표 xy, 높이] → 목표 → plan(RRT) 또는 관절 보간. moves = [{label, tr, q}] */
  // order: 높이에서 수평 이동 경로 순서 — 'auto'(대각선 → X 먼저 → Y 먼저) | 'y-first'(측면 로봇이 있을 때: 현재 X에서 Y 먼저)
  const reach = async (q, Tgoal, dir, highZ, plan, label, order = 'auto') => {
    const d = order === 'auto' ? linear(q, Tgoal) : { error: '측면 로봇 통로 규칙' };
    if (!d.error) return { moves: [{ label, tr: d.tr, q: d.q }] };
    const p0 = origin(tcpOf(q)), pg = origin(Tgoal);
    const hz = Math.max(p0[2], highZ);
    const a = linear(q, levelPose([p0[0], p0[1], hz], dir));
    let c = a;
    if (!a.error) {
      // 높이에서 수평 이동: 대각선 → X 먼저 → Y 먼저 (스나우트처럼 높은 설비를 돌아가기 위함)
      const routes = order === 'y-first' ? [[[p0[0], pg[1]]]] : [[], [[pg[0], p0[1]]], [[p0[0], pg[1]]]];
      for (const via of routes) {
        const moves = [{ label: `${label}: 상승`, tr: a.tr, q: a.q }];
        let qq = a.q, err = null;
        for (const [x, y] of [...via, [pg[0], pg[1]]]) {
          const m = linear(qq, levelPose([x, y, hz], dir));
          if (m.error) { err = m.error; break; }
          moves.push({ label: `${label}: 이동`, tr: m.tr, q: m.q });
          qq = m.q;
        }
        if (err) { c = { error: err }; continue; }
        const d2 = linear(qq, Tgoal);
        if (d2.error) { c = d2; continue; }
        moves.push({ label, tr: d2.tr, q: d2.q });
        return { moves };
      }
    }
    if (plan) {
      const r = await plan({ start: q, goal: toPose(Tgoal), obstacles, tool, attached: null, physicsMode: true });
      if (!r.ok) return { error: r.message };
      return { moves: [{ label, tr: pathTrajectory(robot, r.path, r.blends), q: r.path.at(-1) }] };
    }
    const j = joint(q, Tgoal);
    if (j.error) return { error: `${c.error} / 관절 보간: ${j.error}` };
    return { moves: [{ label, tr: j.tr, q: j.q }] };
  };
  return { ctx, linear, joint, reach, tcpOf };
}

/**
 * 스키밍 1사이클 계획.
 * 구간: ① 현재 → 레인 시작 위(이동) ② 하강(욕면 아래 잠김 깊이) ③ 스윕(레인 끝으로 당김) ④ 상승
 *       ⑤ 드로스 박스 위로(수평 유지) ⑥ 덤프 높이로 하강 ⑦ 기울여 쏟기 ⑧ 대기 ⑨ 원위치(수평)
 * 모든 직선 구간은 실행 기준 여유거리로 세분 검사한다. ①만 막히면 경로 계획(RRT, plan이 없으면 관절 보간)을 쓴다.
 * @param input { robot, q0, spec, lane, immersionMm, sweepMmS, obstacles(설비 + 물체), thresholds, floor, avoidSingularity,
 *                cell?: { bathZ, liftZ, bin{ x0,x1,y0,y1,h } } }  — 기본값 = 대형 로봇 셀(로봇 좌표 = 월드)
 *   lane: { y, xs, xe } (대형 기본, X 방향 스윕) 또는 { start:[x,y], end:[x,y] } (측면 로봇, 로컬 좌표 / v3.0.0 자유 스트로크)
 *   stroke (v3.0.0, 없으면 v1.1.2와 같음): { yaw0Deg, yaw1Deg, tiltDeg, segments } — 스윕 시작·끝의 스쿱 방향(열린 앞면을
 *     진행 방향에서 돌린 각도, J6 회전), 스윕 중 기울임, 스윕을 나눌 직선 구간 수(방향 보간). 들기·운반·덤프는 끝 방향 기준.
 * @param deps { plan(req) | null }  req = { start, goal, obstacles, tool, attached: null, physicsMode: true }
 * @returns {Promise<{ ok: true, steps, vertices, duration } | { ok: false, stage, message }>}
 */
export async function planSkimCycle(input, { plan = null } = {}) {
  const { robot, q0, spec, lane, immersionMm = DROSS_DEFAULTS.immersionMm, sweepMmS = DROSS_DEFAULTS.sweepMmS,
    obstacles, thresholds, floor = true, avoidSingularity = false, cell = {}, stroke = null } = input;
  const bathZ = cell.bathZ ?? BATH_Z_MM, liftZ = cell.liftZ ?? SKIM.liftZMm, bin = cell.bin ?? BIN;
  const kit = motionKit({ robot, spec, obstacles, thresholds, floor, avoidSingularity });
  const { linear, joint } = kit;
  const fail = (stage, message) => ({ ok: false, stage, message: `${stage}: ${message}` });
  const start = lane.start ?? [lane.xs, lane.y], end = lane.end ?? [lane.xe, lane.y];
  const sweepDir = [end[0] - start[0], end[1] - start[1]]; // 열린 앞쪽이 진행 방향 → 판이 드로스 밑으로 들어가고 뒤 턱이 모은다
  const yaw0 = stroke?.yaw0Deg ?? 0, yaw1 = stroke?.yaw1Deg ?? yaw0, tilt = stroke?.tiltDeg ?? 0;
  const segN = Math.max(1, Math.round(stroke?.segments ?? (yaw0 !== yaw1 ? 6 : 1)));
  const dir0 = rotateDir(sweepDir, yaw0), endDir = rotateDir(sweepDir, yaw1); // 스윕 시작·끝 스쿱 방향
  const steps = [];
  const verts = [{ q: q0.slice(), kind: 'start' }];
  const move = (label, tr, q, kind = 'via') => {
    steps.push({ kind: 'move', label, trajectory: tr });
    verts.push({ q, kind });
  };

  // ① 레인 시작 위로
  const Tapp = orientedPose([start[0], start[1], bathZ + SKIM.approachAboveMm], sweepDir, yaw0, tilt);
  // cell.corridor: 측면 로봇이 있으면 대형 로봇은 드로스 박스 쪽 통로로만 오간다 —
  //   레인 접근 = 지금 X에서 Y 먼저, 박스로 이동 = 박스 X까지 먼저 간 뒤 Y (측면 띠 위를 대각선으로 지나지 않음)
  // cell.dumpVia: 박스로 가는 경유 순서 — 'x'(박스 X까지 먼저: 대형) | 'y'(박스 Y까지 먼저: 측면 로봇, 스나우트를 피함)
  const corridor = !!cell.corridor;
  const dumpVia = cell.dumpVia ?? (corridor ? 'x' : null);
  const s1 = await kit.reach(q0, Tapp, dir0, liftZ, plan, '레인 접근', corridor ? 'y-first' : 'auto');
  if (s1.error) return fail('레인 접근', s1.error);
  s1.moves.forEach((m) => move(m.label, m.tr, m.q));
  const q = s1.moves.at(-1).q;

  // ② 하강 ③ 스윕 ④ 상승
  const z = bathZ - immersionMm;
  const s2 = linear(q, orientedPose([start[0], start[1], z], sweepDir, yaw0, tilt), SKIM.verticalMmS);
  if (s2.error) return fail('스쿱 하강', s2.error);
  move('스쿱 하강', s2.tr, s2.q);
  let s3;
  if (segN === 1) s3 = linear(s2.q, orientedPose([end[0], end[1], z], sweepDir, yaw1, tilt), sweepMmS);
  else {
    // 방향을 바꾸며 쓸기: 직선 segN개로 나누고 구간마다 스쿱 방향을 yaw0 → yaw1로 보간 (J6가 돈다)
    const trs = [];
    let qq = s2.q;
    s3 = null;
    for (let k = 1; k <= segN; k++) {
      const f = k / segN;
      const pk = [start[0] + (end[0] - start[0]) * f, start[1] + (end[1] - start[1]) * f, z];
      const m = linear(qq, orientedPose(pk, sweepDir, yaw0 + (yaw1 - yaw0) * f, tilt), sweepMmS);
      if (m.error) {
        s3 = m;
        break;
      }
      trs.push(m.tr);
      qq = m.q;
    }
    s3 ??= { tr: concatTrajectories(trs), q: qq };
  }
  if (s3.error) return fail('스윕', s3.error);
  move('스윕', s3.tr, s3.q, 'pick');
  const s4a = linear(s3.q, levelPose([end[0], end[1], liftZ], endDir), SKIM.verticalMmS, true);
  if (s4a.error) return fail('스쿱 상승', s4a.error);
  move('스쿱 상승', s4a.tr, s4a.q);
  const carry = (T) => tiltPose(T, -SKIM.carryTiltDeg);
  const s4 = linear(s4a.q, carry(levelPose([end[0], end[1], liftZ], endDir)), undefined, true);
  if (s4.error) return fail('스쿱 뒤로 기울임', s4.error);
  move('스쿱 뒤로 기울임', s4.tr, s4.q);

  // ⑤~⑦ 드로스 박스 위에서 덤프: 방향 후보를 차례로 시도 (첫 번째로 모든 구간이 통과하는 방향)
  const center = [(bin.x0 + bin.x1) / 2, (bin.y0 + bin.y1) / 2];
  const r = Math.max(spec.plateYMm / 6, spec.lipMm, spec.plateThickMm);
  const zDump = bin.h + thresholds.obstacleMarginMm + SKIM.clearanceMm + spec.plateXMm / 2 + r;
  let dump = null;
  let lastErr = '';
  // 덤프 높이는 기본 높이부터 +80, +160 mm까지 올려 본다 (팔이 짧거나 길어 접히는 로봇: 측면 로봇)
  search: for (const d of dumpDirections(center)) {
    const Tover = carry(levelPose([center[0], center[1], liftZ], d));
    let a;
    if (dumpVia) {
      const via = dumpVia === 'x' ? [center[0], end[1]] : [end[0], center[1]];
      const v = linear(s4.q, carry(levelPose([via[0], via[1], liftZ], endDir)), SKIM.loadedMmS, true);
      const w = v.error ? v : linear(v.q, Tover, SKIM.loadedMmS, true);
      a = w.error ? w : { tr: concatTrajectories([v.tr, w.tr]), q: w.q };
    } else a = linear(s4.q, Tover, SKIM.loadedMmS, true);
    if (a.error) { lastErr = a.error; continue; }
    for (const dz of [0, 80, 160]) {
      const Tlev = levelPose([center[0], center[1], Math.min(zDump + dz, liftZ)], d);
      const Tlow = carry(Tlev);
      const Ttilt = tiltPose(Tlev, SKIM.dumpTiltDeg);
      const b = linear(a.q, Tlow, SKIM.verticalMmS, true);
      if (b.error) { lastErr = b.error; continue; }
      let c = linear(b.q, Ttilt);
      if (c.error) c = joint(b.q, Ttilt);
      if (c.error) { lastErr = c.error; continue; }
      let back = linear(c.q, Tlev);
      if (back.error) back = joint(c.q, Tlev);
      if (back.error) { lastErr = back.error; continue; }
      dump = { a, b, c, back };
      break search;
    }
  }
  if (!dump) return fail('덤프', `드로스 박스 위에서 기울일 수 있는 자세가 없습니다 (${lastErr})`);
  move('드로스 박스로 이동', dump.a.tr, dump.a.q);
  move('덤프 높이로 하강', dump.b.tr, dump.b.q);
  move('기울여 쏟기', dump.c.tr, dump.c.q, 'place');
  steps.push({ kind: 'action', type: 'wait', sec: SKIM.dumpWaitS, label: '쏟는 중' });
  move('스쿱 수평 복귀', dump.back.tr, dump.back.q, 'end');

  verts.forEach((v, i) => (v.label = v.kind === 'start' ? 'A' : v.kind === 'end' ? 'B' : String(i)));
  return { ok: true, steps, vertices: verts, duration: stepsDuration(steps) };
}

const stepsDuration = (steps) => steps.reduce((t, st) => t + (st.kind === 'move' ? st.trajectory.duration : st.sec ?? 0), 0);

export const PUSH = { immersionMm: 70, pushMmS: 150, liftAboveMm: 150 };

/**
 * 밀기 1스트로크 계획 (측면 로봇 모드 2, FR-33): 밀대로 벽 쪽 드로스를 대형 로봇 레인 쪽으로 밀어 준다.
 * 구간: ① 시작점 위(욕면 + 120) ② 날 하강(욕면 − 70) ③ 밀기(start → end, 150 mm/s) ④ 상승(욕면 + 150) ⑤ 대기 자세(park)로 복귀
 * @param input { robot, q0, spec(RAKE), start, end(로컬 xy), park(로컬 4x4 TCP 자세), obstacles(로컬), thresholds, cell{ bathZ, liftZ } }
 */
export async function planPushStroke(input) {
  const { robot, q0, spec, start, end, park, obstacles, thresholds, cell = {} } = input;
  const bathZ = cell.bathZ ?? BATH_Z_MM, liftZ = cell.liftZ ?? SKIM.liftZMm;
  const kit = motionKit({ robot, spec, obstacles, thresholds, floor: false });
  const fail = (stage, message) => ({ ok: false, stage, message: `${stage}: ${message}` });
  const dir = [end[0] - start[0], end[1] - start[1]]; // 툴 X = 미는 방향 (날 면이 진행 방향을 마주 봄)
  const steps = [];
  const verts = [{ q: q0.slice(), kind: 'start' }];
  const move = (label, tr, q, kind = 'via') => {
    steps.push({ kind: 'move', label, trajectory: tr });
    verts.push({ q, kind });
  };
  const s1 = await kit.reach(q0, levelPose([start[0], start[1], bathZ + SKIM.approachAboveMm], dir), dir, liftZ, null, '밀기 시작점 접근');
  if (s1.error) return fail('밀기 시작점 접근', s1.error);
  s1.moves.forEach((m) => move(m.label, m.tr, m.q));
  const s2 = kit.linear(s1.moves.at(-1).q, levelPose([start[0], start[1], bathZ - PUSH.immersionMm], dir), SKIM.verticalMmS);
  if (s2.error) return fail('날 하강', s2.error);
  move('날 하강', s2.tr, s2.q);
  const s3 = kit.linear(s2.q, levelPose([end[0], end[1], bathZ - PUSH.immersionMm], dir), PUSH.pushMmS);
  if (s3.error) return fail('밀기', s3.error);
  move('밀기', s3.tr, s3.q, 'pick');
  const s4 = kit.linear(s3.q, levelPose([end[0], end[1], bathZ + PUSH.liftAboveMm], dir), SKIM.verticalMmS);
  if (s4.error) return fail('날 상승', s4.error);
  move('날 상승', s4.tr, s4.q);
  if (park) {
    const s5 = await kit.reach(s4.q, park, dir, liftZ, null, '대기 자세로 복귀');
    if (s5.error) return fail('대기 자세로 복귀', s5.error);
    s5.moves.forEach((m) => move(m.label, m.tr, m.q));
  }
  verts.at(-1).kind = 'end';
  verts.forEach((v, i) => (v.label = v.kind === 'start' ? 'A' : v.kind === 'end' ? 'B' : String(i)));
  return { ok: true, steps, vertices: verts, duration: stepsDuration(steps) };
}
