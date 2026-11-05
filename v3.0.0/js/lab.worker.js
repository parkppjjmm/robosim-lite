// 학습(Trial & Error) 실행 Worker (브라우저) — 화면이 멈추지 않도록 10분 과제 시뮬레이션과 탐색을 Worker에서 돌린다.
// 후보 평가는 lab-eval.worker.js 여러 개(병렬)에 나눠 맡긴다. tools/train.mjs(Node)와 같은 흐름.
// 메시지: { cmd: 'start', task, lab, robots, workers, compare } / { cmd: 'stop' }
//   → { type: 'status', text } / { type: 'progress', p } / { type: 'done', summary, log, episode, rule } / { type: 'error', message }
import { runLab } from './stroke-lab.js';
import { runEpisode } from './cell-sim.js';
import { EpisodeRecorder } from './replay.js';

const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';
let stop = false;

class EvalPool {
  constructor(n, robots) {
    this.idle = [];
    this.queue = [];
    this.wait = new Map();
    this.seq = 0;
    this.all = [];
    this.ready = Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./lab-eval.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.idle.push(w);
          this.pump();
          return resolve();
        }
        this.wait.get(m.id)?.(m.result);
        this.wait.delete(m.id);
        this.idle.push(w);
        this.pump();
      };
      w.onerror = (e) => reject(new Error(`평가 Worker 오류: ${e.message ?? e}`));
      w.postMessage({ type: 'init', robots });
      this.all.push(w);
    })));
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { id, job } = this.queue.shift();
      w.postMessage({ id, job });
    }
  }

  run(jobs) {
    return Promise.all(jobs.map((job) => new Promise((resolve) => {
      const id = ++this.seq;
      this.wait.set(id, resolve);
      this.queue.push({ id, job });
      this.pump();
    })));
  }

  close() {
    for (const w of this.all) w.terminate();
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'stop') {
    stop = true;
    return;
  }
  if (m.cmd !== 'start') return;
  stop = false;
  let pool = null;
  try {
    self.postMessage({ type: 'status', text: '물리엔진·평가 Worker 준비 중…' });
    const mod = await import(RAPIER_URL);
    const RAPIER = mod.default ?? mod;
    await RAPIER.init();
    pool = new EvalPool(m.workers, m.robots);
    await pool.ready;
    self.postMessage({ type: 'status', text: `학습 중 (평가 Worker ${m.workers}개)` });
    const t0 = performance.now();
    const res = await runLab({
      RAPIER, robots: m.robots, task: m.task, lab: m.lab, runEpisode, record: new EpisodeRecorder({ everyS: 0.1 }),
      evalBatch: (jobs) => pool.run(jobs),
      onProgress: (p) => self.postMessage({ type: 'progress', p: { ...p, elapsedS: (performance.now() - t0) / 1000 } }),
      shouldStop: () => stop,
    });
    pool.close();
    pool = null;
    let rule = null;
    if (m.compare && !stop) {
      self.postMessage({ type: 'status', text: '비교용 규칙 경로 실행 중…' });
      rule = await runEpisode(m.task, { RAPIER, robots: m.robots, record: new EpisodeRecorder({ everyS: 0.1 }) });
    }
    self.postMessage({ type: 'done', summary: res.log.summary, log: res.log, episode: { ...res.episode, lab: { method: m.lab.method, reward: m.lab.reward } }, rule: rule ? { summary: rule.summary, episode: rule.episode } : null, stopped: stop, elapsedS: (performance.now() - t0) / 1000 });
  } catch (err) {
    pool?.close();
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
