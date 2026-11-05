// 경로 계획 Web Worker: planner.js를 백그라운드에서 실행해 UI가 멈추지 않게 한다 (PRD FR-13)
// 메시지 규약:
//   in : { type: 'plan', requestId, robot, obstacles, thresholds, features, floor, start, goal, timeoutMs }
//        { type: 'cancel', requestId }
//   out: { type: 'progress', requestId, phase, ratio, nodes }
//        { type: 'result', requestId, ok: true, path: number[][], stats }
//        { type: 'result', requestId, ok: false, reason, message, stats }
import { planPath } from './planner.js';

const cancelled = new Set();

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.requestId);
    return;
  }
  if (msg.type !== 'plan') return;
  const { requestId } = msg;
  try {
    const result = await planPath(msg, {
      onProgress: (p) => self.postMessage({ type: 'progress', requestId, ...p }),
      isCancelled: () => cancelled.has(requestId),
    });
    self.postMessage({ type: 'result', requestId, ...result });
  } catch (err) {
    self.postMessage({ type: 'result', requestId, ok: false, reason: 'error', message: `계획 중 오류: ${err.message}`, stats: {} });
  } finally {
    cancelled.delete(requestId);
  }
};
