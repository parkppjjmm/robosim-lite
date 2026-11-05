// 2-A: 거리 함수 정확도, 홈 자세 오탐, J3 접힘 Self 감지, J5 특이점 정지, 복구 규칙, 검사 시간
// 실행: node tests/safety.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const C = await imp('collision.js');
const S = await imp('safety.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };
const ALL = { selfCollision: true, obstacleCollision: true, singularity: true, autoPathPlanning: false };

// 1) distance primitives vs brute force
const rnd = (a, b) => a + Math.random() * (b - a);
let maxErr = 0;
for (let n = 0; n < 300; n++) {
  const seg = { a: [rnd(-500,500), rnd(-500,500), rnd(-500,500)], b: [rnd(-500,500), rnd(-500,500), rnd(-500,500)], r: 30 };
  const type = ['box','cylinder','sphere'][n % 3];
  const ob = C.compileObstacles([{ id: 'x', type, pos: [rnd(-200,200), rnd(-200,200), rnd(-200,200)], size: type==='sphere'?[200,200,200]:[rnd(50,300), type==='cylinder'?0:rnd(50,300), rnd(50,300)], rot: [rnd(-90,90), rnd(-90,90), rnd(-90,90)] }])[0];
  if (type === 'cylinder') ob.half[1] = ob.half[0];
  const fast = C.capsuleObstacleDistance(seg, ob);
  // brute: sample 4000 points, sdf via tiny capsule
  let brute = Infinity;
  for (let i = 0; i <= 4000; i++) {
    const t = i / 4000, p = seg.a.map((v, k) => v + (seg.b[k] - v) * t);
    brute = Math.min(brute, C.capsuleObstacleDistance({ a: p, b: p, r: 0 }, ob));
  }
  maxErr = Math.max(maxErr, Math.abs(fast - (brute - 30)));
}
console.log('capsule-obstacle distance max error vs brute force (mm):', maxErr.toFixed(3));
let segErr = 0;
for (let n = 0; n < 300; n++) {
  const P = () => [rnd(-500,500), rnd(-500,500), rnd(-500,500)];
  const [a, b, c, d] = [P(), P(), P(), P()];
  const fast = C.segmentSegmentDistance(a, b, c, d);
  let brute = Infinity;
  for (let i = 0; i <= 300; i++) for (let j = 0; j <= 300; j++) {
    const p = a.map((v,k)=>v+(b[k]-v)*i/300), q = c.map((v,k)=>v+(d[k]-v)*j/300);
    brute = Math.min(brute, Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]));
  }
  segErr = Math.max(segErr, fast - brute);
}
console.log('segment-segment: fast - brute (should be <= ~0):', segErr.toFixed(3));

// 2) per-robot checks
console.log('\n| 모델 | 홈 self 최소거리 | 홈 위반 | J3 접힘 감지 | J5→0 정지 각 | 셀프충돌 자세 비율(랜덤) |');
for (const r of robots) {
  const ctx = S.createSafetyContext(r, { features: ALL, thresholds: TH, obstacles: [], floor: true });
  const home = S.evaluatePose(ctx, K.homeJoints(r));
  // fold J3 to positive limit
  const target = K.homeJoints(r).slice(); target[2] = r.jointLimitsDeg[2][1];
  const fold = S.sweepCheck(ctx, home, target);
  // J5 to -30 through 0
  const t5 = K.homeJoints(r).slice(); t5[4] = -30;
  const sing = S.sweepCheck(ctx, home, t5);
  // random self-collision rate
  const selfOnly = S.createSafetyContext(r, { features: { ...ALL, obstacleCollision: false, singularity: false }, thresholds: TH, obstacles: [], floor: false });
  let hits = 0;
  for (let n = 0; n < 2000; n++) {
    const q = r.jointLimitsDeg.map(([lo, hi]) => rnd(lo, hi));
    if (S.evaluatePose(selfOnly, q).violations.length) hits++;
  }
  console.log(`| ${r.name} | ${home.self.minDistance.toFixed(0)} | ${home.violations.map(v=>v.type).join(',') || '없음'} | ${fold.ok ? '감지 안됨' : fold.blocked.map(b=>b.type).join(',') + ' @J3=' + fold.last.q[2].toFixed(1)} | ${sing.ok ? '-' : sing.blocked[0].type + ' @J5=' + sing.last.q[4].toFixed(2)} | ${(hits/20).toFixed(1)}% |`);
}

// 3) obstacle stop + recovery + perf with 10 obstacles
const r = robots.find(x => x.id === 'fanuc-m20id-25');
const obs = [{ id: 'b1', name: '박스 1', type: 'box', pos: [700, -500, 1500], size: [300, 300, 3000], rot: [0,0,0] }];
for (let i = 0; i < 9; i++) obs.push({ id: 'o'+i, name: 'o'+i, type: ['box','sphere','cylinder'][i%3], pos: [Math.cos(i)*1500, Math.sin(i)*1500, 300+i*80], size: [250,250,400], rot: [10*i, 5*i, 0] });
const ctx = S.createSafetyContext(r, { features: ALL, thresholds: TH, obstacles: obs, floor: true });
const home = S.evaluatePose(ctx, K.homeJoints(r));
const tgt = K.homeJoints(r).slice(); tgt[0] = -90;
const res = S.sweepCheck(ctx, home, tgt);
console.log('\nJ1 sweep toward box: ok=', res.ok, 'stopped at J1=', res.last.q[0].toFixed(2), 'hits=', JSON.stringify(res.hit?.obstacle.hits.slice(0,3)), 'last safe min dist=', res.last.obstacle.minDistance.toFixed(1));
// recovery: force in-collision pose, try moving deeper vs away
const inside = S.evaluatePose(ctx, [res.hit.q[0] - 3, ...res.hit.q.slice(1)]);
const deeper = S.sweepCheck(ctx, inside, [inside.q[0] - 3, ...inside.q.slice(1)]);
const away = S.sweepCheck(ctx, inside, [inside.q[0] + 10, ...inside.q.slice(1)]);
console.log('recovery: deeper blocked=', !deeper.ok, ' away allowed=', away.ok);
// perf: evaluate many poses
const N = 3000; let t0 = performance.now();
for (let i = 0; i < N; i++) S.evaluatePose(ctx, r.jointLimitsDeg.map(([lo, hi]) => rnd(lo, hi)));
console.log('evaluatePose avg (10 obstacles + floor + self + sing):', ((performance.now() - t0) / N * 1000).toFixed(1), 'µs');
