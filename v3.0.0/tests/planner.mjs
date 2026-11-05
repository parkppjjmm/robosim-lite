// 2-C: 12개 모델 벽 우회, 장애물 10개 무작위, TCP 목표·실패 원인 분류
// 실행: node tests/planner.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const S = await imp('safety.js');
const P = await imp('planner.js');
const C = await imp('collision.js'); const TR = await imp('trajectory.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const TH = { selfMarginMm: 10, obstacleMarginMm: 20, wristDeg: 5, shoulderMm: 50, elbowDeg: 3 };

// 결과 검증: 시간 파라미터화된 궤적을 2mm 수준으로 촘촘히 재검사 + 속도 한계
function verify(robot, obstacles, path, features, blends) {
  const ctx = S.createSafetyContext(robot, { features: { selfCollision: true, obstacleCollision: true, singularity: !!features?.singularity }, thresholds: TH, obstacles, floor: true });
  const tr = TR.pathTrajectory(robot, path, blends);
  let bad = 0, minObs = Infinity;
  for (let k = 1; k < tr.points.length; k++) {
    const a = tr.points[k - 1], b = tr.points[k];
    for (let j = 0; j <= 4; j++) {
      const e = S.evaluatePose(ctx, a.map((v, i) => v + (b[i] - v) * j / 4));
      if (e.violations.length) bad++;
      minObs = Math.min(minObs, C.checkObstacleCollision(e.segments, ctx.compiled, 1e9, { floor: true }).minDistance);
    }
  }
  let overV = 0;
  for (let k = 1; k < tr.points.length; k++) {
    const dt = tr.times[k] - tr.times[k - 1];
    tr.points[k].forEach((v, i) => { if (Math.abs(v - tr.points[k - 1][i]) / dt > robot.maxJointSpeedDegS[i] * TR.BASE_JOINT_RATIO * 1.01) overV++; });
  }
  return { bad, minObs: minObs.toFixed(1), overV, duration: tr.duration.toFixed(2) };
}

const run = async (robot, obstacles, start, goal, extra = {}) => {
  const res = await P.planPath({ robot, obstacles, thresholds: TH, features: extra.features ?? {}, floor: true, start, goal, timeoutMs: extra.timeoutMs ?? 5000 });
  const v = res.ok ? verify(robot, obstacles, res.path, extra.features, res.blends) : null;
  return { ok: res.ok, reason: res.reason, ms: res.stats.timeMs, nodes: res.stats.nodes, direct: res.stats.direct, verts: `${res.stats.rawVertices}->${res.stats.vertices}`, opt: res.stats.optimized, verify: v };
};

// 시나리오 1: 벽 (각 로봇) — 시작 J1=-60, 목표 J1=+60, 전방에 높은 벽
console.log('## 1) 벽 우회 (12개 모델)');
for (const r of robots) {
  const R = r.reachMm;
  const home = K.homeJoints(r);
  const start = home.slice(); start[0] = -60;
  const goal = home.slice(); goal[0] = 60;
  // 홈 TCP 높이보다 조금 높은 벽을 정면에 세움 → J1만 돌리는 직선 경로는 반드시 막힘
  const H = r.dh[0].d + r.dh[1].a + r.dh[2].a + R * 0.15;
  const wall = [{ id: 'wall', name: 'wall', type: 'box', pos: [R * 0.62, 0, H / 2], size: [R * 0.1, R * 0.3, H], rot: [0, 0, 0] }];
  const out = await run(r, wall, start, { type: 'joints', joints: goal });
  console.log(r.name.padEnd(24), JSON.stringify(out));
}

// 시나리오 2: 복잡 환경 장애물 10개, 10회 평균 (FANUC M-20iD/25)
console.log('\n## 2) 장애물 10개, 무작위 시작/목표 10회 (M-20iD/25)');
const r = robots.find((x) => x.id === 'fanuc-m20id-25');
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const obs = [];
for (let i = 0; i < 10; i++) {
  const ang = (i / 10) * Math.PI * 2 + 0.2, rad = 900 + rnd() * 600;
  obs.push({ id: 'o' + i, name: 'o' + i, type: ['box', 'sphere', 'cylinder'][i % 3], pos: [Math.cos(ang) * rad, Math.sin(ang) * rad, 300 + rnd() * 900], size: [250, 250, 350], rot: [0, 0, rnd() * 90] });
}
const ctxAll = S.createSafetyContext(r, { features: { selfCollision: true, obstacleCollision: true, singularity: false }, thresholds: TH, obstacles: obs, floor: true });
const validQ = () => { for (;;) { const q = r.jointLimitsDeg.map(([lo, hi], i) => i >= 3 ? lo / 3 + (hi - lo) / 3 * rnd() : lo + (hi - lo) * rnd()); if (!S.evaluatePose(ctxAll, q).violations.length) return q; } };
let total = 0, okCount = 0, direct = 0; const times = [];
for (let n = 0; n < 10; n++) {
  const out = await run(r, obs, validQ(), { type: 'joints', joints: validQ() });
  if (out.ok) { okCount++; if (out.direct) direct++; }
  times.push(out.ms); total += out.ms;
  if (!out.ok || out.verify.bad || out.verify.overV) console.log('  run', n, JSON.stringify(out));
}
console.log(`  성공 ${okCount}/10 (직선 ${direct}), 평균 ${(total / 10).toFixed(0)} ms, 최대 ${Math.max(...times)} ms, 각 ${times.join(',')}`);

// 시나리오 3: TCP 목표, 실패 케이스
console.log('\n## 3) TCP 목표 / 실패 분류 (M-20iD/25)');
const home = K.homeJoints(r);
const wall = [{ id: 'wall', name: 'wall', type: 'box', pos: [1100, 0, 1100], size: [200, 600, 2200], rot: [0, 0, 0] }];
const s3 = home.slice(); s3[0] = -70;
console.log('  TCP goal (1200, 600, 900, 180,0,0):', JSON.stringify(await run(r, wall, s3, { type: 'pose', pos: [1200, 600, 900], rpy: [180, 0, 0] })));
console.log('  unreachable TCP (3000,0,500):', JSON.stringify(await run(r, wall, s3, { type: 'pose', pos: [3000, 0, 500], rpy: [180, 0, 0] })));
console.log('  goal inside obstacle:', JSON.stringify(await run(r, wall, s3, { type: 'pose', pos: [1100, 0, 1100], rpy: [180, 0, 0] })));
const startIn = home.slice();
console.log('  start in collision:', JSON.stringify(await run(r, [{ id: 'x', type: 'sphere', pos: [965, 0, 1480], size: [300, 300, 300] }], startIn, { type: 'joints', joints: s3 })));
// 풀 수 있지만 시간이 부족한 경우 → timeout 분류 (20 ms)
{ const H = r.dh[0].d + r.dh[1].a + r.dh[2].a + r.reachMm * 0.15; const st = home.slice(); st[0] = -60; const gl = home.slice(); gl[0] = 60;
  console.log('  timeout (1ms):', JSON.stringify(await run(r, [{ id: 'w', type: 'box', pos: [r.reachMm * 0.62, 0, H / 2], size: [r.reachMm * 0.1, r.reachMm * 0.3, H], rot: [0,0,0] }], st, { type: 'joints', joints: gl }, { timeoutMs: 1 }))); }
// 특이점 회피 ON: 시작 J5=40 → 목표 J5=-40 (손목 특이점 J5=0 통과해야 하는 직선 경로)
const a = home.slice(); a[4] = 40; const b = home.slice(); b[4] = -40; b[0] = 30;
console.log('  singularity avoid ON (J5 +40 → -40):', JSON.stringify(await run(r, [], a, { type: 'joints', joints: b }, { features: { singularity: true } })));
const c = home.slice(); c[4] = 60; c[0] = 30;
console.log('  singularity avoid ON (J5 +40 → +60, J1 30):', JSON.stringify(await run(r, [], a, { type: 'joints', joints: c }, { features: { singularity: true } })));
