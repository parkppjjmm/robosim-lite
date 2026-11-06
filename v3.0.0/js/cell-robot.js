// 드로스 셀 측면 로봇 (PRD_v.1.1.1 FR-31~34). DOM 비의존 — 브라우저(main.js)와 Node 테스트(tests/cell-robots.mjs)가 같은 코드를 쓴다.
// 포트 좌·우 벽 바깥 받침대 위에 소형·협동 로봇을 1대씩 둔다. 각 로봇은 자기 베이스 좌표계(로컬)에서 계획·안전 검사를 하고,
// 화면·물리·로봇 간 간섭 검사에는 월드 좌표로 바꿔서 쓴다.
//   모드 1 (제거): 작은 스키머로 자기 쪽 바깥 띠(|y| ≥ 구역 경계)를 떠서 자기 드로스 박스에 버린다. 대형 로봇은 안쪽 레인만 맡는다(동시 작업).
//   모드 2 (보조 밀기): 밀대로 벽 쪽 드로스를 포트 안쪽(대형 로봇 레인)으로 밀어 준다. 대형 로봇이 포트 밖(덤프)에 있을 때만 들어간다(포트 점유 잠금).
//   모드 3 (동시 밀기, v3.0.0): 밀대로 벽 쪽 드로스를 대형 구역 경계(PUSH_ASSIST.pushToMm)까지 민다. 잠금 없이 대형 로봇과 동시에 일하고,
//          대형 로봇은 가운데 구역만 맡는다(구역 분리). 서로 가까워지면 모드 1과 같이 측면 로봇이 먼저 멈춰 기다린다(양보).
import { forwardKinematics, multiply, poseMatrix, origin, homeJoints, solveIK, solveIKMulti, DEG } from './kinematics.js';
import { SKIMMER_SMALL_SPEC, RAKE_SPEC, toolBoxes, inverseToolMatrix } from './gripper.js';
import { createSafetyContext, evaluatePose, sweepCheck, capsuleSetDistance, robotSegments } from './safety.js';
import { sampleTrajectory } from './trajectory.js';
import {
  SIDE_SLOTS, sideBin, BATH_Z_MM, POT, SNOUT, SKIM, SIDE_SPLIT_Y, SIDE_BUFFER_MM, PUSH, SIDE_BIN_DISTS, drossFixtures,
  levelPose, planSkimCycle, planPushStroke, chooseLane, PUSH_ASSIST,
} from './dross.js';

export const SIDE_MODES = { 1: '모드 1 · 드로스 제거 (자기 박스에 버림)', 2: '모드 2 · 보조 밀기 (대형 로봇 쪽으로)', 3: '모드 3 · 동시 밀기 (구역 분리, 대형만 회수)' };
export const SIDE_IMMERSION_MM = 45; // 작은 스쿱 잠김 깊이 (턱 50 mm → 턱 끝이 욕면 위 5 mm)
export const SIDE_SWEEP_MMS = 120;
export const HOLD_PAD_MM = 30; // 로봇 간 간섭: 측면 로봇은 (여유거리 + 30 mm)에서 먼저 멈춰 기다린다(양보)
export const HOLD_TIMEOUT_S = 20; // 이만큼 기다려도 풀리지 않으면 알람
export const IDLE_RETRY_S = 3; // 떠낼(밀) 드로스가 없으면 이 시간 뒤 다시 본다
const SIDE_X_RANGE = [1400, 2150]; // 모드 1 스윕 X 범위(월드): 앞벽 쪽(x < 1400)은 대형 로봇의 이동 통로라 비워 둔다
const PUSH_X = [1300, 1500, 1700, 1900, 2100]; // 모드 2 밀기 레인 X(월드)
const PUSH_Y_TARGET = 250; // 모드 2 밀기 끝 |y| 목표 (도달 범위가 짧으면 그 앞에서 끝냄)

/** 측면 로봇으로 쓸 수 있는가: 소형 또는 협동 로봇(UR) */
export const sideRobotOk = (robot) => robot.sizeClass === 'small' || !!robot.cobot;

const rz = (deg) => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const mulV = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mulR = (A, B) => {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
};

/** 슬롯 좌표 변환 (베이스는 Z축 회전만 있음) */
export function slotFrame(slotId) {
  const S = SIDE_SLOTS[slotId];
  const R = rz(S.yaw), Rt = rz(-S.yaw);
  const b = S.base;
  const toWorld = (p) => {
    const v = mulV(R, p);
    return [v[0] + b[0], v[1] + b[1], v[2] + b[2]];
  };
  const toLocal = (p) => mulV(Rt, [p[0] - b[0], p[1] - b[1], p[2] - b[2]]);
  const dirLocal = ([dx, dy]) => {
    const v = mulV(Rt, [dx, dy, 0]);
    return [v[0], v[1]];
  };
  return {
    S, R, Rt, toWorld, toLocal, dirLocal,
    baseT: poseMatrix(R, b),
    /** 장애물(월드) → 로컬: 위치 변환, ZYX 회전의 Rz에서 yaw를 뺀다 (Rz(−yaw)·Rz·Ry·Rx = Rz(rz−yaw)·Ry·Rx) */
    obstacleLocal: (o) => ({ ...o, pos: toLocal(o.pos), rot: [(o.rot ?? [0, 0, 0])[0], (o.rot ?? [0, 0, 0])[1], (o.rot ?? [0, 0, 0])[2] - S.yaw] }),
    /** 캡슐·박스(로컬) → 월드 */
    segWorld: (seg) => {
      const out = { ...seg, a: seg.a && toWorld(seg.a), b: seg.b && toWorld(seg.b) };
      if (seg.box) out.box = { center: toWorld(seg.box.center), R: mulR(R, seg.box.R), half: seg.box.half };
      return out;
    },
    /** 월드 TCP 위치 + 월드 수평 방향 → 로컬 수평 자세 */
    levelLocal: (p, dirW) => levelPose(toLocal(p), dirLocal(dirW)),
    /** 박스(월드 사각형) → 로컬 사각형 + 높이 */
    binLocal: (bin) => {
      const cs = [[bin.x0, bin.y0], [bin.x1, bin.y0], [bin.x1, bin.y1], [bin.x0, bin.y1]].map(([x, y]) => toLocal([x, y, 0]));
      return { x0: Math.min(...cs.map((c) => c[0])), x1: Math.max(...cs.map((c) => c[0])), y0: Math.min(...cs.map((c) => c[1])), y1: Math.max(...cs.map((c) => c[1])), h: bin.h - b[2] };
    },
  };
}

/**
 * 측면 로봇 1대. 계획·실행 상태를 가진다. 실행은 tick(dt, env)에서 1/60 s씩:
 * 정적 안전 검사(sweepCheck, 로컬) → 로봇 간 간섭(월드, 막히면 기다림) → 적용.
 */
export class CellRobot {
  /**
   * @param slotId 'left' | 'right'
   * @param robot robots.json 항목 (sideRobotOk)
   * @param mode 1 | 2
   */
  constructor(slotId, robot, mode, { thresholds, obstaclesWorld, binDist = SIDE_BIN_DISTS[0] }) {
    this.slot = slotId;
    this.robot = robot;
    this.mode = mode === 2 || mode === 3 ? mode : 1;
    this.binDist = binDist;
    this.spec = this.mode === 1 ? { ...SKIMMER_SMALL_SPEC } : { ...RAKE_SPEC };
    this.F = slotFrame(slotId);
    this.side = this.F.S.side;
    this.thresholds = thresholds;
    this.run = null; // { steps, i, t, kind: 'skim'|'push', label }
    this.status = 'idle'; // idle | running | holding | waiting | error
    this.label = '';
    this.error = null;
    this.cycles = 0;
    this.holdS = 0;
    this.idleS = 0;
    this.lastLane = -1;
    this.minOtherMm = Infinity; // 실행 중 다른 로봇과의 최소 거리 (검증용)
    this.setEnvironment(obstaclesWorld, thresholds, homeJoints(robot));
    this.q = this.findPark() ?? homeJoints(robot);
    this.current = evaluatePose(this.ctx, this.q);
    this.lanes = this.computeLanes();
  }

  get id() {
    return this.slot;
  }

  /** 정적 환경(설비 + 물체, 월드) → 로컬 안전 컨텍스트. 자기 받침대는 베이스 아래라 제외한다 */
  setEnvironment(obstaclesWorld, thresholds = this.thresholds, q = this.q) {
    this.thresholds = thresholds;
    const own = `cell:ped-${this.slot}`;
    this.ctx = createSafetyContext(this.robot, {
      features: { selfCollision: true, obstacleCollision: true, singularity: false },
      thresholds,
      obstacles: obstaclesWorld.filter((o) => o.id !== own).map(this.F.obstacleLocal),
      floor: false, // 받침대 위라 로컬 z = 0은 바닥이 아니다 (월드 바닥은 포트 벽·받침대가 막는다)
      tool: { spec: this.spec, opening: 0 },
      physicsMode: true,
    });
    this.obstaclesWorld = obstaclesWorld;
    if (q) this.current = evaluatePose(this.ctx, q);
  }

  /** 물리 모드: 움직이는 물체의 현재 위치를 로컬 검사에 반영 */
  updateObjectPoses(poses) {
    for (const ob of this.ctx.compiled) {
      const p = poses.get(ob.id);
      if (!p) continue;
      ob.pos = this.F.toLocal(p.pos);
      ob.R = mulR(this.F.Rt, p.R);
    }
  }

  /**
   * 대기 자세(park) 후보: 자기 쪽 포트 벽 위, 툴은 아래, 포트 안쪽을 봄 — 대형 로봇과 겹치지 않는 자리.
   * 팔이 긴 로봇은 베이스 바로 위로 접기 어려워 조금 높고 먼 후보도 둔다. 첫 번째로 되는 후보를 쓴다.
   */
  parkCandidates() {
    const x = this.F.S.base[0], s = this.side;
    return [[x, s * 980, 1000], [x, s * 960, 1150], [x + 250, s * 960, 1100], [x - 250, s * 960, 1100], [x, s * 940, 1300]];
  }

  parkLocal() {
    const p = this.parkCandidates()[this.parkIndex ?? 0];
    return this.F.levelLocal(p, [0, -this.side]);
  }

  findPark() {
    const cands = this.parkCandidates();
    for (let i = 0; i < cands.length; i++) {
      const T = multiply(this.F.levelLocal(cands[i], [0, -this.side]), inverseToolMatrix(this.spec.lengthMm));
      const sols = solveIKMulti(this.robot, T, { seeds: [homeJoints(this.robot)], reference: homeJoints(this.robot), randomSeeds: 40 });
      const q = sols.find((qq) => evaluatePose(this.ctx, qq).violations.length === 0);
      if (q) {
        this.parkIndex = i;
        return q;
      }
    }
    return null;
  }

  /** 로컬 TCP 자세가 도달 가능하고 정적 위반이 없으면 관절값 */
  feasible(Tlocal, seed) {
    const ik = solveIK(this.robot, multiply(Tlocal, inverseToolMatrix(this.spec.lengthMm)), seed, { maxIter: 80 });
    if (!ik.ok) return null;
    return evaluatePose(this.ctx, ik.joints).violations.length === 0 ? ik.joints : null;
  }

  /**
   * 레인 계산 (설치 시 1회): 도달·충돌 가능한 구간만 남긴다.
   * 모드 1: 바깥 띠의 Y 레인(스쿱 반폭·구역 경계·벽 여유) × X 범위(−X 방향 스윕)
   * 모드 2: X 레인 × (벽 쪽 시작 → 안쪽 |y| 250 목표, 도달 범위까지)
   */
  computeLanes() {
    const m = this.thresholds.obstacleMarginMm + SKIM.clearanceMm;
    const s = this.side;
    const lanes = [];
    const seed0 = this.q;
    if (this.mode === 1) {
      const hy = this.spec.plateYMm / 2, hx = this.spec.plateXMm / 2;
      const lo = SIDE_SPLIT_Y + SIDE_BUFFER_MM + hy, hi = POT.y1 - hy - m;
      const n = Math.max(1, Math.ceil((hi - lo) / (this.spec.plateYMm * SKIM.laneOverlap)) + 1);
      const z = BATH_Z_MM - SIDE_IMMERSION_MM;
      const xMax = Math.min(SIDE_X_RANGE[1], SNOUT.x0 - hx - m), xMin = Math.max(SIDE_X_RANGE[0], POT.x0 + hx + m);
      for (let i = 0; i < n; i++) {
        const y = s * (n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1));
        const run = this.scan((x) => this.F.levelLocal([x, y, z], [-1, 0]), xMax, xMin, -25, seed0);
        if (!run || run.from - run.to < 200) continue;
        lanes.push(this.makeLane(lanes.length, [run.from, y], [run.to, y], hy));
      }
    } else {
      const z = BATH_Z_MM - PUSH.immersionMm;
      const r = this.spec.bladeHMm / 2;
      const y0 = POT.y1 - m - r;
      for (const x of PUSH_X) {
        const run = this.scan((yy) => this.F.levelLocal([x, s * yy, z], [0, -s]), y0, this.mode === 3 ? PUSH_ASSIST.pushToMm : PUSH_Y_TARGET, -25, seed0);
        if (!run || run.from - run.to < 150) continue;
        lanes.push(this.makeLane(lanes.length, [x, s * run.from], [x, s * run.to], this.spec.bladeWMm / 2));
      }
    }
    return lanes;
  }

  /** from에서 to 방향으로 step씩 가며 처음부터 연속으로 가능한 구간 { from, to } (첫 점이 안 되면 첫 가능한 점부터) */
  scan(poseAt, from, to, step, seed) {
    let start = null, last = null, q = seed;
    for (let v = from; step < 0 ? v >= to : v <= to; v += step) {
      const sol = this.feasible(poseAt(v), q);
      if (sol) {
        q = sol;
        if (start === null) start = v;
        last = v;
      } else if (start !== null) break;
    }
    return start === null ? null : { from: start, to: last };
  }

  makeLane(index, startW, endW, halfWidth) {
    return { index, startW, endW, halfWidth, start: this.F.toLocal([...startW, 0]).slice(0, 2), end: this.F.toLocal([...endW, 0]).slice(0, 2) };
  }

  /** 현재 자세의 캡슐(월드) — 화면·로봇 간 간섭용 */
  worldSegments(e = this.current) {
    return e.segments.map(this.F.segWorld);
  }

  /** 물리 바디용 형상(월드): 링크 캡슐 + 툴 박스 (보수 캡슐 'plate'는 빼고 실제 형상) */
  physicsShapes(e = this.current) {
    const segs = e.segments.filter((s) => s.part !== 'plate');
    return [...segs, ...toolBoxes(this.spec, e.frames[6])].map(this.F.segWorld);
  }

  /** 지금 포트 안에서 일하는 중인가 (모드 2 잠금 판단) */
  get inPot() {
    return this.status === 'running' || this.status === 'holding';
  }

  /**
   * 다음 작업 계획 (레인 선택 → 계획). 성공하면 실행을 시작한다.
   * @param particles physics.particleState()
   * @returns 'started' | 'empty' | 'failed'
   */
  async planNext(particles, obstaclesWorld, others = []) {
    // 직전에 '다른 로봇이 경로에 있음'으로 미룬 계획: 자세가 그대로면 다시 계획하지 않고 경로 확인만 한다 (계획 비용 절약)
    const qKey = this.current.q.map((v) => v.toFixed(3)).join();
    if (this.pending && this.pending.qKey === qKey && this.pending.tries < 10) {
      this.pending.tries++;
      const clash = this.pathClash(this.pending.res.steps, others);
      if (clash) {
        this.label = `${clash} 경로에 있음 — 대기`;
        return 'blocked';
      }
      return this.startPlan(this.pending.res, this.pending.pick);
    }
    this.pending = null;
    if (obstaclesWorld) this.setEnvironment(obstaclesWorld, this.thresholds, this.current.q);
    const spec = this.mode === 1 ? this.spec : { plateXMm: 0, plateYMm: this.spec.bladeWMm };
    // 실패한 레인은 다음 3번의 계획에서 빼 둔다 (같은 레인에서 비싼 실패 계획을 반복하지 않도록)
    this.cool ??= new Map();
    for (const [k, v] of this.cool) v <= 1 ? this.cool.delete(k) : this.cool.set(k, v - 1);
    const lanes = this.lanes.filter((l) => !this.cool.has(l.index));
    const pick = lanes.length ? chooseLane(lanes, particles, spec, this.lastLane) : null;
    if (!pick || pick.count < 1) return 'empty';
    const obstacles = this.obstaclesWorld.filter((o) => o.id !== `cell:ped-${this.slot}`).map(this.F.obstacleLocal);
    const bz = this.F.S.base[2];
    let res;
    if (this.mode === 1) {
      const r = Math.max(this.spec.plateYMm / 6, this.spec.lipMm, this.spec.plateThickMm);
      res = await planSkimCycle({
        robot: this.robot, q0: this.current.q.slice(), spec: this.spec, lane: pick.lane, immersionMm: SIDE_IMMERSION_MM, sweepMmS: SIDE_SWEEP_MMS,
        obstacles, thresholds: this.thresholds, floor: false,
        cell: { bathZ: BATH_Z_MM - bz, liftZ: POT.rimZ + r + this.thresholds.obstacleMarginMm + 60 - bz, bin: this.F.binLocal(sideBin(this.slot, this.binDist)) },
      }, { plan: null });
    } else {
      res = await planPushStroke({
        robot: this.robot, q0: this.current.q.slice(), spec: this.spec, start: pick.lane.start, end: pick.lane.end, park: this.parkLocal(),
        obstacles, thresholds: this.thresholds, cell: { bathZ: BATH_Z_MM - bz, liftZ: 1000 - bz },
      });
    }
    if (!res.ok) {
      this.error = res.message;
      this.lastLane = pick.lane.index; // 같은 레인만 반복해서 실패하지 않도록
      this.cool.set(pick.lane.index, 3);
      return 'failed';
    }
    this.error = null;
    this.lastLane = pick.lane.index;
    // 시작 전 확인: 계획한 경로 전체가 지금 다른 로봇의 자세와 (여유거리 + 30 mm) 이상 떨어져 있어야 시작한다.
    // 서 있는 로봇의 길을 막고 서로 기다리는 교착을 막는다 (대형 로봇은 이 동안 움직이지 않거나 포트 밖에 있음)
    const clash = this.pathClash(res.steps, others);
    if (clash) {
      this.label = `${clash} 경로에 있음 — 대기`;
      this.pending = { res, pick, qKey, tries: 0 };
      return 'blocked';
    }
    return this.startPlan(res, pick);
  }

  startPlan(res, pick) {
    this.pending = null;
    this.plan = { lane: pick.lane, count: pick.count, vertices: res.vertices, steps: res.steps };
    this.run = { steps: res.steps, i: 0, t: 0, kind: this.mode === 1 ? 'skim' : 'push', laneIndex: pick.lane.index };
    this.status = 'running';
    this.label = `레인 ${pick.lane.index + 1}/${this.lanes.length} (드로스 ${pick.count}개)`;
    return 'started';
  }

  /** 계획 경로가 다른 로봇(현재 자세)과 가까워지는가 → 그 로봇 이름 또는 null */
  pathClash(steps, others) {
    if (!others.length) return null;
    const lim = this.thresholds.obstacleMarginMm + HOLD_PAD_MM;
    for (const st of steps) {
      if (st.kind !== 'move') continue;
      const pts = st.trajectory.points;
      for (let k = 0; k < pts.length; k += 3) {
        const segs = robotSegments(this.ctx, forwardKinematics(this.robot, pts[k]).frames).map(this.F.segWorld);
        for (const o of others) if (capsuleSetDistance(segs, o.segments).d < lim) return o.name ?? o.id;
      }
    }
    return null;
  }

  stop() {
    this.run = null;
    this.status = 'idle';
    this.label = '';
    this.holdS = 0;
  }

  /**
   * 1/60 s 진행. env = { others: [{ id, segments(월드) }], paused, onBlocked(robot, result) }
   * @returns 'moved' | 'held' | 'done' | 'blocked' | 'idle'
   */
  tick(dt, env) {
    const run = this.run;
    if (!run || env.paused) return 'idle';
    const st = run.steps[run.i];
    if (!st) {
      this.stop();
      this.cycles++;
      return 'done';
    }
    if (st.kind === 'action') {
      run.t += dt;
      this.label = st.label;
      if (run.t >= (st.sec ?? 0)) { run.i++; run.t = 0; }
      return 'moved';
    }
    const tr = st.trajectory;
    const tNext = Math.min(tr.duration, run.t + dt);
    const q1 = sampleTrajectory(tr, tNext);
    const res = sweepCheck(this.ctx, this.current, q1);
    if (!res.ok) {
      this.status = 'error';
      this.run = null;
      env.onBlocked?.(this, res);
      return 'blocked';
    }
    // 로봇 간 간섭: 다른 로봇과 (여유거리 + 30 mm)보다 가까워지면 그 자리에서 기다린다
    const segs = this.worldSegments(res.last);
    let dMin = Infinity, who = null;
    for (const o of env.others ?? []) {
      const d = capsuleSetDistance(segs, o.segments).d;
      if (d < dMin) { dMin = d; who = o; }
    }
    if (dMin < this.thresholds.obstacleMarginMm + HOLD_PAD_MM) {
      this.status = 'holding';
      this.holdS += dt;
      this.label = `간섭 회피 대기 (${who.name ?? who.id}, ${Math.max(0, dMin).toFixed(0)} mm)`;
      if (this.holdS > HOLD_TIMEOUT_S) {
        this.status = 'error';
        this.run = null;
        env.onBlocked?.(this, { reason: 'hold-timeout', other: who });
        return 'blocked';
      }
      return 'held';
    }
    this.minOtherMm = Math.min(this.minOtherMm, dMin);
    this.status = 'running';
    this.holdS = 0;
    this.current = res.last;
    this.q = res.last.q;
    run.t = tNext;
    this.label = st.label;
    if (run.t >= tr.duration - 1e-9) { run.i++; run.t = 0; }
    return 'moved';
  }
}

/**
 * 셀 조정기: 측면 로봇들의 자동 작업과 모드 2 포트 점유 잠금을 관리한다.
 * 대형 로봇은 main.js(또는 테스트의 실행기)가 움직이고, 포트에 들어갈 때 wantsPot을 세운다.
 *   - 모드 2 로봇은 wantsPot이 false일 때만 새 밀기를 시작한다.
 *   - 대형 로봇은 모드 2 로봇이 포트 안에 있는 동안(sideInPot) 레인 접근을 기다린다.
 */
export class CellCoordinator {
  constructor() {
    this.robots = new Map(); // slot → CellRobot
    this.main = { wantsPot: false };
    this.active = false; // 측면 자동 작업 중
    this.budget = Infinity; // 남은 작업 수 (1사이클 = 1)
    this.planning = new Set();
  }

  /** 모드 2 로봇이 포트 안에서 일하는 중 */
  sideInPot() {
    for (const r of this.robots.values()) if (r.mode === 2 && (r.inPot || this.planning.has(r.slot))) return true;
    return false;
  }

  start(budget = Infinity) {
    this.active = true;
    for (const r of this.robots.values()) {
      r.budget = budget;
      r.idleS = 0;
      r.error = null;
      if (r.status === 'error') r.status = 'idle';
    }
  }

  stop() {
    this.active = false;
    for (const r of this.robots.values()) r.stop();
  }

  get busy() {
    for (const r of this.robots.values()) if (r.run || this.planning.has(r.slot)) return true;
    return false;
  }

  /**
   * 1/60 s 진행: 실행 중인 로봇은 tick, 쉬는 로봇은 (자동 작업 중이고 조건이 맞으면) 다음 작업을 계획한다.
   * @param env { mainSegments(월드), mainName, particles(), obstaclesWorld(), paused, onBlocked, onPlanFail }
   */
  tick(dt, env) {
    const list = [...this.robots.values()];
    for (const r of list) {
      const others = [{ id: 'main', name: env.mainName ?? '대형 로봇', segments: env.mainSegments }];
      for (const o of list) if (o !== r) others.push({ id: o.slot, name: `${o.F.S.label} 측면 로봇`, segments: o.worldSegments() });
      if (r.run) {
        r.tick(dt, { others, paused: env.paused, onBlocked: env.onBlocked });
        continue;
      }
      if (!this.active || env.paused || r.status === 'error' || this.planning.has(r.slot) || !(r.budget > 0)) continue;
      if (r.mode === 2 && this.main.wantsPot) {
        r.label = '대형 로봇이 포트 안 작업 중 — 대기';
        continue;
      }
      if (r.idleS > 0) {
        r.idleS -= dt;
        continue;
      }
      this.planning.add(r.slot);
      r.label = '계획 중…';
      const done = (res) => {
        this.planning.delete(r.slot);
        if (res === 'started') r.budget--;
        else if (res === 'blocked') r.idleS = 1;
        else if (res === 'empty') {
          r.idleS = IDLE_RETRY_S;
          r.label = r.mode === 1 ? '맡은 띠에 떠낼 드로스가 없음 — 대기' : '밀어 줄 드로스가 없음 — 대기';
          if (this.budget !== Infinity) r.budget = 0;
        } else {
          r.idleS = IDLE_RETRY_S;
          env.onPlanFail?.(r);
        }
      };
      r.planNext(env.particles(), env.obstaclesWorld(), others).then(done, (err) => {
        r.error = String(err?.message ?? err);
        done('failed');
      });
    }
  }
}

const binDistCache = new Map();
/**
 * 측면 박스 거리 고르기 (모드 1): SIDE_BIN_DISTS 후보마다 실제로 레인별 스키밍 사이클을 계획해 보고
 * 성공한 레인이 가장 많은 거리를 쓴다(같으면 앞 후보). 하나도 안 되면 null → 이 로봇은 모드 1 불가(도달 범위 부족).
 * 결과는 로봇·슬롯별로 기억한다(같은 입력 → 같은 결과).
 */
export async function pickSideBinDist(robot, slot, thresholds) {
  const key = `${robot.id}:${slot}:${thresholds.obstacleMarginMm}`;
  if (binDistCache.has(key)) return binDistCache.get(key);
  let best = null, bestN = 0;
  for (const dist of SIDE_BIN_DISTS) {
    const sides = { [slot]: { robotId: robot.id, mode: 1, binDist: dist } };
    const fx = drossFixtures(sides);
    const cr = new CellRobot(slot, robot, 1, { thresholds, obstaclesWorld: fx, binDist: dist });
    let n = 0;
    const total = cr.lanes.length;
    for (const lane of cr.lanes.slice()) {
      const parts = { n: 1, buf: new Float64Array([(lane.startW[0] + lane.endW[0]) / 2, lane.startW[1], BATH_Z_MM, 30]) };
      cr.lastLane = -1;
      cr.lanes = [lane];
      if ((await cr.planNext(parts, fx)) === 'started') n++;
      cr.stop();
    }
    if (n > bestN) { best = dist; bestN = n; }
    if (n > 0 && n === total) break; // 모든 레인이 되면 더 볼 필요 없음
  }
  binDistCache.set(key, best);
  return best;
}
