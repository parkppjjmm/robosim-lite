// 관절 계측(Telemetry) (PRD_v.1.1.2 FR-37~40). DOM 비의존 — 브라우저(main.js)와 Node 테스트에서 함께 쓴다.
// 각 축(J1~J6)의 각도·속도·가속도는 시뮬레이션 관절값에서 그대로 얻고,
// 토크·전류는 시뮬레이터에 모터·기어 모델이 없으므로 "근사 동역학"으로 추정한다 (실측 아님 — PRD 3.2):
//   τ_i = 중력(링크 질량 + 툴·부하) + 관성(I_eff·α) + 마찰(쿨롱 + 점성) + 외력(욕 점성 저항 등, Jᵀ·F)
//   전류_i = 정격전류 × τ_i / 정격토크_i (+ 센서 잡음)
// 열 이름은 머신러닝에서 바로 쓰도록 ASCII로 하고, UR RTDE 이름(actual_q/qd/current)과 대응을 문서에 둔다.
import { forwardKinematics, linkSegments, origin, axisZ, DEG } from './kinematics.js';

export const G = 9.81;
export const LINK_DENSITY = 1400; // kg/m³ — 링크 캡슐 부피에 곱하는 유효 밀도 (속이 빈 주물·감속기·모터 평균 근사)
export const RATED_CURRENT_A = { small: 4, medium: 10, large: 25 }; // 크기별 축 정격전류 근사
export const ALPHA_REF = 6; // rad/s² — 정격토크 산정용 기준 각가속도 (산업용 로봇 축 가속 수준)
// 가속도 상한 (deg/s²): 시뮬레이션 궤적은 구간이 바뀔 때 속도가 순간적으로 바뀌어(실제 제어기는 가감속으로 완화) 미분 가속도가 튄다 → 평활 후 상한
export const ALPHA_MAX_DPS2 = 600;
export const FRICTION = { coulomb: 0.04, viscous: 0.03 }; // 정격토크 대비 쿨롱 마찰, 점성 마찰(×rad/s)
export const NOISE_PCT = 0.5; // 전류 센서 잡음 (정격 대비 %, 표준편차)
export const BATH_DRAG_NS_M = 450; // N·s/m — 잠긴 스쿱·밀대가 용융 아연 속에서 받는 점성 저항 근사

/** 툴 질량 근사 (kg) */
export function toolMassKg(spec) {
  if (!spec) return 0;
  if (spec.kind === 'skimmer') return spec.lengthMm >= 500 ? 9 : 2;
  if (spec.kind === 'rake') return 1.5;
  return Math.max(0.3, spec.maxPayloadKg * 0.2); // 평행 그리퍼: 가반 질량의 약 20%
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mid = (s) => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, (s.a[2] + s.b[2]) / 2];

/** 재현 가능한 정규 난수 (잡음용) */
function gauss(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * 한 로봇의 관절 계측기. 60 Hz 시뮬레이션 스텝마다 update()를 부른다.
 * 좌표는 그 로봇의 베이스 좌표계(측면 로봇은 로컬 — 중력은 Z-down으로 같다).
 */
export class JointTelemetry {
  constructor(robot, toolSpec = null, { seed = 1, noise = true } = {}) {
    this.robot = robot;
    this.setTool(toolSpec);
    this.noise = noise;
    this.rand = gauss(seed);
    // 링크 캡슐 질량 (홈 자세에서 길이를 재 고정): m = ρ·π r²·(L + 4r/3)
    const segs = linkSegments(robot, forwardKinematics(robot, robot.homeDeg ?? [0, 0, 0, 0, 90, 0]).frames);
    this.segMass = segs.map((s) => {
      if (s.link === 0) return 0;
      const L = Math.hypot(...sub(s.b, s.a)) / 1000, r = s.r / 1000;
      return LINK_DENSITY * Math.PI * r * r * (L + (4 * r) / 3);
    });
    this.massKg = this.segMass.reduce((a, b) => a + b, 0);
    this.ratedA = RATED_CURRENT_A[robot.sizeClass] ?? RATED_CURRENT_A.medium;
    this.ratedTau = this.computeRatedTorque();
    this.prev = null; // { q, qd, tcp }
    this.out = null;
  }

  setTool(spec) {
    this.toolSpec = spec;
    this.toolKg = toolMassKg(spec);
  }

  /**
   * 정격토크(축별): 여러 대표 자세의 정적 중력 토크 최대값 × 1.5 + 기준 관성 토크(I_eff·α_ref), 최소 1 N·m.
   * 손목 축은 (가반하중 + 툴)이 툴 끝에서 수평으로 걸린 토크 × 1.5 + 관성을 하한으로 한다.
   * (J1처럼 중력 토크가 0인 축은 관성 항이 정격을 정한다)
   */
  computeRatedTorque() {
    const poses = [[0, 0, 0, 0, 90, 0], [0, 60, 0, 0, 0, 0], [0, 90, -90, 0, 0, 0], [0, 45, 45, 0, 45, 0], [0, 80, 0, 0, 90, 0]];
    const lim = this.robot.jointLimitsDeg;
    const tau = [0, 0, 0, 0, 0, 0], inert = [0, 0, 0, 0, 0, 0];
    for (const p of poses) {
      const q = p.map((v, i) => Math.min(lim[i][1], Math.max(lim[i][0], v)));
      const { frames } = forwardKinematics(this.robot, q);
      const st = this.statics(frames, this.robot.payloadKg + this.toolKg, [0, 0, 0]);
      for (let i = 0; i < 6; i++) {
        tau[i] = Math.max(tau[i], Math.abs(st.tau[i]));
        inert[i] = Math.max(inert[i], st.inertia[i]);
      }
    }
    // 손목(J4~J6): 대표 자세에서는 툴이 축과 나란해 중력 토크가 작게 잡히므로, 가반하중 + 툴이 툴 끝에서 수평으로 걸린 경우를 하한으로 둔다
    const m = this.robot.payloadKg + this.toolKg;
    const lever = (Math.abs(this.robot.dh[5].d) + (this.toolSpec?.lengthMm ?? 0)) / 1000;
    const wristFloor = 1.5 * m * G * lever + m * lever * lever * ALPHA_REF;
    return tau.map((t, i) => Math.max(1, 1.5 * t + inert[i] * ALPHA_REF, i >= 3 ? wristFloor : 0));
  }

  /**
   * 정적 토크(중력 + 외력)와 축별 유효 관성. loadKg는 TCP(플랜지 + 툴 길이)에 붙은 질량, forceN은 TCP에 걸리는 외력(N, 베이스 좌표)
   */
  statics(frames, loadKg, forceN, tcp = null) {
    const segs = linkSegments(this.robot, frames);
    const tcpP = tcp ?? origin(frames[6]);
    const tau = [0, 0, 0, 0, 0, 0], inertia = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
      const o = origin(frames[i]), z = axisZ(frames[i]);
      const add = (p, m, F) => {
        const r = sub(p, o).map((v) => v / 1000);
        // 모터가 내야 하는 토크 = −(외력·중력이 축에 만드는 토크)
        tau[i] -= dot(z, cross(r, F));
        if (m) {
          const along = dot(r, z);
          const d2 = dot(r, r) - along * along; // 축까지 거리²
          inertia[i] += m * d2;
        }
      };
      segs.forEach((s, k) => {
        if (s.link >= i + 1 && this.segMass[k]) add(mid(s), this.segMass[k], [0, 0, -this.segMass[k] * G]);
      });
      if (loadKg) add(tcpP, loadKg, [0, 0, -loadKg * G]);
      if (forceN && (forceN[0] || forceN[1] || forceN[2])) add(tcpP, 0, forceN);
    }
    return { tau, inertia };
  }

  /**
   * 1스텝 갱신.
   * @param q 관절값(deg), frames FK 결과, dt 초
   * @param load { extraKg(파지 물체·스쿱 위 드로스), tcp(mm), immersed(욕면 아래 잠김 0~1) }
   * @returns { q, qd(deg/s), qdd(deg/s²), tau(N·m), current(A), currentPct(정격 대비 %), tcp }
   */
  update(q, frames, dt, load = {}) {
    const tcp = load.tcp ?? origin(frames[6]);
    let qd = [0, 0, 0, 0, 0, 0], qdd = [0, 0, 0, 0, 0, 0], qds = [0, 0, 0, 0, 0, 0], v = [0, 0, 0];
    if (this.prev && dt > 0) {
      qd = q.map((x, i) => (x - this.prev.q[i]) / dt); // 속도 = 각도의 정확한 차분
      // 가속도: 평활한 속도(지수 평활 0.4)를 미분 → 다시 평활(0.3) → 상한 ±ALPHA_MAX_DPS2
      qds = qd.map((x, i) => 0.6 * this.prev.qds[i] + 0.4 * x);
      qdd = qds.map((x, i) => {
        const a = 0.7 * this.prev.qdd[i] + 0.3 * ((x - this.prev.qds[i]) / dt);
        return Math.max(-ALPHA_MAX_DPS2, Math.min(ALPHA_MAX_DPS2, a));
      });
      v = sub(tcp, this.prev.tcp).map((d) => d / 1000 / dt); // m/s
    }
    // 욕 점성 저항: 잠긴 툴이 움직이면 속도 반대 방향 힘
    const imm = load.immersed ?? 0;
    const F = imm > 0 ? v.map((x) => -BATH_DRAG_NS_M * imm * x) : [0, 0, 0];
    const st = this.statics(frames, this.toolKg + (load.extraKg ?? 0), F, tcp);
    const tau = st.tau.map((tg, i) => {
      const w = qd[i] * DEG; // rad/s
      const a = qdd[i] * DEG;
      const fr = this.ratedTau[i] * (FRICTION.coulomb * Math.tanh(w / 0.02) + FRICTION.viscous * w);
      return tg + st.inertia[i] * a + fr;
    });
    const current = tau.map((t, i) => this.ratedA * (t / this.ratedTau[i]) + (this.noise ? this.ratedA * (NOISE_PCT / 100) * this.rand() : 0));
    const currentPct = current.map((c) => (100 * Math.abs(c)) / this.ratedA);
    this.prev = { q: q.slice(), qd, qds, qdd, tcp };
    this.out = { q: q.slice(), qd, qdd, tau, current, currentPct, tcp };
    return this.out;
  }

  reset() {
    this.prev = null;
  }
}

// ---------------------------------------------------------------------------
// 기록 (시간대별 · 상황별) → 엑셀 시트
// ---------------------------------------------------------------------------

const J = [1, 2, 3, 4, 5, 6];
/** 데이터 시트 열 (ASCII — pandas 등에서 바로 사용) */
export const DATA_COLUMNS = [
  't_s', 'wall_time', 'robot', 'model', 'activity', 'phase', 'cycle', 'lane', 'alarm',
  ...J.map((j) => `q${j}_deg`), ...J.map((j) => `qd${j}_dps`), ...J.map((j) => `qdd${j}_dps2`),
  ...J.map((j) => `tau${j}_Nm`), ...J.map((j) => `i${j}_A`),
  'tcp_x_mm', 'tcp_y_mm', 'tcp_z_mm', 'tool', 'load_kg', 'scoop_dross', 'immersed', 'bath_dross', 'collected_own', 'collected_total',
];

/** 열 설명 (설명 시트) — [열, 뜻, 단위] */
export const COLUMN_DOC = [
  ['t_s', '시뮬레이션 시간 (기록 시작 = 0)', 's'],
  ['wall_time', '실제 시각 (ISO 8601)', ''],
  ['robot', '로봇 위치: main(대형) / left / right(측면)', ''],
  ['model', '로봇 모델', ''],
  ['activity', '동작 종류: idle · jog · cartesian · waypoint · plan · skim(스키밍) · push(밀기) · hold(간섭 대기) · alarm', ''],
  ['phase', '현재 단계 이름 (예: 레인 접근, 스쿱 하강, 스윕, 스쿱 상승, 기울여 쏟기, 밀기 …) — 상황 라벨', ''],
  ['cycle', '사이클 번호 (작업 중이 아니면 빈칸)', ''],
  ['lane', '레인 번호 (1부터)', ''],
  ['alarm', '알람 중이면 1', ''],
  ['qN_deg', '관절 N 각도 (UR RTDE actual_q에 대응, 단위 deg)', 'deg'],
  ['qdN_dps', '관절 N 속도 = 각도의 시간 미분 (RTDE actual_qd)', 'deg/s'],
  ['qddN_dps2', '관절 N 가속도 (평활한 속도의 미분, 지수 평활, 상한 ±600 deg/s² — 시뮬레이션 궤적의 순간 속도 변화로 생기는 튐 억제)', 'deg/s²'],
  ['tauN_Nm', '관절 N 추정 토크 = 중력 + 관성 + 마찰 + 외력 (근사 동역학)', 'N·m'],
  ['iN_A', '관절 N 추정 전류 = 정격전류 × 토크/정격토크 + 잡음 (RTDE actual_current에 대응, 실측 아님)', 'A'],
  ['tcp_*_mm', 'TCP 위치 (그 로봇 베이스 좌표)', 'mm'],
  ['tool', '툴 종류: gripper · skimmer · rake · none', ''],
  ['load_kg', '툴 끝 부하 = 툴 질량 + 파지 물체 + 스쿱 위 드로스', 'kg'],
  ['scoop_dross', '스쿱 위(툴 근처)에 있는 드로스 수', '개'],
  ['immersed', '툴이 욕면 아래에 잠긴 정도 (0~1)', ''],
  ['bath_dross', '작업 영역 욕면에 떠 있는 드로스 수 (셀 전체)', '개'],
  ['collected_own', '이 로봇 드로스 박스에 들어간 누적 개수', '개'],
  ['collected_total', '모든 드로스 박스 누적 개수', '개'],
];

export const CYCLE_COLUMNS = [
  'robot', 'model', 'cycle', 'lane', 't_start_s', 't_end_s', 'duration_s', 'collected', 'samples',
  ...J.map((j) => `i${j}_peak_A`), ...J.map((j) => `i${j}_rms_A`), 'energy_J', 'max_load_kg', 'result',
];

/**
 * 계측 기록기: 샘플 주기마다 로봇별 1행. 사이클이 끝나면 요약 1행, 단계·알람이 바뀌면 이벤트 1행.
 * 시간은 시뮬레이션 시계 기준(기록 시작 = 0).
 */
export class TelemetryLog {
  constructor({ hz = 20, maxRows = 300000 } = {}) {
    this.hz = hz;
    this.maxRows = maxRows;
    this.clear();
  }

  clear() {
    this.rows = [];
    this.cycles = [];
    this.events = [];
    this.recording = false;
    this.t0 = null;
    this.lastSample = -Infinity;
    this.acc = new Map(); // robot → 사이클 누적
    this.lastPhase = new Map();
    this.full = false;
  }

  start(simT) {
    if (this.t0 === null) this.t0 = simT;
    this.recording = true;
    this.lastSample = -Infinity;
    this.event(simT, 'system', '기록 시작', `${this.hz} Hz`);
  }

  stop(simT) {
    if (!this.recording) return;
    this.recording = false;
    this.event(simT, 'system', '기록 정지', `${this.rows.length}행`);
  }

  /** 지금 샘플을 남길 차례인가 (모든 로봇이 같은 시각에 1행씩) */
  due(simT) {
    if (!this.recording || this.full) return false;
    if (simT - this.lastSample < 1 / this.hz - 1e-9) return false;
    this.lastSample = simT;
    return true;
  }

  event(simT, robot, kind, detail = '') {
    this.events.push([+(simT - (this.t0 ?? simT)).toFixed(3), new Date().toISOString(), robot, kind, detail]);
  }

  /**
   * 1행 추가. s = { robot, model, activity, phase, cycle, lane, alarm, tel(JointTelemetry.out), tool, loadKg, scoopDross, immersed, bathDross, collectedOwn, collectedTotal }
   */
  push(simT, s) {
    if (this.rows.length >= this.maxRows) {
      if (!this.full) this.event(simT, 'system', '기록 한도 도달', `${this.maxRows}행 — 기록 중지`);
      this.full = true;
      return;
    }
    const t = +(simT - this.t0).toFixed(3);
    const r2 = (v) => Math.round(v * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const o = s.tel;
    this.rows.push([
      t, new Date().toISOString(), s.robot, s.model, s.activity, s.phase ?? '', s.cycle ?? '', s.lane ?? '', s.alarm ? 1 : 0,
      ...o.q.map(r3), ...o.qd.map(r2), ...o.qdd.map(r2), ...o.tau.map(r2), ...o.current.map(r3),
      ...o.tcp.map((v) => Math.round(v * 10) / 10), s.tool ?? 'none', r2(s.loadKg ?? 0), s.scoopDross ?? 0, r2(s.immersed ?? 0),
      s.bathDross ?? '', s.collectedOwn ?? '', s.collectedTotal ?? '',
    ]);
    // 단계 변화 → 이벤트
    const key = s.robot;
    const ph = `${s.activity}|${s.phase ?? ''}`;
    if (this.lastPhase.get(key) !== ph) {
      this.lastPhase.set(key, ph);
      this.events.push([t, new Date().toISOString(), key, '단계', `${s.activity}${s.phase ? ` · ${s.phase}` : ''}`]);
    }
    // 사이클 요약
    let a = this.acc.get(key);
    if (a && a.cycle !== s.cycle) {
      this.finishCycle(a, s.alarm ? 'alarm' : 'done');
      a = null;
      this.acc.delete(key);
    }
    if (!a && s.cycle !== null && s.cycle !== undefined && s.cycle !== '') {
      a = { robot: key, model: s.model, cycle: s.cycle, lane: s.lane ?? '', t0: t, t1: t, n: 0, peak: [0, 0, 0, 0, 0, 0], sq: [0, 0, 0, 0, 0, 0], energy: 0, maxLoad: 0, c0: s.collectedOwn ?? 0, c1: s.collectedOwn ?? 0 };
      this.acc.set(key, a);
    }
    if (a) {
      const dt = a.n ? t - a.t1 : 0;
      a.t1 = t;
      a.n++;
      o.current.forEach((c, i) => {
        a.peak[i] = Math.max(a.peak[i], Math.abs(c));
        a.sq[i] += c * c;
        a.energy += Math.abs(o.tau[i] * o.qd[i] * DEG) * dt;
      });
      a.maxLoad = Math.max(a.maxLoad, s.loadKg ?? 0);
      a.c1 = s.collectedOwn ?? a.c1;
    }
  }

  finishCycle(a, result) {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.cycles.push([
      a.robot, a.model, a.cycle, a.lane, a.t0, a.t1, r3(a.t1 - a.t0), (a.c1 ?? 0) - (a.c0 ?? 0), a.n,
      ...a.peak.map(r3), ...a.sq.map((s) => r3(Math.sqrt(s / Math.max(1, a.n)))), Math.round(a.energy), Math.round(a.maxLoad * 100) / 100, result,
    ]);
  }

  /** 진행 중인 사이클도 '진행 중'으로 요약에 넣은 시트 묶음 */
  sheets(meta = []) {
    const open = [...this.acc.values()].map((a) => {
      const keep = this.cycles.length;
      this.finishCycle(a, 'in-progress');
      return this.cycles.splice(keep, 1)[0];
    });
    return [
      { name: 'data', rows: [DATA_COLUMNS, ...this.rows], widths: { 1: 24, 5: 18 } },
      { name: 'cycles', rows: [CYCLE_COLUMNS, ...this.cycles, ...open] },
      { name: 'events', rows: [['t_s', 'wall_time', 'robot', 'kind', 'detail'], ...this.events], widths: { 1: 24, 4: 40 } },
      { name: 'columns', rows: [['column', 'description', 'unit'], ...COLUMN_DOC], widths: { 0: 16, 1: 90 } },
      { name: 'meta', rows: [['key', 'value'], ...meta], widths: { 0: 28, 1: 80 } },
    ];
  }
}
