// 학습(Trial & Error) 후보 평가 Worker (브라우저). lab.worker.js가 여러 개 띄운다. tools/lab-worker.mjs(Node)와 같은 역할.
// Worker에서는 index.html의 importmap을 쓸 수 없어 Rapier를 같은 주소(버전 고정)로 직접 불러온다.
import { evaluateStroke } from './stroke-lab.js';

const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';
let RAPIER = null;
let robots = [];

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    robots = m.robots;
    const mod = await import(RAPIER_URL);
    RAPIER = mod.default ?? mod;
    await RAPIER.init();
    self.postMessage({ type: 'ready' });
    return;
  }
  try {
    const robot = robots.find((r) => r.id === m.job.robotId);
    const result = await evaluateStroke(RAPIER, { ...m.job, robot });
    delete result.q1;
    self.postMessage({ id: m.id, result });
  } catch (err) {
    self.postMessage({ id: m.id, result: { feasible: false, score: m.job.reward.infeasible, collected: 0, wallCollected: 0, spilled: 0, durationS: 0, stage: 'error', message: String(err?.message ?? err) } });
  }
};
