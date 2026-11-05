// 스트로크 학습 실험실 (Trial & Error) — PRD_v.3.0.0 4.5·FR-67(L1 진화 탐색 단계). DOM 비의존: Node(헤드리스)·Web Worker(앱)에서 쓴다.
// 대형 로봇이 다음에 할 스트로크(시작점·쓸어 가는 방향·길이·스쿱 열린 면 방향(J6)·스윕 중 회전·기울임·잠김 깊이·속도)를
// 여러 개 시도해 보고(물리 시뮬레이션으로 점수 계산) 가장 점수가 높은 것만 실제로 실행한다. 점수 규칙(보상)은 사용자가 정한다.
// 탐색 = 교차 엔트로피 방법(CEM, CMA-ES와 같은 진화 탐색 계열): 후보 생성 → 평가 → 상위(엘리트)로 분포 갱신 → 반복.
// 후보 평가는 지금 욕면 드로스 위치를 복사한 별도 물리 월드에서 한 사이클(접근 → 스윕 → 들기 → 운반 → 덤프)을 돌려 센다.
import { SKIMMER_SPEC, skimmerBoxes } from './gripper.js';
import { createSafetyContext, evaluatePose } from './safety.js';
import { sampleTrajectory } from './trajectory.js';
import { planPath } from './planner.js';
import { PhysicsWorld } from './physics.js';
import { homeJoints } from './kinematics.js';
import { observe, act } from './ppo.js';
import { POT, SNOUT, BIN, BATH_Z_MM, DROSS_DENSITY, DrossField, drossFixtures, drossFluid, chooseLane, skimLanes, mainLaneRange, planSkimCycle, rng } from './dross.js';

// ---- 탐색 변수 (행동) ----
/** key, 이름, 단위, 기본 탐색 범위 [min, max], 탐색 안 할 때 고정값 */
export const STROKE_PARAMS = [
  { key: 'x0', label: '시작 X (포트 앞벽 → 스나우트)', unit: 'mm', range: [1330, 2070], fixed: 2070 },
  { key: 'y0', label: '시작 Y (오른쪽 벽 → 왼쪽 벽)', unit: 'mm', range: [-670, 670], fixed: 0 },
  { key: 'headingDeg', label: '쓸어 가는 방향 (0 = +X 스나우트 쪽, 180 = 로봇 쪽)', unit: '°', range: [0, 360], fixed: 180 },
  { key: 'lengthMm', label: '스윕 길이', unit: 'mm', range: [250, 1100], fixed: 740 },
  { key: 'yaw0Deg', label: '열린 면 방향 — 스윕 시작 (진행 방향 기준, J6)', unit: '°', range: [-180, 180], fixed: 0 },
  { key: 'yaw1Deg', label: '열린 면 방향 — 스윕 끝 (스윕 중 회전)', unit: '°', range: [-180, 180], fixed: 0 },
  { key: 'tiltDeg', label: '스윕 중 기울임 (+ 앞 숙임)', unit: '°', range: [-15, 15], fixed: 0 },
  { key: 'depthMm', label: '잠김 깊이', unit: 'mm', range: [20, 75], fixed: 60 },
  { key: 'speedMmS', label: '스윕 속도', unit: 'mm/s', range: [30, 250], fixed: 120 },
];

/** 점수 규칙 기본값 (사용자 설정) */
export const REWARD_DEFAULTS = Object.freeze({
  perDross: 10, // 드로스 1개를 박스에 넣음
  wallBonus: 5, // 그 드로스가 벽 띠·모서리(벽에서 WALL_BAND_MM 안)에 있던 것이면 추가
  emptyStroke: -20, // 헛질: 한 번 쓸었는데 1개도 못 넣음
  spill: -5, // 흘림 1개
  perSecond: -0.2, // 스트로크 1초
  infeasible: -10, // 계획 불가(도달 불가·충돌)
  goalBonus: 200, // (에피소드) 목표 회수율 도달
});
export const WALL_BAND_MM = 250;

/** 실험 설정 기본값 */
export const LAB_DEFAULTS = Object.freeze({
  schema: 'robosim-lab/1',
  method: 'cem', // 'cem' 진화 탐색 | 'random' 무작위 탐색 (| 'ppo' 강화학습 — 다음 단계)
  population: 16, // 세대당 후보 수
  iterations: 3, // 세대 수 (결정 1번에)
  eliteFrac: 0.25,
  includeRule: true, // 첫 세대에 규칙 경로(v1.1.2 레인)를 후보로 넣는다 → 결정마다 규칙보다 나쁘지 않게
  seed: 1,
  search: Object.fromEntries(STROKE_PARAMS.map((p) => [p.key, { on: true, min: p.range[0], max: p.range[1], fixed: p.fixed }])),
  reward: { ...REWARD_DEFAULTS },
  keepTop: 10, // 최선 모션 라이브러리 크기
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 설정 검증·보정 (화면·파일 입력 공통) */
export function sanitizeLab(raw = {}) {
  const D = LAB_DEFAULTS;
  const num = (v, d, lo, hi) => (Number.isFinite(+v) ? clamp(+v, lo, hi) : d);
  const search = {};
  for (const p of STROKE_PARAMS) {
    const r = raw.search?.[p.key] ?? {};
    let min = num(r.min, p.range[0], -1e4, 1e4), max = num(r.max, p.range[1], -1e4, 1e4);
    if (min > max) [min, max] = [max, min];
    search[p.key] = { on: r.on === undefined ? true : !!r.on, min, max, fixed: num(r.fixed, p.fixed, -1e4, 1e4) };
  }
  const reward = {};
  for (const [k, v] of Object.entries(REWARD_DEFAULTS)) reward[k] = num(raw.reward?.[k], v, -1e4, 1e4);
  return {
    schema: D.schema,
    method: ['cem', 'random'].includes(raw.method) ? raw.method : D.method,
    population: Math.round(num(raw.population, D.population, 2, 256)),
    iterations: Math.round(num(raw.iterations, D.iterations, 1, 50)),
    eliteFrac: num(raw.eliteFrac, D.eliteFrac, 0.05, 0.9),
    includeRule: raw.includeRule === undefined ? D.includeRule : !!raw.includeRule,
    seed: Math.round(num(raw.seed, D.seed, 1, 1e9)),
    search,
    reward,
    keepTop: Math.round(num(raw.keepTop, D.keepTop, 1, 100)),
  };
}

/** 탐색하는 변수 목록 (on인 것) */
export const searchKeys = (lab) => STROKE_PARAMS.map((p) => p.key).filter((k) => lab.search[k].on);

/** 정규화 벡터 u(0~1, 탐색 변수만) → 스트로크 */
export function decodeStroke(u, lab) {
  const v = {};
  let i = 0;
  for (const p of STROKE_PARAMS) {
    const s = lab.search[p.key];
    v[p.key] = s.on ? s.min + (s.max - s.min) * clamp(u[i++], 0, 1) : s.fixed;
  }
  return strokeFromValues(v);
}

/** 변수 값 → 실행용 스트로크 (끝점은 포트 안쪽으로 자름) */
export function strokeFromValues(v) {
  const h = (v.headingDeg * Math.PI) / 180;
  // 스쿱 중심이 갈 수 있는 상자 = 규칙 레인과 같은 여유(판 반폭 180 + 장애물 여유 20 + 30) → 앞벽 1330, 스나우트 앞 2070, 좌우 ±670
  const m = 230;
  const box = { x0: POT.x0 + m, x1: SNOUT.x0 - m, y0: POT.y0 + m, y1: POT.y1 - m };
  const x0 = clamp(v.x0, box.x0, box.x1), y0 = clamp(v.y0, box.y0, box.y1);
  // 끝점: 방향으로 길이만큼, 상자 밖이면 상자 경계에서 멈춤
  let L = v.lengthMm;
  const dx = Math.cos(h), dy = Math.sin(h);
  for (const [d, p, lo, hi] of [[dx, x0, box.x0, box.x1], [dy, y0, box.y0, box.y1]]) {
    if (d > 1e-9) L = Math.min(L, (hi - p) / d);
    else if (d < -1e-9) L = Math.min(L, (lo - p) / d);
  }
  return {
    values: { ...v },
    start: [x0, y0],
    end: [x0 + dx * L, y0 + dy * L],
    lengthMm: L,
    yaw0Deg: v.yaw0Deg,
    yaw1Deg: v.yaw1Deg,
    tiltDeg: v.tiltDeg,
    depthMm: v.depthMm,
    speedMmS: v.speedMmS,
  };
}

/** 스트로크 → 정규화 벡터 (규칙 경로를 후보로 넣을 때) */
export function encodeValues(v, lab) {
  return STROKE_PARAMS.filter((p) => lab.search[p.key].on).map((p) => {
    const s = lab.search[p.key];
    return s.max > s.min ? clamp((v[p.key] - s.min) / (s.max - s.min), 0, 1) : 0.5;
  });
}

/** 규칙 경로(v1.1.2 탐욕 레인)를 변수 값으로 */
export function ruleValues(particles, sides, thresholds, task) {
  const lanes = skimLanes(SKIMMER_SPEC, thresholds.obstacleMarginMm, mainLaneRange(SKIMMER_SPEC, sides));
  const pick = chooseLane(lanes, particles, SKIMMER_SPEC);
  if (!pick || pick.count < 1) return null;
  const l = pick.lane;
  return { x0: l.xs, y0: l.y, headingDeg: 180, lengthMm: l.xs - l.xe, yaw0Deg: 0, yaw1Deg: 0, tiltDeg: 0, depthMm: task.dross.immersionMm, speedMmS: task.dross.sweepMmS };
}

/** 욕면 위(포트 안) 드로스 복사본 [x, y, z, r, …] — 후보 평가용 */
export function snapshotParticles(physics) {
  const ps = physics.particles;
  const { buf } = physics.particleState();
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].out) continue;
    const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
    if (x > POT.x0 && x < POT.x1 && y > POT.y0 && y < POT.y1 && Math.abs(z - BATH_Z_MM) < ps[i].r + 40) out.push(x, y, z, ps[i].r);
  }
  return out;
}

const nearWall = (x, y) => x - POT.x0 < WALL_BAND_MM || POT.y1 - y < WALL_BAND_MM || y - POT.y0 < WALL_BAND_MM || (x < SNOUT.x0 && SNOUT.x0 - x < WALL_BAND_MM);
const inBin = (x, y, z) => x > BIN.x0 + BIN.wall && x < BIN.x1 - BIN.wall && y > BIN.y0 + BIN.wall && y < BIN.y1 - BIN.wall && z < BIN.h + 60;

/** 점수 계산 (보상 규칙) */
export function scoreStroke(r, reward) {
  if (!r.feasible) return reward.infeasible;
  return reward.perDross * r.collected + reward.wallBonus * r.wallCollected + reward.spill * r.spilled
    + reward.perSecond * r.durationS + (r.collected === 0 ? reward.emptyStroke : 0);
}

/**
 * 행동 보정 (정책 실행용, 안전한 강화학습의 action repair): 계획이 안 되는 스트로크를 안전한 쪽으로 당긴다.
 * k = 1: 시작점을 규칙 레인 범위 안으로, 열린 면 회전·기울임 절반 / k = 2: 회전·기울임 0, 벽에서 15% 더 안쪽
 */
export function repairValues(v, k) {
  const f = k === 1 ? 0.5 : 0;
  return {
    ...v,
    x0: clamp(v.x0, 1350, 2050),
    y0: clamp(v.y0, -640, 640) * (k === 1 ? 1 : 0.85),
    yaw0Deg: v.yaw0Deg * f,
    yaw1Deg: v.yaw1Deg * f,
    tiltDeg: v.tiltDeg * f,
  };
}

/** 계획 가능한 스트로크 찾기: 원래 값 → 보정 1 → 보정 2. @returns { values, res, repaired(0~2) } (res.ok가 false면 모두 실패) */
export async function planWithRepair({ robot, q0, values, sides = {}, thresholds, repair = true }) {
  let res = null;
  for (let k = 0; k <= (repair ? 2 : 0); k++) {
    const v = k ? repairValues(values, k) : values;
    res = await planStroke({ robot, q0, stroke: strokeFromValues(v), sides, thresholds });
    if (res.ok) return { values: v, res, repaired: k };
  }
  return { values, res, repaired: -1 };
}

/** 스트로크 계획 (사이클 단계 목록). 실패하면 { ok: false, stage, message } */
export function planStroke({ robot, q0, stroke, sides = {}, thresholds, deterministic = true }) {
  return planSkimCycle(
    { robot, q0, spec: SKIMMER_SPEC, lane: { start: stroke.start, end: stroke.end }, immersionMm: stroke.depthMm, sweepMmS: stroke.speedMmS,
      obstacles: drossFixtures(sides), thresholds, floor: true, cell: { corridor: Object.keys(sides).length > 0 },
      stroke: { yaw0Deg: stroke.yaw0Deg, yaw1Deg: stroke.yaw1Deg, tiltDeg: stroke.tiltDeg } },
    { plan: (req) => planPath({ robot, thresholds, floor: true, features: {}, avoidSingularity: false, reference: q0, timeoutMs: 8000, deterministic, ...req }) },
  );
}

/** 대형 로봇 물리 형상 함수 (링크 캡슐 + 스키머 박스) */
function robotShapes(robot, thresholds) {
  const ctx = createSafetyContext(robot, { features: { selfCollision: false, obstacleCollision: false, singularity: false }, thresholds, obstacles: [], floor: false, tool: { spec: SKIMMER_SPEC, opening: 0 }, physicsMode: true });
  return (q) => {
    const e = evaluatePose(ctx, q);
    return [...e.segments.filter((s) => s.part !== 'plate'), ...skimmerBoxes(SKIMMER_SPEC, e.frames[6])];
  };
}

/** 입자 상태 분류: 0 = 그 밖(욕면 등), 1 = 대형 박스 안, 2 = 바닥(흘림) */
function classify(w) {
  const { buf } = w.particleState();
  return w.particles.map((p, i) => {
    if (p.out) return 3;
    const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
    if (inBin(x, y, z)) return 1;
    if (z < 200 && !(x > POT.x0 && x < POT.x1 && y > POT.y0 && y < POT.y1)) return 2;
    return 0;
  });
}

/**
 * 계획된 사이클을 물리 월드 w에서 실행하고 결과를 센다 (이번 스트로크로 새로 박스에 들어간 것·새로 흘린 것만).
 * @returns { collected, wallCollected, spilled, durationS, q1 }
 */
function executeInWorld(w, shapes, q0, steps) {
  const before = classify(w);
  const { buf: b0 } = w.particleState();
  const wall = w.particles.map((_, i) => nearWall(b0[i * 4], b0[i * 4 + 1]));
  const DT = 1 / 60;
  let q = q0, simT = 0;
  for (const st of steps) {
    if (st.kind === 'move') {
      const n = Math.max(1, Math.ceil(st.trajectory.duration / DT));
      for (let k = 1; k <= n; k++) {
        q = sampleTrajectory(st.trajectory, Math.min(st.trajectory.duration, k * DT));
        w.moveRobot(shapes(q));
        w.step();
        simT += DT;
      }
    } else {
      const n = Math.ceil((st.sec ?? 0) / DT);
      for (let k = 0; k < n; k++) {
        w.step();
        simT += DT;
      }
    }
  }
  for (let k = 0; k < 30; k++) w.step(); // 박스 안에 자리 잡기
  simT += 0.5;
  const after = classify(w);
  let collected = 0, wallCollected = 0, spilled = 0;
  after.forEach((c, i) => {
    if (c === before[i]) return;
    if (c === 1) {
      collected++;
      if (wall[i]) wallCollected++;
    } else if (c === 2) spilled++;
  });
  return { collected, wallCollected, spilled, durationS: +simT.toFixed(2), q1: q };
}

/**
 * 후보 스트로크 1개 평가: 복사한 드로스 위에서 대형 로봇이 한 사이클을 실행 → 회수·벽 띠 회수·흘림·시간·점수.
 * @param job { robot, q0, particles([x,y,z,r]…), stroke, reward, sides, thresholds, deterministic }
 */
export async function evaluateStroke(RAPIER, job) {
  const { robot, q0, particles, stroke, reward, sides = {}, thresholds } = job;
  const res = await planStroke({ robot, q0, stroke, sides, thresholds, deterministic: job.deterministic ?? true });
  if (!res.ok) {
    const r = { feasible: false, stage: res.stage, message: res.message, collected: 0, wallCollected: 0, spilled: 0, durationS: 0 };
    return { ...r, score: scoreStroke(r, reward) };
  }
  const w = new PhysicsWorld(RAPIER);
  w.setFixtures(drossFixtures(sides));
  w.load([]);
  w.setFluid(drossFluid());
  for (let i = 0; i < particles.length; i += 4) w.addParticle({ pos: [particles[i], particles[i + 1], particles[i + 2]], rMm: particles[i + 3], densityKgM3: DROSS_DENSITY });
  const shapes = robotShapes(robot, thresholds);
  w.setRobot(shapes(q0));
  for (let k = 0; k < 6; k++) w.step();
  const r = { feasible: true, ...executeInWorld(w, shapes, q0, res.steps) };
  w.dispose();
  return { ...r, score: scoreStroke(r, reward) };
}

/**
 * 강화학습 환경 (스트로크 단위, 대형 로봇 단독 셀): reset(seed) → 관측용 입자, step(스트로크 변수) → 보상·종료.
 * 한 에피소드 = 제한 시간(기본 600 s) 또는 maxSteps 스트로크. 물리 월드를 에피소드 내내 유지한다(드로스가 실제로 줄어듦).
 * 계획 불가 스트로크는 시뮬레이션 없이 벌점 + 시간 penaltyS(기본 3 s)만 흐른다.
 */
export class StrokeEnv {
  constructor(RAPIER, robot, { count = 160, reward = REWARD_DEFAULTS, thresholds, timeLimitS = 600, maxSteps = 40, penaltyS = 3, repair = true } = {}) {
    Object.assign(this, { RAPIER, robot, count, reward, thresholds, timeLimitS, maxSteps, penaltyS, repair });
    this.shapes = robotShapes(robot, thresholds);
    this.w = null;
  }

  reset(seed) {
    this.w?.dispose();
    const w = new PhysicsWorld(this.RAPIER);
    w.setFixtures(drossFixtures({}));
    w.load([]);
    const field = new DrossField(w, { count: this.count, seed });
    field.init();
    this.q = homeJoints(this.robot);
    w.setRobot(this.shapes(this.q));
    for (let i = 0; i < 90; i++) w.step();
    this.w = w;
    this.t = 0;
    this.steps = 0;
    this.collected = 0;
    this.initialWork = this.workCount();
    return this.particles();
  }

  /** 작업 영역 욕면 드로스 수 */
  workCount() {
    const ps = snapshotParticles(this.w);
    let n = 0;
    for (let i = 0; i < ps.length; i += 4) if (ps[i] < SNOUT.x0) n++;
    return n;
  }

  particles() {
    return snapshotParticles(this.w);
  }

  get tFrac() {
    return Math.min(1, this.t / this.timeLimitS);
  }

  /** 규칙 경로(v1.1.2 탐욕 레인)의 변수 값 — 모방 학습 교사 */
  teacher(task) {
    return ruleValues(this.w.particleState(), {}, this.thresholds, task);
  }

  async step(values) {
    // 계획이 안 되면 보정(repair)한 스트로크로 실행하고, 보정했다는 벌점(계획 불가 벌점의 절반)을 준다
    const { res, repaired } = await planWithRepair({ robot: this.robot, q0: this.q, values, thresholds: this.thresholds, repair: this.repair });
    let r;
    if (!res.ok) {
      r = { feasible: false, stage: res.stage, message: res.message, collected: 0, wallCollected: 0, spilled: 0, durationS: this.penaltyS };
      for (let k = 0; k < Math.round(this.penaltyS * 60); k++) this.w.step();
    } else {
      r = { feasible: true, ...executeInWorld(this.w, this.shapes, this.q, res.steps) };
      this.q = r.q1;
    }
    this.t += r.durationS;
    this.steps++;
    this.collected += r.collected;
    const score = scoreStroke(r, this.reward) + (repaired > 0 ? 0.5 * this.reward.infeasible : 0);
    r.repaired = repaired;
    const remaining = this.workCount();
    const done = this.t >= this.timeLimitS || this.steps >= this.maxSteps || remaining === 0;
    return { reward: score, done, info: { ...r, q1: undefined, score, t: this.t, rate: this.initialWork ? (100 * this.collected) / this.initialWork : 0, remaining } };
  }

  dispose() {
    this.w?.dispose();
    this.w = null;
  }
}

/** 정규 난수 (Box–Muller) */
function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * 결정 1번의 탐색: 후보 생성 → evalBatch(후보 목록) → 상위로 분포 갱신 → 반복. 가장 점수 높은 후보를 돌려준다.
 * @param ctx { lab, rand, seedValues(규칙 경로 변수 | null), evalBatch(strokes) → Promise<results>, shouldStop() }
 * @returns { best: { stroke, result }, trials: [{ iter, values, score, collected, wallCollected, spilled, feasible, rule }] }
 */
export async function searchStroke({ lab, rand, seedValues, evalBatch, shouldStop = () => false }) {
  const keys = searchKeys(lab);
  const d = keys.length;
  // 시작 분포: 규칙 경로가 있으면 그 근처(표준편차 0.15) — 첫 세대는 절반은 그 근처 변형, 절반은 전체 무작위(새 방향 발견용)
  const seedU = seedValues ? encodeValues(seedValues, lab) : null;
  let mean = seedU ? seedU.slice() : new Array(d).fill(0.5), std = new Array(d).fill(seedU ? 0.15 : 0.3);
  const trials = [];
  let best = null;
  for (let it = 0; it < lab.iterations; it++) {
    if (shouldStop()) break;
    const us = [];
    if (it === 0 && seedU && lab.includeRule) us.push(seedU.slice());
    while (us.length < lab.population) {
      const global = lab.method === 'random' || (it === 0 && (!seedU || us.length % 2 === 0));
      us.push(global ? mean.map(() => rand()) : mean.map((m, j) => clamp(m + std[j] * gaussian(rand), 0, 1)));
    }
    const strokes = us.map((u) => decodeStroke(u, lab));
    if (it === 0 && seedValues && lab.includeRule) strokes[0] = { ...strokeFromValues(seedValues), rule: true };
    const results = await evalBatch(strokes);
    results.forEach((r, k) => {
      trials.push({ iter: it, values: strokes[k].values, rule: !!strokes[k].rule, score: +r.score.toFixed(2), collected: r.collected, wallCollected: r.wallCollected, spilled: r.spilled, feasible: r.feasible, durationS: r.durationS, stage: r.stage ?? null });
      if (!best || r.score > best.result.score) best = { stroke: strokes[k], result: r, u: us[k] };
    });
    if (lab.method === 'cem' && d) {
      const order = results.map((r, k) => [r.score, k]).sort((a, b) => b[0] - a[0]);
      const ne = Math.max(2, Math.round(lab.population * lab.eliteFrac));
      const el = order.slice(0, ne).map(([, k]) => us[k]);
      mean = mean.map((m, j) => 0.3 * m + 0.7 * (el.reduce((s, u) => s + u[j], 0) / el.length));
      std = std.map((sd, j) => {
        const v = el.reduce((s, u) => s + (u[j] - mean[j]) ** 2, 0) / el.length;
        return Math.max(0.04, 0.3 * sd + 0.7 * Math.sqrt(v));
      });
    }
  }
  return { best, trials };
}

/**
 * 학습 실행 1회: 10분 과제를 돌리며, 대형 로봇이 쉴 때마다 탐색으로 다음 스트로크를 고른다(측면 로봇은 기존 경로).
 * @param opts { RAPIER, robots, task, lab, runEpisode, evalBatch(jobs) → Promise<results>, record?, onProgress?(p), shouldStop?() }
 * @returns { summary, out, episode, log }
 */
export async function runLab({ RAPIER, robots, task, lab, runEpisode, evalBatch, record = null, onProgress = () => {}, shouldStop = () => false }) {
  const rand = rng(lab.seed);
  const robot = robots.find((r) => r.id === task.cell.main);
  const log = { schema: 'robosim-lab-log/1', lab, task, decisions: [], library: [], startedAt: new Date().toISOString() };
  let lastCollected = 0;
  let decision = 0;
  const chooser = async ({ q, sim, evaluator }) => {
    if (shouldStop()) return null;
    const particles = snapshotParticles(sim.world);
    const sides = sim.sides;
    const th = sim.thresholds;
    // 지난 스트로크 결과 (실제 실행)
    const now = evaluator.last?.collected ?? 0;
    if (log.decisions.length) log.decisions.at(-1).actualCollected = now - lastCollected;
    lastCollected = now;
    const seedValues = ruleValues(sim.world.particleState(), sides, th, task);
    if (!particles.length || (!seedValues && particles.length < 4)) return null;
    const t0 = Date.now();
    const jobsFor = (strokes) => strokes.map((stroke) => ({ robotId: robot.id, q0: q, particles, stroke, reward: lab.reward, sides, thresholds: th }));
    const { best, trials } = await searchStroke({ lab, rand, seedValues, evalBatch: (strokes) => evalBatch(jobsFor(strokes)), shouldStop });
    if (!best || !best.result.feasible) return null;
    decision++;
    const rec = {
      n: decision, t: +evaluator.last.t.toFixed(1), rate: +evaluator.last.rateCount.toFixed(1), evalS: +((Date.now() - t0) / 1000).toFixed(1),
      trials: trials.length, ruleScore: trials.find((x) => x.rule)?.score ?? null, best: { values: best.stroke.values, rule: !!best.stroke.rule, ...pickRes(best.result) }, trialsList: trials,
    };
    log.decisions.push(rec);
    // 최선 모션 라이브러리: 점수 상위 keepTop
    log.library.push({ decision: decision, t: rec.t, values: best.stroke.values, rule: !!best.stroke.rule, ...pickRes(best.result) });
    log.library.sort((a, b) => b.score - a.score);
    log.library.length = Math.min(log.library.length, lab.keepTop);
    onProgress({ kind: 'decision', decision: rec, rate: evaluator.last.rateCount, t: evaluator.last.t });
    const s = best.stroke;
    return { lane: { start: s.start, end: s.end }, stroke: { yaw0Deg: s.yaw0Deg, yaw1Deg: s.yaw1Deg, tiltDeg: s.tiltDeg }, immersionMm: s.depthMm, sweepMmS: s.speedMmS };
  };
  const { summary, out, episode } = await runEpisode(task, {
    RAPIER, robots, record, mainChooser: chooser, shouldStop,
    onSample: (s) => onProgress({ kind: 'sample', t: s.t, rate: s.rateCount }),
  });
  if (log.decisions.length) {
    // 마지막 스트로크는 제한 시간에 걸려 끝나지 않았을 수 있다 → 헛질 집계에서 뺀다
    const last = log.decisions.at(-1);
    last.actualCollected = (summary.collected ?? 0) - lastCollected;
    last.partial = true;
  }
  const executed = log.decisions.length;
  const empties = log.decisions.filter((d) => d.actualCollected === 0 && !d.partial).length;
  log.summary = { ...summary, decisions: executed, emptyStrokes: empties, trials: log.decisions.reduce((s, d) => s + d.trials, 0), ruleChosen: log.decisions.filter((d) => d.best.rule).length };
  log.finishedAt = new Date().toISOString();
  return { summary, out, episode, log };
}

const pickRes = (r) => ({ score: +r.score.toFixed(2), collected: r.collected, wallCollected: r.wallCollected, spilled: r.spilled, durationS: r.durationS });


// ---------------------------------------------------------------------------
// 학습된 정책(PPO) 실행 — PRD FR-60·62: 관측(드로스 격자) → 정책 → 스트로크. 탐색(시도) 없이 바로 고른다(현장 적용 형태).
// ---------------------------------------------------------------------------

/** 작업 영역(스나우트 앞) 욕면 드로스 수 */
const workCountOf = (ps) => {
  let n = 0;
  for (let i = 0; i < ps.length; i += 4) if (ps[i] < SNOUT.x0) n++;
  return n;
};

/**
 * runEpisode의 mainChooser로 쓰는 정책 선택기. 결정적(평균 행동). 같은 자세에서 다시 불리면(직전 스트로크 계획 실패)
 * 표준편차만큼 흔든 행동으로 다시 시도한다(같은 실패 반복 방지).
 */
export function makePolicyChooser(agent, lab, { rand = rng(7), onDecision = () => {} } = {}) {
  let initial = null, lastQ = null, retries = 0;
  return async ({ q, sim, evaluator }) => {
    const ps = snapshotParticles(sim.world);
    const work = workCountOf(ps);
    if (initial === null) initial = work;
    if (!work) return null;
    const same = lastQ && q.every((v, i) => Math.abs(v - lastQ[i]) < 1e-6);
    retries = same ? retries + 1 : 0;
    lastQ = q.slice();
    if (retries > 6) return null;
    const obs = observe(ps, { initialCount: initial, tFrac: Math.min(1, evaluator.last.t / sim.task.timeLimitS) });
    const { u } = act(agent, obs, rand, retries === 0);
    // 계획 가능한지 먼저 확인하고, 안 되면 보정(repair)
    const fix = await planWithRepair({ robot: sim.robot, q0: q, values: decodeStroke(u, lab).values, sides: sim.sides, thresholds: sim.thresholds });
    const st = strokeFromValues(fix.values);
    onDecision({ t: evaluator.last.t, rate: evaluator.last.rateCount, values: st.values, retry: retries, repaired: fix.repaired });
    return { lane: { start: st.start, end: st.end }, stroke: { yaw0Deg: st.yaw0Deg, yaw1Deg: st.yaw1Deg, tiltDeg: st.tiltDeg }, immersionMm: st.depthMm, sweepMmS: st.speedMmS };
  };
}

/** 학습된 정책으로 과제 1회 실행 (앱 Worker·헤드리스 공통). @returns { summary, episode, log } */
export async function runPolicy({ RAPIER, robots, task, lab, agent, runEpisode, record = null, onProgress = () => {}, shouldStop = () => false }) {
  const decisions = [];
  const chooser = makePolicyChooser(agent, lab, {
    onDecision: (d) => {
      decisions.push({ n: decisions.length + 1, t: +d.t.toFixed(1), rate: +d.rate.toFixed(1), values: d.values, retry: d.retry });
      onProgress({ kind: 'policy', decision: decisions.at(-1), rate: d.rate, t: d.t });
    },
  });
  const { summary, episode } = await runEpisode(task, {
    RAPIER, robots, record, mainChooser: chooser, shouldStop,
    onSample: (s) => onProgress({ kind: 'sample', t: s.t, rate: s.rateCount }),
  });
  return { summary, episode, log: { schema: 'robosim-policy-run/1', task, decisions, summary } };
}
