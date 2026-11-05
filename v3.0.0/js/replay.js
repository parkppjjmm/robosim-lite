// 에피소드 기록·재생 데이터 (PRD_v.3.0.0 FR-63 일부 — 헤드리스 결과를 3D로 다시 보기). DOM 비의존.
// Node(헤드리스 실행)가 EpisodeRecorder로 기록 → gzip JSON 파일(.rsim.json.gz) → 브라우저가 parseEpisode로 읽어 EpisodePlayer로 재생.
// 형식 'robosim-episode/1':
//   { schema, created, app, task, summary, cell: { main, left, right }, dt,
//     radii: [입자 반지름 mm …], frames: [{ t, q: { main, left?, right? }, p: [i, x, y, z, …], n, rate, rateKg, label }],
//     keyEvery, history }
//   p는 지난 프레임보다 2 mm 넘게 움직인 입자만(키 프레임은 전부) 정수 mm로 담는다. 범위를 벗어난(out) 입자는 z = HIDDEN_Z.

export const EPISODE_SCHEMA = 'robosim-episode/1';
export const HIDDEN_Z = -99999;
const MOVE_EPS_MM = 2;

/** 헤드리스 실행 기록기. runEpisode의 opts.record = new EpisodeRecorder({ everyS }) */
export class EpisodeRecorder {
  constructor({ everyS = 0.1, keyEveryS = 10 } = {}) {
    this.everyS = everyS;
    this.keyEvery = Math.max(1, Math.round(keyEveryS / everyS));
    this.frames = [];
    this.radii = [];
    this.lastPos = []; // 입자별 마지막 기록 위치 [x, y, z]
  }

  /** 시작 정보 */
  begin({ task, cell, appVersion = '3.0.0' }) {
    this.meta = { task, cell, app: appVersion };
  }

  /**
   * 프레임 1개. q = { main, left?, right? } (deg), physics = PhysicsWorld, ev = TaskEvaluator.last (없어도 됨)
   */
  frame(t, q, physics, ev, label = '') {
    const ps = physics.particles;
    const { buf } = physics.particleState();
    const key = this.frames.length % this.keyEvery === 0;
    const p = [];
    for (let i = 0; i < ps.length; i++) {
      if (this.radii[i] === undefined) this.radii[i] = Math.round(ps[i].r * 10) / 10;
      const x = Math.round(buf[i * 4]), y = Math.round(buf[i * 4 + 1]);
      const z = ps[i].out ? HIDDEN_Z : Math.round(buf[i * 4 + 2]);
      const lp = this.lastPos[i];
      if (key || !lp || Math.abs(lp[0] - x) > MOVE_EPS_MM || Math.abs(lp[1] - y) > MOVE_EPS_MM || Math.abs(lp[2] - z) > MOVE_EPS_MM) {
        p.push(i, x, y, z);
        this.lastPos[i] = [x, y, z];
      }
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    const qq = {};
    for (const [k, v] of Object.entries(q)) if (v) qq[k] = v.map(r2);
    this.frames.push({ t: Math.round(t * 1000) / 1000, q: qq, p, n: ps.length, rate: ev ? r2(ev.rateCount) : null, rateKg: ev ? r2(ev.rateMass) : null, label });
  }

  /** 파일로 쓸 객체 */
  toJSON({ summary = null, history = [] } = {}) {
    return { schema: EPISODE_SCHEMA, created: new Date().toISOString(), ...this.meta, summary, dt: this.everyS, radii: this.radii, keyEvery: this.keyEvery, frames: this.frames, history };
  }
}

/** 읽은 객체 검사 → 재생용으로 정리. 형식이 틀리면 Error */
export function parseEpisode(obj) {
  if (!obj || obj.schema !== EPISODE_SCHEMA) throw new Error(`에피소드 형식이 아닙니다 (schema = ${obj?.schema ?? '없음'}, 기대값 ${EPISODE_SCHEMA}).`);
  if (!Array.isArray(obj.frames) || obj.frames.length < 2) throw new Error('프레임이 2개 미만입니다.');
  if (!obj.cell?.main) throw new Error('대형 로봇 정보(cell.main)가 없습니다.');
  return obj;
}

/**
 * 재생기 (화면과 무관한 상태만): 시각 t → 로봇 관절값(선형 보간), 입자 버퍼({ n, buf: [x, y, z, r] }), 회수율.
 * 입자 위치는 키 프레임부터 앞으로 누적해 만든다(되감기는 가까운 키 프레임에서 다시 누적).
 */
export class EpisodePlayer {
  constructor(ep) {
    this.ep = ep;
    this.frames = ep.frames;
    this.duration = this.frames.at(-1).t;
    this.t = 0;
    this.speed = 1;
    this.playing = false;
    const maxN = Math.max(...this.frames.map((f) => f.n), ep.radii.length);
    this.buf = new Float64Array(maxN * 4);
    this.cursor = -1; // buf에 반영된 마지막 프레임
  }

  /** 시각 t의 프레임 번호 (t 이하의 마지막) */
  indexAt(t) {
    const f = this.frames;
    let lo = 0, hi = f.length - 1;
    if (t >= f[hi].t) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** 입자 버퍼를 프레임 k 상태로 */
  applyParticles(k) {
    if (k === this.cursor) return;
    let from = this.cursor + 1;
    if (k < this.cursor || this.cursor < 0) from = Math.floor(k / this.ep.keyEvery) * this.ep.keyEvery; // 키 프레임부터 다시
    if (from > k) from = k;
    const radii = this.ep.radii;
    for (let j = from; j <= k; j++) {
      const p = this.frames[j].p;
      for (let a = 0; a < p.length; a += 4) {
        const i = p[a];
        this.buf[i * 4] = p[a + 1];
        this.buf[i * 4 + 1] = p[a + 2];
        const hidden = p[a + 3] === HIDDEN_Z;
        this.buf[i * 4 + 2] = hidden ? 0 : p[a + 3];
        this.buf[i * 4 + 3] = hidden ? 0 : radii[i] ?? 30;
      }
    }
    this.cursor = k;
  }

  /** 시각 t의 상태 */
  stateAt(t) {
    t = Math.max(0, Math.min(this.duration, t));
    const k = this.indexAt(t);
    const f0 = this.frames[k], f1 = this.frames[Math.min(k + 1, this.frames.length - 1)];
    const a = f1.t > f0.t ? (t - f0.t) / (f1.t - f0.t) : 0;
    const q = {};
    for (const slot of Object.keys(f0.q)) {
      const q0 = f0.q[slot], q1 = f1.q[slot] ?? q0;
      q[slot] = q0.map((v, i) => v + (q1[i] - v) * a);
    }
    this.applyParticles(k);
    return { t, k, q, particles: { n: f0.n, buf: this.buf }, rate: f0.rate, rateKg: f0.rateKg, label: f0.label };
  }

  /** 실제 경과 시간 dt(s)만큼 진행 (배속 반영). 끝에 닿으면 멈춤 */
  advance(dt) {
    if (!this.playing) return;
    this.t += dt * this.speed;
    if (this.t >= this.duration) {
      this.t = this.duration;
      this.playing = false;
    }
  }
}
