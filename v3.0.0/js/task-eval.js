// 작업 설정(Task)과 평가기 (PRD_v.3.0.0 2장, FR-54). DOM 비의존 — 브라우저·Node(헤드리스 시뮬레이터·학습 환경)에서 함께 쓴다.
// 성공 판정: 제한 시간 안에 (모든 드로스 박스에 들어간 드로스) ÷ (스나우트 앞 작업 영역 드로스) ≥ 목표 회수율.
// 회수율은 셀 합계 기준(D7). 스나우트 너머(FAR_ZONE)에서 시작한 드로스는 분자·분모 모두에서 뺀다.
import { WORK_ZONE, FAR_ZONE, BATH_Z_MM, DROSS_DEFAULTS, DROSS_LIMITS, drossRobotOk, sideBinDistFor } from './dross.js';
import { sideRobotOk } from './cell-robot.js';

export const TASK_SLOTS = ['main', 'left', 'right'];
export const TASK_LIMITS = { targetRatePct: [10, 100], timeLimitS: [30, 3600] };
/** 안전 검사 기준값 (드로스 셀 기본, tests/cell-robots.mjs와 같음) */
export const TASK_THRESHOLDS = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };

/** 기본 작업 (PRD 0장 결정): 목표 80%, 10분, 작업 영역, AI = 대형 로봇, 측면 없음, 드로스 160개·시드 11 */
export const TASK_DEFAULTS = Object.freeze({
  targetRatePct: 80,
  zone: 'work',
  timeLimitS: 600,
  aiRobot: { slot: 'main' },
  cell: { main: 'kuka-kr210-r2700', left: { robotId: null, mode: 1 }, right: { robotId: null, mode: 1 } },
  dross: { count: 160, seed: 11, ratePerMin: 0, immersionMm: DROSS_DEFAULTS.immersionMm, sweepMmS: DROSS_DEFAULTS.sweepMmS },
  sensors: [{ id: 'top', pos: [1700, 0, 4700], lookAt: [1700, 0, BATH_Z_MM], fovDeg: 70, res: [640, 480] }],
});

const num = (v, d, [lo, hi]) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

/**
 * 작업 설정 검증·보정. robots = robots.json의 목록.
 * @returns {{ task, errors: string[] }} errors가 있으면 실행하지 않는다 (예: 측면 로봇 모드 1인데 박스 덤프 자세가 없음)
 */
export function sanitizeTask(raw = {}, robots = []) {
  const D = TASK_DEFAULTS;
  const byId = (id) => robots.find((r) => r.id === id);
  const errors = [];
  const cellIn = raw.cell ?? {};
  const main = byId(cellIn.main ?? D.cell.main);
  if (!main) errors.push(`대형 로봇 모델을 찾을 수 없습니다: ${cellIn.main}`);
  else if (!drossRobotOk(main)) errors.push(`${main.name}은(는) 드로스 셀 대형 로봇으로 쓸 수 없습니다(도달거리 부족).`);
  const side = (slot) => {
    const s = { ...D.cell[slot], ...(cellIn[slot] ?? {}) };
    const mode = s.mode === 2 || s.mode === 3 ? s.mode : 1; // 3 = 동시 밀기 (v3.0.0)
    if (!s.robotId) return { robotId: null, mode };
    const r = byId(s.robotId);
    if (!r) errors.push(`${slot} 측면 로봇 모델을 찾을 수 없습니다: ${s.robotId}`);
    else if (!sideRobotOk(r)) errors.push(`${r.name}은(는) 측면 로봇으로 쓸 수 없습니다(소형·협동 로봇만).`);
    else if (mode === 1 && sideBinDistFor(r.id) == null) errors.push(`${r.name}은(는) 모드 1(측면 박스 덤프)을 할 수 없습니다.`);
    return { robotId: s.robotId, mode };
  };
  const cell = { main: main?.id ?? D.cell.main, left: side('left'), right: side('right') };
  const slot = TASK_SLOTS.includes(raw.aiRobot?.slot) ? raw.aiRobot.slot : D.aiRobot.slot;
  const aiId = slot === 'main' ? cell.main : cell[slot].robotId;
  if (!aiId) errors.push(`AI 로봇 슬롯(${slot})에 로봇이 없습니다.`);
  const dIn = { ...D.dross, ...(raw.dross ?? {}) };
  const dross = {
    count: Math.round(num(dIn.count, D.dross.count, DROSS_LIMITS.count)),
    seed: Math.round(num(dIn.seed, D.dross.seed, DROSS_LIMITS.seed)),
    ratePerMin: num(dIn.ratePerMin, D.dross.ratePerMin, DROSS_LIMITS.ratePerMin),
    immersionMm: num(dIn.immersionMm, D.dross.immersionMm, DROSS_LIMITS.immersionMm),
    sweepMmS: num(dIn.sweepMmS, D.dross.sweepMmS, DROSS_LIMITS.sweepMmS),
  };
  const sensors = Array.isArray(raw.sensors) && raw.sensors.length ? raw.sensors.slice(0, 4) : D.sensors.map((s) => ({ ...s }));
  const task = {
    targetRatePct: num(raw.targetRatePct, D.targetRatePct, TASK_LIMITS.targetRatePct),
    zone: 'work', // v3.0.0: 스나우트 앞 작업 영역만 (사용자 결정 D4)
    timeLimitS: num(raw.timeLimitS, D.timeLimitS, TASK_LIMITS.timeLimitS),
    aiRobot: { slot, robotId: aiId ?? null },
    cell,
    dross,
    sensors,
    // 대형 로봇 규칙 경로 옵션 (AI가 아닌 규칙 운전일 때): 쓸기 방향 robot | snout | alternate
    mainRule: { laneDir: ['robot', 'snout', 'alternate'].includes(raw.mainRule?.laneDir) ? raw.mainRule.laneDir : 'robot' },
  };
  return { task, errors };
}

const inZone = (z, x, y) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;

/**
 * 회수율 평가기. 시작 시점(드로스가 욕면에 자리 잡은 뒤)에 begin(), 이후 원할 때 sample(t), 끝에 summary().
 * 분모 = 시작 시 작업 영역 욕면 드로스 + 이후 작업 영역에 새로 생긴 드로스. 분자 = 그중 드로스 박스에 들어간 것.
 * 개수와 질량을 함께 센다. 박스별 집계로 로봇별 기여(박스 id = main/left/right)를 낸다.
 */
export class TaskEvaluator {
  /**
   * @param task sanitizeTask 결과
   * @param physics PhysicsWorld (particles, particleState)
   * @param bins drossBins(sides) — { id, x0, x1, y0, y1, h, wall }
   */
  constructor(task, physics, bins) {
    this.task = task;
    this.physics = physics;
    this.bins = bins.map((b) => ({ id: b.id, h: b.h, x0: b.x0 + b.wall, x1: b.x1 - b.wall, y0: b.y0 + b.wall, y1: b.y1 - b.wall }));
    this.counted = new Set(); // 분모에 들어간 입자 번호
    this.far = new Set(); // 스나우트 너머에서 시작한 입자 (제외)
    this.t0 = null;
    this.reachS = null;
    this.last = null;
    this.history = []; // [t, rateCount, rateMass]
  }

  /** 지금 욕면 위 입자를 작업 영역 / 스나우트 너머로 나눠 기억한다 */
  begin(t = 0) {
    this.t0 = t;
    this.scan(true);
    this.sample(t);
  }

  /** 새로 생긴 입자(발생률 > 0)를 분모에 더한다 */
  scan(initial = false) {
    const ps = this.physics.particles;
    const { buf } = this.physics.particleState();
    for (let i = 0; i < ps.length; i++) {
      if (this.counted.has(i) || this.far.has(i)) continue;
      const x = buf[i * 4], y = buf[i * 4 + 1];
      if (inZone(FAR_ZONE, x, y)) this.far.add(i);
      else if (inZone(WORK_ZONE, x, y)) this.counted.add(i);
      else if (initial) this.far.add(i); // 시작 시 영역 밖(드문 경우)은 제외
    }
  }

  /** 현재 상태를 세고 목표 도달 시각을 기록한다 */
  sample(t) {
    this.scan();
    const ps = this.physics.particles;
    const { buf } = this.physics.particleState();
    const bins = Object.fromEntries(this.bins.map((b) => [b.id, { n: 0, kg: 0 }]));
    let n = 0, kg = 0, totN = 0, totKg = 0, workN = 0, spilled = 0;
    for (const i of this.counted) {
      const p = ps[i];
      totN++;
      totKg += p.massKg;
      if (p.out) continue;
      const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
      const bin = this.bins.find((b) => inZone(b, x, y) && z < b.h + 60);
      if (bin) {
        n++;
        kg += p.massKg;
        bins[bin.id].n++;
        bins[bin.id].kg += p.massKg;
      } else if (Math.abs(z - BATH_Z_MM) < p.r + 40 && inZone(WORK_ZONE, x, y)) workN++;
      else if (z < 200) spilled++;
    }
    const rateCount = totN ? (100 * n) / totN : 0;
    const rateMass = totKg ? (100 * kg) / totKg : 0;
    const el = t - this.t0;
    if (this.reachS === null && rateCount >= this.task.targetRatePct) this.reachS = el;
    this.last = { t: el, rateCount, rateMass, collected: n, collectedKg: kg, total: totN, totalKg: totKg, remaining: workN, spilled, bins };
    this.history.push([+el.toFixed(2), +rateCount.toFixed(2), +rateMass.toFixed(2)]);
    return this.last;
  }

  /** 결과 요약: 회수율(개수·질량), 목표 도달 시각, 로봇별 기여, AI 로봇 기여 */
  summary() {
    const L = this.last;
    const slot = this.task.aiRobot.slot;
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      targetRatePct: this.task.targetRatePct,
      timeLimitS: this.task.timeLimitS,
      rateCount: r1(L.rateCount),
      rateMass: r1(L.rateMass),
      reached: this.reachS !== null && this.reachS <= this.task.timeLimitS,
      reachS: this.reachS === null ? null : r1(this.reachS),
      collected: L.collected,
      total: L.total,
      remaining: L.remaining,
      spilled: L.spilled,
      byRobot: Object.fromEntries(Object.entries(L.bins).map(([k, v]) => [k, { n: v.n, kg: r1(v.kg) }])),
      aiSlot: slot,
      aiShareCount: L.collected ? r1((100 * (L.bins[slot]?.n ?? 0)) / L.collected) : 0,
    };
  }
}
