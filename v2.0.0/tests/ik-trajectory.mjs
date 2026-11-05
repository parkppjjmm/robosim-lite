// 2-B: IK 수렴률, 직선 보간(LIN) 편차, PTP 속도 한계
// 실행: node tests/ik-trajectory.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const TR = await imp('trajectory.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const randQ = (r) => r.jointLimitsDeg.map(([lo, hi]) => lo + (hi - lo) * rnd());

// rotation utils sanity
const w = [0.3, -1.1, 0.7]; const back = K.logRotation(K.expRotation(w));
console.log('exp/log roundtrip err:', Math.hypot(...back.map((v,i)=>v-w[i])).toExponential(2));
const w2 = [Math.PI - 1e-7, 0, 0]; console.log('log near pi:', K.logRotation(K.expRotation(w2)).map(v=>v.toFixed(4)).join(','));

console.log('\n| 모델 | 근접 시드 IK 성공 | 평균 반복 | 다중시드(홈) 성공 | 해 개수(평균) | 직선 +X200 | 관절PTP 속도 위반 |');
for (const r of robots) {
  let near = 0, iters = 0, multi = 0, nsol = 0;
  const N = 60;
  for (let n = 0; n < N; n++) {
    const q = randQ(r);
    const T = K.forwardKinematics(r, q).frames[6];
    const seedQ = q.map((v, i) => v + (rnd() - 0.5) * 20);
    const res = K.solveIK(r, T, seedQ);
    if (res.ok) { near++; iters += res.iterations; }
    if (n < 15) {
      const sols = K.solveIKMulti(r, T, { seeds: [K.homeJoints(r)] });
      if (sols.length) multi++;
      nsol += sols.length;
      // all solutions really reach the target
      for (const s of sols) { const e = K.poseError(K.forwardKinematics(r, s).frames[6], T); if (e.pos > 0.1 || e.rot*K.RAD > 0.05) console.log('BAD SOLUTION', r.name); }
    }
  }
  // linear move from home +X 200 mm
  const h = K.homeJoints(r);
  const Th = K.forwardKinematics(r, h).frames[6].slice(); Th[3] += Math.min(200, r.reachMm*0.15);
  const lin = TR.linearMove(r, h, Th);
  let straight = 'fail:' + lin.reason;
  if (lin.ok) {
    // max deviation from line
    const p0 = K.forwardKinematics(r, h).tcp.pos; let dev = 0;
    for (const q of lin.trajectory.points) { const p = K.forwardKinematics(r, q).tcp.pos; dev = Math.max(dev, Math.hypot(p[1]-p0[1], p[2]-p0[2])); }
    straight = `ok ${lin.trajectory.duration.toFixed(2)}s 편차 ${dev.toFixed(3)}mm`;
  }
  // joint PTP speed check
  const a = randQ(r), b = randQ(r); const pt = TR.jointMove(r, a, b);
  let over = 0;
  for (let k = 1; k < pt.points.length; k++) {
    const dt = pt.times[k] - pt.times[k-1];
    pt.points[k].forEach((v, i) => { const sp = Math.abs(v - pt.points[k-1][i]) / dt; if (sp > r.maxJointSpeedDegS[i] * TR.BASE_JOINT_RATIO * 1.001) over++; });
  }
  console.log(`| ${r.name} | ${near}/${N} | ${(iters/Math.max(near,1)).toFixed(1)} | ${multi}/15 | ${(nsol/15).toFixed(1)} | ${straight} | ${over} |`);
}
// timing
const r = robots[7]; const q = randQ(r); const T = K.forwardKinematics(r, q).frames[6];
let t0 = performance.now(); for (let i = 0; i < 200; i++) K.solveIK(r, T, q.map(v => v + 3)); console.log('\nIK near-seed avg ms:', ((performance.now()-t0)/200).toFixed(3));
t0 = performance.now(); K.solveIKMulti(r, T, { seeds: [K.homeJoints(r)] }); console.log('IK multi (25 seeds) ms:', (performance.now()-t0).toFixed(1));
const h = K.homeJoints(r); const Tf = K.forwardKinematics(r, h).frames[6].slice(); Tf[3] += 500; Tf[11] -= 300;
t0 = performance.now(); const lm = TR.linearMove(r, h, Tf); console.log('linearMove 583mm ms:', (performance.now()-t0).toFixed(1), 'ok', lm.ok, 'samples', lm.trajectory?.points.length);
