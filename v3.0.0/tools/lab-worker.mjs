// 학습(Trial & Error) 후보 평가 작업자 — Node worker_threads. tools/train.mjs의 EvalPool이 띄운다.
// 메시지: { type: 'init', robots } → { type: 'ready' } / { id, job } → { id, result }
import { parentPort } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { loadRapier } = await import(pathToFileURL(`${root}/tests/lib/rapier.mjs`));
const { evaluateStroke } = await import(pathToFileURL(`${root}/js/stroke-lab.js`));
const RAPIER = await loadRapier();
let robots = [];

parentPort.on('message', async (m) => {
  if (m.type === 'init') {
    robots = m.robots;
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  try {
    const robot = robots.find((r) => r.id === m.job.robotId);
    const result = await evaluateStroke(RAPIER, { ...m.job, robot });
    delete result.q1;
    parentPort.postMessage({ id: m.id, result });
  } catch (err) {
    parentPort.postMessage({ id: m.id, result: { feasible: false, score: m.job.reward.infeasible, collected: 0, wallCollected: 0, spilled: 0, durationS: 0, stage: 'error', message: String(err?.message ?? err) } });
  }
});
