// 모션 컨트롤러: 모든 모션 소스(관절 조그, 궤적 재생 — 직교 조그 / Waypoint / 2-C 경로 실행)는 tick()에서
// 다음 관절값을 내고, 적용 전에 safety.sweepCheck()를 통과해야 한다 (PRD 6.5).
import { sweepCheck, evaluatePose } from './safety.js';
import { sampleTrajectory } from './trajectory.js';

/**
 * 모션 소스 형식: { kind, next(q, dt) => { q, done }, onEnd?(reason), onProgress?(t) }
 * onEnd reason: 'done' | 'blocked' | 'stopped'
 */
export class MotionController {
  /**
   * @param {{ onApply: (evaluation) => void, onBlocked: (result) => void }} handlers
   *   onApply: 안전한 새 자세가 적용될 때, onBlocked: 위반 감지로 정지했을 때
   */
  constructor({ onApply, onBlocked }) {
    this.onApply = onApply;
    this.onBlocked = onBlocked;
    this.ctx = null;
    this.current = null; // 현재 자세의 evaluatePose 결과
    this.source = null;
    this.paused = false;
    this.locked = false; // 알람 중에는 true → 모든 모션 거부
  }

  /** 로봇/환경 변경 시 호출. 현재 자세를 새 컨텍스트로 다시 평가해서 반환한다. */
  setContext(ctx, joints) {
    this.ctx = ctx;
    this.current = evaluatePose(ctx, joints);
    return this.current;
  }

  get active() {
    return this.source !== null;
  }

  get kind() {
    return this.source?.kind ?? null;
  }

  /** 새 소스 시작 (이전 소스는 'stopped'로 종료) */
  start(source) {
    if (this.locked) return false;
    this.end('stopped');
    this.source = source;
    this.paused = false;
    return true;
  }

  /**
   * 관절 조그: 목표 관절값을 향해 관절별 최대속도로 이동한다.
   * @returns {boolean} 거부되면 false
   */
  jogTo(target, speedRatio = 1) {
    if (this.locked) return false;
    // 진행 중인 관절 조그는 목표만 바꾼다 (슬라이더 드래그 중 매 입력마다 소스를 새로 만들지 않음)
    if (this.source?.kind === 'jog') {
      this.source.target = target;
      this.paused = false;
      return true;
    }
    const speeds = this.ctx.robot.maxJointSpeedDegS.map((v) => v * speedRatio);
    return this.start({
      kind: 'jog',
      target,
      next(q, dt) {
        const out = q.map((v, i) => {
          const d = this.target[i] - v;
          const step = speeds[i] * dt;
          return Math.abs(d) <= step ? this.target[i] : v + Math.sign(d) * step;
        });
        return { q: out, done: out.every((v, i) => v === this.target[i]) };
      },
    });
  }

  /**
   * 궤적 재생. rate()는 매 tick 읽으므로 재생 중 속도 변경이 바로 반영된다.
   * @param {{ kind?: string, rate?: () => number, onProgress?: (t, duration) => void, onEnd?: (reason) => void }} opts
   */
  play(trajectory, { kind = 'trajectory', rate = () => 1, onProgress, onEnd } = {}) {
    let t = 0;
    return this.start({
      kind,
      trajectory,
      onEnd,
      next(q, dt) {
        t = Math.min(trajectory.duration, t + dt * rate());
        onProgress?.(t, trajectory.duration);
        return { q: sampleTrajectory(trajectory, t), done: t >= trajectory.duration };
      },
    });
  }

  pause() {
    if (this.source) this.paused = true;
  }

  resume() {
    if (this.source && !this.locked) this.paused = false;
  }

  stop() {
    this.end('stopped');
  }

  end(reason) {
    const src = this.source;
    this.source = null;
    this.paused = false;
    src?.onEnd?.(reason);
  }

  /**
   * 시뮬레이션 1스텝 (렌더 루프에서 고정 주기로 호출)
   * @returns {number} 안전 검사 소요 시간 (ms), 이동이 없으면 0
   */
  tick(dt) {
    if (!this.source || this.paused || this.locked) return 0;
    const { q, done } = this.source.next(this.current.q, dt);
    const t0 = performance.now();
    const result = sweepCheck(this.ctx, this.current, q);
    const elapsed = performance.now() - t0;

    this.current = result.last;
    if (!result.ok) {
      this.end('blocked');
      this.onApply(result.last);
      this.onBlocked(result);
    } else {
      if (done) this.end('done');
      this.onApply(result.last);
    }
    return elapsed;
  }
}
