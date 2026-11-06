// 헤드리스 셀 시뮬레이터 (PRD_v.3.0.0 FR-55). DOM 비의존 — Node(기준선·학습 환경·테스트)에서 쓴다. 브라우저 main.js 루프는 바꾸지 않았다.
// v1.1.1 tests/cell-robots.mjs의 simulate() 루프를 모듈로 옮겼다. 순서(60 Hz): 측면 로봇 → 대형 로봇(다른 로봇 포함 적용 전 검사) → 물리.
// 대형 로봇 슬롯은 두 가지로 움직일 수 있다.
//   - 'rule'   : 기존 v1.1.2 경로(레인 선택 → planSkimCycle → 궤적 실행) — 1/60 s마다 궤적 표본
//   - 'policy' : 외부 컨트롤러가 50 ms(20 Hz)마다 관절 변화량 Δq(J1~J6, deg)를 낸다 → 3스텝에 나눠 적용, 매 스텝 적용 전 검사
// 측면 로봇 슬롯의 정책 제어는 4단계(스킬 실행기)에서 붙인다. 지금은 측면 = 항상 기존 규칙(CellCoordinator).
import { homeJoints } from './kinematics.js';
import { SKIMMER_SPEC, skimmerBoxes } from './gripper.js';
import { createSafetyContext, evaluatePose, sweepCheck, capsuleSetDistance } from './safety.js';
import { sampleTrajectory } from './trajectory.js';
import { planPath } from './planner.js';
import { PhysicsWorld } from './physics.js';
import { drossFixtures, drossBins, DrossField, skimLanes, mainLaneRange, chooseLane, planSkimCycle, sideBinDistFor } from './dross.js';
import { CellRobot, CellCoordinator } from './cell-robot.js';
import { TaskEvaluator, TASK_THRESHOLDS } from './task-eval.js';

export const SIM_DT = 1 / 60;
export const CONTROL_HZ = 20;
export const TICKS_PER_CONTROL = Math.round(1 / (SIM_DT * CONTROL_HZ)); // 3
const WARMUP_TICKS = 90; // 드로스가 욕면에 자리 잡는 시간 (1.5 s)
// 이벤트 루프 양보: Node는 setImmediate, 브라우저 Worker는 MessageChannel(setTimeout 0의 4 ms 지연을 피함)
const yieldLoop = typeof setImmediate === 'function'
  ? () => new Promise((r) => setImmediate(r))
  : (() => {
    const ch = new MessageChannel();
    const q = [];
    ch.port1.onmessage = () => q.shift()?.();
    return () => new Promise((r) => {
      q.push(r);
      ch.port2.postMessage(0);
    });
  })();

/**
 * 대형 로봇 규칙 운전기 (v1.1.2 동작 그대로): 레인 선택 → 사이클 계획 → 단계별 궤적.
 * target()이 다음 1/60 s의 목표 관절값을 내고(없으면 null = 그대로 있기), 적용이 끝나면 commit(), 막히면 abort().
 */
export class RuleMainDriver {
  constructor({ robot, spec, fixtures, world, coord, sides, thresholds, task, deterministic, chooser = null }) {
    Object.assign(this, { robot, spec, fixtures, world, coord, thresholds, task, deterministic, chooser });
    this.sim = null; // runEpisode가 채움 (chooser에 넘김)
    this.evaluator = null;
    this.anyMode2 = [...coord.robots.values()].some((r) => r.mode >= 2); // 모드 2·3: 포트 점유 잠금
    this.lanes = skimLanes(spec, thresholds.obstacleMarginMm, mainLaneRange(spec, sides));
    // 쓸기 방향 (v3.0.0, 2026-11-06 사용자 제안): 'robot' = 스나우트 쪽에서 로봇 쪽으로(열린 면이 로봇을 봄, v1.1.2 기본)
    //   'snout' = 로봇 쪽에서 스나우트 쪽으로(열린 면이 스나우트를 봄 → 스나우트 앞 드로스를 끝까지 밀어 담음), 'alternate' = 번갈아
    this.laneDir = task.mainRule?.laneDir ?? 'robot';
    this.dirFlip = false;
    this.run = null;
    this.lastLane = -1;
    this.cycles = 0;
    this.planFail = [];
    this.pending = null;
    this.inPotPhase = false;
    this.empty = false;
    this.retryS = 0; // 계획 실패 뒤 다시 시도까지 남은 시간 (매 스텝 같은 실패를 되풀이하지 않게)
    this.laneFails = new Map(); // 레인 번호 → 연속 실패 횟수 (2번 실패한 레인은 건너뜀)
    this.gaveUp = false; // 모든 레인 실패 → 대형 로봇 작업 중단 (앱에서는 오류로 멈춤)
  }

  /** 다음 사이클 계획 (await 하는 동안 시뮬레이션 시간은 흐르지 않는다 — v1.1.1 테스트와 같음) */
  async start(q) {
    if (this.gaveUp) return;
    if (this.retryS > 0) {
      this.retryS -= SIM_DT;
      return;
    }
    const lanes = this.lanes.filter((l) => (this.laneFails.get(l.index) ?? 0) < 2);
    if (!lanes.length) {
      this.gaveUp = true;
      this.coord.main.wantsPot = false;
      return;
    }
    if (this.anyMode2) this.coord.main.wantsPot = true;
    this.coord.main.etaS = 0;
    // 모드 2·3: 측면 로봇이 아직 포트에 있으면 나간 뒤(대기 자세)에 계획한다 — 그래야 대기 자세를 장애물로 넣은 경로가 된다
    if (this.anyMode2 && this.coord.sideInPot()) {
      this.waitingSide = true;
      return;
    }
    this.waitingSide = false;
    let pick, stroke = null, immersionMm = this.task.dross.immersionMm, sweepMmS = this.task.dross.sweepMmS;
    if (this.chooser) {
      // v3.0.0 학습: 외부 선택기(탐색·정책)가 다음 스트로크를 정한다 (기다리는 동안 시뮬레이션 시간은 멈춰 있음)
      const c = await this.chooser({ q: q.slice(), sim: this.sim, evaluator: this.evaluator });
      if (!c) {
        this.coord.main.wantsPot = false;
        this.empty = true;
        this.retryS = 3;
        return;
      }
      pick = { lane: { ...c.lane, index: -1 }, count: 1 };
      stroke = c.stroke ?? null;
      immersionMm = c.immersionMm ?? immersionMm;
      sweepMmS = c.sweepMmS ?? sweepMmS;
    } else {
      pick = chooseLane(lanes, this.world.particleState(), this.spec, this.lastLane);
      // 측면 로봇이 있는 셀에서는 규칙 경로의 스나우트 쪽 쓸기가 측면 로봇과 19 mm까지 가까워져 안전 게이트에 막힌다(2026-11-06 측정,
      // 가운데 레인만 써도 같음) → 규칙 경로는 대형 단독 셀에서만 적용. 측면 로봇 셀의 반대 방향 운반은 학습 단계(충돌 검사된 후보만 채택)에서 다룬다.
      const toSnout = (this.laneDir === 'snout' || (this.laneDir === 'alternate' && this.dirFlip)) && !this.coord.robots.size;
      if (pick && toSnout) pick = { ...pick, lane: { ...pick.lane, start: [pick.lane.xe, pick.lane.y], end: [pick.lane.xs, pick.lane.y] } };
    }
    if (!pick || pick.count < 1) {
      this.coord.main.wantsPot = false;
      this.empty = true;
      return;
    }
    this.empty = false;
    const { robot, thresholds, fixtures } = this;
    // 대기 중인 측면 로봇 팔(현재 자세)을 상자 장애물로 계획에 넣는다 (v3.0.0: 스나우트 쪽 쓸기의 레인 접근 경로가
    // 대기 자세의 측면 로봇과 19 mm까지 가까워져 안전 게이트에 막힌 문제). 움직이는 중인 측면 로봇은 넣지 않는다(실행 중 양보 규칙).
    const sideObs = [];
    for (const r of this.coord.robots.values()) {
      if (r.run) continue;
      // 링크 캡슐 + 툴(밀대·스쿱) 상자 — 툴을 빼면 대형 스쿱이 아래로 매달린 밀대에 닿는다
      [...r.worldSegments(), ...r.physicsShapes().filter((sg) => sg.box)].forEach((sg, k) => {
        let lo, hi;
        if (sg.box) {
          const { center: c, R, half: h } = sg.box;
          const ext = [0, 1, 2].map((i) => Math.abs(R[i * 3]) * h[0] + Math.abs(R[i * 3 + 1]) * h[1] + Math.abs(R[i * 3 + 2]) * h[2]);
          lo = c.map((v, i) => v - ext[i]);
          hi = c.map((v, i) => v + ext[i]);
        } else if (sg.a && sg.b) {
          const rad = sg.r ?? 0;
          lo = [0, 1, 2].map((i) => Math.min(sg.a[i], sg.b[i]) - rad);
          hi = [0, 1, 2].map((i) => Math.max(sg.a[i], sg.b[i]) + rad);
        } else return;
        sideObs.push({ id: `side:${r.slot}:${k}`, name: `${r.F.S.label} 측면 로봇(대기)`, type: 'box', pos: lo.map((v, i) => (v + hi[i]) / 2), size: lo.map((v, i) => hi[i] - v), rot: [0, 0, 0], visible: false, fixture: true });
      });
    }
    const obstacles = sideObs.length ? [...fixtures, ...sideObs] : fixtures;
    const res = await planSkimCycle(
      { robot, q0: q.slice(), spec: this.spec, lane: pick.lane, obstacles, thresholds, floor: true, stroke,
        immersionMm, sweepMmS, cell: { corridor: this.coord.robots.size > 0 } },
      { plan: (req) => planPath({ robot, thresholds, floor: true, features: {}, avoidSingularity: false, reference: q, timeoutMs: 8000, deterministic: this.deterministic, ...req }) },
    );
    if (!res.ok) {
      this.planFail.push(res.message);
      this.coord.main.wantsPot = false;
      this.laneFails.set(pick.lane.index, (this.laneFails.get(pick.lane.index) ?? 0) + 1);
      this.retryS = 3;
      return;
    }
    this.laneFails.delete(pick.lane.index);
    this.lastLane = pick.lane.index;
    this.dirFlip = !this.dirFlip;
    const steps = res.steps.slice();
    // 포트를 비워 주는 시점: 스쿱 상승 뒤. 스나우트 쪽 쓸기는 담은 채 물러나기·돌리기까지 포트 위에 있으므로 그 뒤 (v3.0.0)
    const turnIdx = steps.findIndex((s) => s.label === '담은 채 돌리기');
    const liftIdx = turnIdx >= 0 ? turnIdx : steps.findIndex((s) => s.label === '스쿱 상승');
    if (this.anyMode2) steps.unshift({ kind: 'action', type: 'until', label: '측면 로봇 퇴피 대기' });
    this.run = { steps, i: 0, t: 0, liftIdx: liftIdx + (this.anyMode2 ? 1 : 0), lane: pick.lane.index };
  }

  get label() {
    return this.run?.steps[this.run.i]?.label ?? (this.waitingSide ? '측면 로봇 퇴피 대기' : this.gaveUp ? '모든 레인 계획 실패 — 작업 중단' : this.retryS > 0 ? '계획 실패 — 다시 시도 대기' : this.empty ? '떠낼 드로스 없음' : '대기');
  }

  /** @returns 다음 1/60 s 목표 관절값 또는 null */
  async target(q) {
    if (!this.run) await this.start(q);
    const run = this.run;
    this.pending = null;
    this.inPotPhase = false;
    if (!run) return null;
    const st = run.steps[run.i];
    if (!st) {
      this.endCycle();
      return null;
    }
    this.inPotPhase = run.i <= run.liftIdx && st.kind !== 'action';
    // 모드 3 측면 로봇용: 들어 올린 뒤(운반·덤프·복귀) 다음 사이클까지 남은 시간
    if (this.anyMode2) {
      let eta = 0;
      if (run.i > run.liftIdx) {
        eta = st.kind === 'move' ? st.trajectory.duration - run.t : Math.max(0, (st.sec ?? 0) - run.t);
        for (let j = run.i + 1; j < run.steps.length; j++) eta += run.steps[j].kind === 'move' ? run.steps[j].trajectory.duration : run.steps[j].sec ?? 0;
      }
      this.coord.main.etaS = eta;
    }
    if (st.kind === 'action') {
      if (st.type === 'until') {
        if (!this.coord.sideInPot()) run.i++;
      } else {
        run.t += SIM_DT;
        if (run.t >= st.sec) {
          run.i++;
          run.t = 0;
        }
      }
      this.checkEnd();
      return null;
    }
    const tN = Math.min(st.trajectory.duration, run.t + SIM_DT);
    this.pending = tN;
    return sampleTrajectory(st.trajectory, tN);
  }

  commit() {
    const run = this.run;
    if (!run || this.pending === null) return;
    const st = run.steps[run.i];
    run.t = this.pending;
    this.pending = null;
    if (run.t >= st.trajectory.duration - 1e-9) {
      if (run.i === run.liftIdx) this.coord.main.wantsPot = false; // 들어 올린 뒤엔 포트를 비워 줌
      run.i++;
      run.t = 0;
    }
    this.checkEnd();
  }

  abort() {
    this.run = null;
    this.pending = null;
    this.coord.main.wantsPot = false;
  }

  checkEnd() {
    if (this.run && this.run.i >= this.run.steps.length) this.endCycle();
  }

  endCycle() {
    this.run = null;
    this.cycles++;
  }
}

/**
 * 규칙 재생 컨트롤러 (회귀·시연용, PRD AC-57): 자기 RuleMainDriver를 실제보다 50 ms 앞서 돌려
 * 그 시점의 목표 관절값과 현재 관절값의 차이를 Δq로 낸다. 정책 자리에 넣으면 규칙 경로와 거의 같은 결과가 나와야 한다.
 */
export class RuleReplayController {
  constructor() {
    this.driver = null;
  }

  init(sim) {
    this.driver = new RuleMainDriver(sim.driverArgs);
  }

  get inPotPhase() {
    return this.driver.inPotPhase;
  }

  get label() {
    return this.driver.label;
  }

  /** @param obs { q(현재 관절값) } @returns Δq (deg, 6) */
  async act(obs) {
    let qT = obs.q;
    for (let k = 0; k < TICKS_PER_CONTROL; k++) {
      const q = await this.driver.target(qT);
      if (q) {
        qT = q;
        this.driver.commit();
      }
    }
    return qT.map((v, i) => v - obs.q[i]);
  }

  /** 시뮬레이터가 실제 이동을 막으면 운전기도 사이클을 버린다 */
  onBlocked() {
    this.driver.abort();
  }
}

/**
 * 에피소드 1회 실행.
 * @param task sanitizeTask(...).task
 * @param opts {
 *   RAPIER, robots(robots.json 목록),
 *   mainControl: 'rule' | 'policy' (기본 task.aiRobot.slot === 'main' && controller ? 'policy' : 'rule'),
 *   controller: { init?(sim), act(obs) → Δq, onBlocked?(), inPotPhase? }   (policy일 때)
 *   simS: 시뮬레이션 시간(기본 task.timeLimitS), stopOnBlock: 막히면 대형 로봇 정지(앱의 알람과 같음, 기본 true),
 *   stopAtTarget: 목표 회수율 도달 시 종료(기본 false), deterministic: 경로 계획 후처리 반복 횟수 고정(기본 true),
 *   thresholds, evalEveryS(기본 1), onSample(summaryLast), profile, debug,
 *   record: EpisodeRecorder(replay.js) — 주면 everyS마다 로봇 관절값·드로스 위치·회수율을 기록(3D 재생용)
 *   mainChooser: async ({ q, sim, evaluator }) → { lane: { start, end }, stroke, immersionMm, sweepMmS } | null
 *     — 대형 로봇의 다음 스트로크를 외부(학습 탐색)가 정한다 (stroke-lab.js runLab)
 * }
 * @returns {Promise<{ summary, out }>}  summary = TaskEvaluator.summary() + 운전 지표, out = 상세(v1.1.1 테스트 호환 필드)
 */
export async function runEpisode(task, opts) {
  const { RAPIER, robots, controller = null, stopOnBlock = true, stopAtTarget = false, deterministic = true, profile = false, debug = false, record = null } = opts;
  const thresholds = opts.thresholds ?? TASK_THRESHOLDS;
  const simS = opts.simS ?? task.timeLimitS;
  const evalEvery = Math.max(1, Math.round((opts.evalEveryS ?? 1) / SIM_DT));
  const mainControl = opts.mainControl ?? (task.aiRobot.slot === 'main' && controller ? 'policy' : 'rule');
  if (task.aiRobot.slot !== 'main' && controller) throw new Error('측면 로봇 정책 제어는 4단계(스킬 실행기)에서 지원합니다.');
  const byId = (id) => robots.find((r) => r.id === id);
  const main = byId(task.cell.main);
  const sides = {};
  for (const slot of ['left', 'right']) {
    const c = task.cell[slot];
    if (c?.robotId) sides[slot] = { robotId: c.robotId, mode: c.mode, binDist: c.mode === 1 ? sideBinDistFor(c.robotId) : undefined };
  }
  const fixtures = drossFixtures(sides);
  const bins = drossBins(sides);
  const w = new PhysicsWorld(RAPIER);
  w.setFixtures(fixtures);
  w.load([]);
  const field = new DrossField(w, { count: task.dross.count, seed: task.dross.seed, ratePerMin: task.dross.ratePerMin });
  field.init();
  const spec = SKIMMER_SPEC;
  const ctx = createSafetyContext(main, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds, obstacles: fixtures, floor: true, tool: { spec, opening: 0 }, physicsMode: true });
  const physMain = (e) => [...e.segments.filter((s) => s.part !== 'plate'), ...skimmerBoxes(spec, e.frames[6])];
  let cur = evaluatePose(ctx, homeJoints(main));
  w.setRobot(physMain(cur));
  const coord = new CellCoordinator();
  for (const [slot, cfg] of Object.entries(sides)) {
    const cr = new CellRobot(slot, byId(cfg.robotId), cfg.mode, { thresholds, obstaclesWorld: fixtures, binDist: cfg.binDist });
    coord.robots.set(slot, cr);
    w.setExtraRobot(slot, cr.physicsShapes());
  }
  for (let i = 0; i < WARMUP_TICKS; i++) { w.step(); field.tick(SIM_DT); }
  const evaluator = new TaskEvaluator(task, w, bins);
  evaluator.begin(0);
  coord.start();
  const recEvery = record ? Math.max(1, Math.round(record.everyS / SIM_DT)) : 0;
  const recQ = () => ({ main: cur.q, ...Object.fromEntries([...coord.robots.values()].map((r) => [r.slot, r.current.q])) });
  if (record) {
    record.begin({ task, cell: { main: main.id, ...Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, { robotId: v.robotId, mode: v.mode, binDist: v.binDist ?? null }])) } });
    record.frame(0, recQ(), w, evaluator.last, '시작');
  }

  const anyMode2 = [...coord.robots.values()].some((r) => r.mode >= 2);
  const driverArgs = { robot: main, spec, fixtures, world: w, coord, sides, thresholds, task, deterministic, chooser: opts.mainChooser ?? null };
  const sim = { task, robot: main, spec, fixtures, world: w, field, coord, driverArgs, ctx, sides, thresholds, evaluator };
  const driver = mainControl === 'rule' ? new RuleMainDriver(driverArgs) : null;
  if (driver) {
    driver.sim = sim;
    driver.evaluator = evaluator;
  }
  if (mainControl === 'policy') controller.init?.(sim);
  const out = { mainBlocked: 0, sideBlocked: 0, policySteps: 0, lockViolations: 0, holdS: 0, minMainSide: Infinity, lastMainBlock: null, lastSideBlock: null, sidePlanFail: [] };
  const prof = { side: 0, main: 0, phys: 0, physMax: 0, over20: 0 };
  const wall0 = performance.now();
  let mainStopped = false;
  let policyPlan = null; // { q0, dq, k }
  let simT = 0;

  const ticks = Math.round(simS / SIM_DT);
  for (let tick = 0; tick < ticks; tick++) {
    if (opts.shouldStop?.()) break; // 학습 중지 등
    simT = (tick + 1) * SIM_DT;
    // 측면 로봇의 비동기 계획이 끝날 수 있도록 이벤트 루프에 양보 (브라우저의 프레임마다 양보와 같음)
    if (coord.planning.size) await yieldLoop();
    const t0 = performance.now();
    coord.tick(SIM_DT, {
      mainSegments: cur.segments, mainName: main.name, particles: () => w.particleState(), obstaclesWorld: () => fixtures, paused: false,
      onBlocked: (r, res) => { out.sideBlocked++; out.lastSideBlock = `${r.slot}: ${res.reason ?? res.blocked?.map((v) => v.key).join(',')}`; },
      onPlanFail: (r) => out.sidePlanFail.push(`${r.slot}: ${r.error}`),
    });
    const t1 = performance.now();
    prof.side += t1 - t0;

    // 대형 로봇 (다른 로봇을 포함한 적용 전 검사)
    ctx.others = [...coord.robots.values()].map((r) => ({ id: r.slot, segments: r.worldSegments() }));
    let inPotPhase = false;
    if (!mainStopped) {
      let qNext = null;
      if (mainControl === 'rule') {
        qNext = await driver.target(cur.q);
        inPotPhase = driver.inPotPhase;
      } else {
        if (!policyPlan || policyPlan.k >= TICKS_PER_CONTROL) {
          const dq = await controller.act({ t: simT, q: cur.q.slice(), sim });
          policyPlan = { q0: cur.q.slice(), dq, k: 0 };
          out.policySteps++;
        }
        policyPlan.k++;
        const f = policyPlan.k / TICKS_PER_CONTROL;
        const moving = policyPlan.dq.some((v) => Math.abs(v) > 1e-9);
        qNext = moving ? policyPlan.q0.map((v, i) => v + policyPlan.dq[i] * f) : null;
        inPotPhase = !!controller.inPotPhase;
      }
      if (qNext) {
        const r = sweepCheck(ctx, cur, qNext);
        if (!r.ok) {
          out.mainBlocked++;
          out.lastMainBlock = `${(driver ?? controller).label ?? ''}: ${r.blocked.map((v) => v.key).join(',')}`;
          if (driver) driver.abort();
          else {
            controller.onBlocked?.();
            policyPlan = null;
          }
          if (stopOnBlock) mainStopped = true; // 앱에서는 알람 → 정지
        } else {
          cur = r.last;
          driver?.commit();
        }
      }
    }
    if (anyMode2 && inPotPhase && [...coord.robots.values()].some((r) => r.mode >= 2 && r.inPot)) out.lockViolations++;
    for (const r of coord.robots.values()) {
      out.minMainSide = Math.min(out.minMainSide, capsuleSetDistance(cur.segments, r.worldSegments()).d);
      if (r.status === 'holding') out.holdS += SIM_DT;
    }
    const t2 = performance.now();
    prof.main += t2 - t1;
    if (profile && tick % 1800 === 0) console.log('  t', (tick * SIM_DT).toFixed(0), 'wall', ((t2 - wall0) / 1000).toFixed(1), 'prof', JSON.stringify(Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, Math.round(v)]))));
    if (debug && tick % 1800 === 0) console.log('  t', (tick * SIM_DT).toFixed(0), 'main', (driver ?? controller).label, [...coord.robots.values()].map((r) => `${r.slot}:${r.status}:${r.label}`).join(' | '));

    // 물리
    w.moveRobot(physMain(cur));
    for (const r of coord.robots.values()) w.moveExtraRobot(r.slot, r.physicsShapes());
    w.step();
    field.tick(SIM_DT);
    const d = performance.now() - t2;
    prof.phys += d;
    prof.physMax = Math.max(prof.physMax, d);
    if (d > 20) prof.over20++;

    if ((tick + 1) % evalEvery === 0) {
      const s = evaluator.sample(simT);
      opts.onSample?.(s);
      if (stopAtTarget && evaluator.reachS !== null) break;
    }
    if (record && (tick + 1) % recEvery === 0) record.frame(simT, recQ(), w, evaluator.last, (driver ?? controller).label ?? '');
  }
  evaluator.sample(simT);
  const wallS = (performance.now() - wall0) / 1000;
  if (profile) console.log('  prof ms total: side', prof.side.toFixed(0), 'main', prof.main.toFixed(0), 'phys', prof.phys.toFixed(0), 'physMax', prof.physMax.toFixed(1), 'over20ms', prof.over20);
  out.stats = field.stats(bins);
  out.mainCycles = driver ? driver.cycles : (controller.driver?.cycles ?? null);
  out.planFail = [...(driver?.planFail ?? controller.driver?.planFail ?? []), ...out.sidePlanFail];
  out.side = Object.fromEntries([...coord.robots.values()].map((r) => [r.slot, { name: r.robot.name, mode: r.mode, cycles: r.cycles, lanes: r.lanes.length, minOther: r.minOtherMm, status: r.status, label: r.label }]));
  out.history = evaluator.history;
  out.prof = prof;
  w.dispose();
  const summary = {
    ...evaluator.summary(),
    simS: +simT.toFixed(2),
    wallS: +wallS.toFixed(1),
    speedup: +(simT / wallS).toFixed(2),
    mainControl,
    mainGaveUp: !!(driver ?? controller.driver)?.gaveUp,
    mainCycles: out.mainCycles,
    mainBlocked: out.mainBlocked,
    sideBlocked: out.sideBlocked,
    lockViolations: out.lockViolations,
    planFail: out.planFail.length,
  };
  const episode = record ? record.toJSON({ summary, history: evaluator.history }) : null;
  return { summary, out, episode };
}
