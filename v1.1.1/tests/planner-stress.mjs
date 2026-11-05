// 경로 계획 스트레스: 무작위 60회 계획 → 결과 궤적 촘촘 재검사(여유거리 침범 0), 시간, 최적화 효과
// 실행: node tests/planner-stress.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js'); const S = await imp('safety.js'); const P = await imp('planner.js'); const TR = await imp('trajectory.js'); const C = await imp('collision.js');
let exactObs;
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const innerAll = []; let blendedTotal = 0, vertsTotal = 0, overV = 0; const optRows = []; let durSum = 0;
let plans = 0, ok = 0, bad = 0, worstAll = Infinity, worstSelf = Infinity; const times = [];
for (let run = 0; run < 60; run++) {
  const r = robots[run % robots.length]; const R = r.reachMm;
  const obs = [];
  for (let i = 0; i < 10; i++) { const ang = rnd() * Math.PI * 2, rad = R * (0.45 + rnd() * 0.6);
    obs.push({ id: 'o' + i, type: ['box', 'sphere', 'cylinder'][i % 3], pos: [Math.cos(ang) * rad, Math.sin(ang) * rad, R * (0.1 + rnd() * 0.9)], size: [R * 0.15, R * 0.15, R * 0.3], rot: [rnd() * 40, rnd() * 40, rnd() * 90] }); }
  const ctx = S.createSafetyContext(r, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: TH, obstacles: obs, floor: true });
  exactObs = (e) => C.checkObstacleCollision(e.segments, ctx.compiled, 1e9, { floor: true }).minDistance;
  const pad = S.SWEEP_STEP_MM / 2;
  const ctxPad = S.createSafetyContext(r, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: { ...TH, selfMarginMm: 10 + pad, obstacleMarginMm: 20 + pad }, obstacles: obs, floor: true });
  const validQ = () => { for (let t = 0; t < 5000; t++) { const q = r.jointLimitsDeg.map(([lo, hi], i) => i >= 3 ? Math.max(lo, -150) + (Math.min(hi, 150) - Math.max(lo, -150)) * rnd() : lo + (hi - lo) * rnd()); if (!S.evaluatePose(ctxPad, q).violations.length) return q; } return null; };
  const a = validQ(), b = validQ(); if (!a || !b) continue;
  plans++;
  const res = await P.planPath({ robot: r, obstacles: obs, thresholds: TH, features: {}, floor: true, start: a, goal: { type: 'joints', joints: b }, timeoutMs: 5000 });
  times.push(res.stats.timeMs);
  if (res.stats.timeMs > 700) console.log('slow', run, r.name, res.stats.timeMs, 'opt', res.stats.optimized?.ms, 'iters', res.stats.optimized?.iterations, 'blend', res.stats.blendMs, 'nodes', res.stats.nodes, 'direct', res.stats.direct, 'verts', res.stats.rawVertices, res.stats.vertices);
  if (!res.ok) { console.log('fail', run, r.name, res.reason); continue; }
  ok++;
  const tr = TR.pathTrajectory(r, res.path, res.blends);
  blendedTotal += res.stats.blended; durSum += tr.duration; if (res.stats.optimized) optRows.push(res.stats.optimized); vertsTotal += Math.max(0, res.path.length - 2);
  for (let k = 1; k < tr.points.length; k++) { const dt = tr.times[k] - tr.times[k-1]; if (dt > 0) for (let i = 0; i < 6; i++) overV = Math.max(overV, Math.abs(tr.points[k][i]-tr.points[k-1][i])/dt / (r.maxJointSpeedDegS[i]*TR.BASE_JOINT_RATIO)); }
  let inner = Infinity;
  for (let k = 0; k < tr.points.length; k++) { const tt = tr.times[k] / tr.duration; if (tt > 0.15 && tt < 0.85) inner = Math.min(inner, exactObs(S.evaluatePose(ctx, tr.points[k]))); }
  innerAll.push(inner);
  let worst = Infinity, wSelf = Infinity;
  for (let k = 1; k < tr.points.length; k++) for (let j = 0; j < 6; j++) {
    const e = S.evaluatePose(ctx, tr.points[k - 1].map((v, i) => v + (tr.points[k][i] - v) * j / 6));
    worst = Math.min(worst, exactObs(e)); wSelf = Math.min(wSelf, e.self.minDistance);
  }
  worstAll = Math.min(worstAll, worst); worstSelf = Math.min(worstSelf, wSelf);
  if (worst < 19.9 || wSelf < 9.9) { bad++; console.log('BAD', run, r.name, worst.toFixed(1), wSelf.toFixed(1), res.stats); }
}
times.sort((x, y) => x - y);
console.log(`plans ${plans}, success ${ok}, margin violations ${bad}, worst obstacle clearance ${worstAll.toFixed(1)} mm (margin 20), worst self ${worstSelf.toFixed(1)} mm (margin 10)`);
console.log(`time ms: avg ${(times.reduce((s, v) => s + v, 0) / times.length).toFixed(0)}, median ${times[times.length >> 1]}, p90 ${times[Math.floor(times.length * 0.9)]}, max ${times.at(-1)}`);
console.log(`blended corners ${blendedTotal}\/${vertsTotal}, max joint speed ratio ${overV.toFixed(3)} (<=1.0)`);
const ap = optRows.filter((o) => o.applied);
const avg = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
console.log(`optimizer: ran ${optRows.length}, applied ${ap.length}, clearance(min, padded margin 기준) before avg ${avg(ap.map((o) => o.clearanceBefore))} → after avg ${avg(ap.map((o) => o.clearanceAfter))} mm, iters avg ${avg(ap.map((o) => o.iterations))}; avg duration ${(durSum / Math.max(1, ok)).toFixed(2)} s`);
const fin = innerAll.filter(Number.isFinite).sort((a, b) => a - b);
console.log(`inner (15~85% 구간) 최소 장애물 거리: min ${fin[0]?.toFixed(1)}, p10 ${fin[Math.floor(fin.length * 0.1)]?.toFixed(1)}, median ${fin[fin.length >> 1]?.toFixed(1)} mm`);
