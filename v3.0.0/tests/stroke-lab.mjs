// v3.0.0: 학습(Trial & Error) 엔진 검증 — 스트로크 표현·설정 검증·후보 평가·진화 탐색 (PRD_v.3.0.0 4.5·FR-67)
// 실행: node tests/stroke-lab.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const L = await imp('stroke-lab.js');
const K = await imp('kinematics.js');
const P = await imp('physics.js');
const D = await imp('dross.js');
const TE = await imp('task-eval.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const RAPIER = await loadRapier();

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

// ---- 1. 설정·스트로크 표현 ----
{
  const lab = L.sanitizeLab({ population: 9999, method: 'xx', reward: { emptyStroke: -50 }, search: { tiltDeg: { on: false, fixed: 7 }, yaw0Deg: { min: 90, max: -90 } } });
  check('설정 검증: 범위 자르기·모르는 방법은 기본·사용자 보상 반영·최소>최대면 바꿈', lab.population === 256 && lab.method === 'cem' && lab.reward.emptyStroke === -50 && lab.reward.perDross === 10
    && lab.search.yaw0Deg.min === -90 && lab.search.yaw0Deg.max === 90 && !lab.search.tiltDeg.on);
  check('탐색 변수 = 켠 것만 (기울임 끔 → 8개)', L.searchKeys(lab).length === 8);
  const s = L.decodeStroke(new Array(8).fill(0.5), lab);
  check('탐색 끈 변수는 고정값 (기울임 7°)', s.tiltDeg === 7);
  const clipped = L.strokeFromValues({ x0: 1500, y0: 0, headingDeg: 0, lengthMm: 2000, yaw0Deg: 0, yaw1Deg: 0, tiltDeg: 0, depthMm: 60, speedMmS: 120 });
  check('끝점은 포트 안쪽(스나우트 앞 230 mm = 규칙 레인 여유)에서 멈춤', Math.abs(clipped.end[0] - (D.SNOUT.x0 - 230)) < 1e-6 && clipped.lengthMm < 2000, `끝 X ${clipped.end[0].toFixed(0)}, 길이 ${clipped.lengthMm.toFixed(0)}`);
  const flip = L.strokeFromValues({ x0: 2050, y0: 0, headingDeg: 0, lengthMm: 600, yaw0Deg: 0, yaw1Deg: 0, tiltDeg: 0, depthMm: 60, speedMmS: 120 });
  check('경계에서 바깥을 향한 스트로크(길이 ≈ 0)는 방향을 뒤집어 헛스트로크 방지', flip.lengthMm >= 200 && flip.end[0] < flip.start[0], `길이 ${flip.lengthMm.toFixed(0)}, 끝 X ${flip.end[0].toFixed(0)}`);
  const zb = L.zoneBox({ left: { robotId: 'ur-ur10e', mode: 1 }, right: { robotId: null } });
  check('측면 로봇 구역 제약: 왼쪽 모드 1이면 대형 스트로크 Y ≤ 230 (규칙 레인과 같음)', zb.y1 === 230 && zb.y0 === -670, JSON.stringify(zb));
  const v = { x0: 1800, y0: -300, headingDeg: 200, lengthMm: 600, yaw0Deg: 30, yaw1Deg: -40, tiltDeg: 5, depthMm: 50, speedMmS: 100 };
  const full = L.sanitizeLab({});
  const back = L.decodeStroke(L.encodeValues(v, full), full).values;
  check('변수 → 정규화 → 변수 왕복 일치', Object.keys(v).every((k) => Math.abs(back[k] - v[k]) < 1e-9));
}

// ---- 2. 후보 평가 ----
const robot = robots.find((r) => r.id === 'kuka-kr210-r2700');
const w = new P.PhysicsWorld(RAPIER);
w.setFixtures(D.drossFixtures({}));
w.load([]);
new D.DrossField(w, { count: 160, seed: 11 }).init();
for (let i = 0; i < 90; i++) w.step();
const particles = L.snapshotParticles(w);
const task = TE.sanitizeTask({}, robots).task;
const rv = L.ruleValues(w.particleState(), {}, TE.TASK_THRESHOLDS, task);
const job = (values) => ({ robot, q0: K.homeJoints(robot), particles, stroke: L.strokeFromValues(values), reward: L.REWARD_DEFAULTS, sides: {}, thresholds: TE.TASK_THRESHOLDS });
const a = await L.evaluateStroke(RAPIER, job(rv));
const a2 = await L.evaluateStroke(RAPIER, job(rv));
check('평가: 규칙 레인 스트로크 실행 가능·회수 > 0, 같은 입력 → 같은 결과', a.feasible && a.collected > 0 && a.score === a2.score && a.collected === a2.collected, `회수 ${a.collected}, 점수 ${a.score.toFixed(1)}, ${a.durationS} s`);
check('평가: 점수 = 보상 규칙 계산과 같음', Math.abs(a.score - L.scoreStroke(a, L.REWARD_DEFAULTS)) < 1e-9);
const side = await L.evaluateStroke(RAPIER, job({ ...rv, yaw0Deg: 90, yaw1Deg: 90 }));
check('평가: 열린 면을 옆으로(+90°) 돌리면 결과가 달라짐 (J6 자유도 반영)', side.feasible && side.collected !== a.collected, `회수 ${side.collected} vs ${a.collected}`);
const bad = await L.evaluateStroke(RAPIER, job({ ...rv, yaw0Deg: 0, yaw1Deg: 90 }));
check('평가: 벽에 부딪히는 회전 스윕은 계획 단계에서 불가 → 불가 점수', !bad.feasible && bad.score === L.REWARD_DEFAULTS.infeasible, bad.message ?? '');
const empty = L.scoreStroke({ feasible: true, collected: 0, wallCollected: 0, spilled: 0, durationS: 30 }, { ...L.REWARD_DEFAULTS, emptyStroke: -50 });
check('헛질 벌점: 0개 회수면 사용자 헛질 값 적용', empty === -50 + -0.2 * 30, String(empty));

// ---- 3. 진화 탐색 (가짜 평가 함수로 수렴 확인) ----
{
  const lab = L.sanitizeLab({ population: 24, iterations: 6, includeRule: false, search: { x0: { on: true }, y0: { on: true }, headingDeg: { on: false }, lengthMm: { on: false }, yaw0Deg: { on: false }, yaw1Deg: { on: false }, tiltDeg: { on: false }, depthMm: { on: false }, speedMmS: { on: false } } });
  const target = [1500, 400];
  const fake = async (strokes) => strokes.map((s) => ({ feasible: true, score: -Math.hypot(s.values.x0 - target[0], s.values.y0 - target[1]), collected: 1, wallCollected: 0, spilled: 0, durationS: 1 }));
  const { best, trials } = await L.searchStroke({ lab, rand: D.rng(5), seedValues: null, evalBatch: fake });
  const err = Math.hypot(best.stroke.values.x0 - target[0], best.stroke.values.y0 - target[1]);
  const rnd = await L.searchStroke({ lab: { ...lab, method: 'random' }, rand: D.rng(5), seedValues: null, evalBatch: fake });
  const errR = Math.hypot(rnd.best.stroke.values.x0 - target[0], rnd.best.stroke.values.y0 - target[1]);
  check('진화 탐색(CEM)이 목표 근처로 수렴 (오차 < 60 mm, 같은 예산의 무작위 탐색보다 작음)', err < 60 && err <= errR && trials.length === 144, `CEM ${err.toFixed(0)} mm / 무작위 ${errR.toFixed(0)} mm, 시도 ${trials.length}`);
  const withRule = await L.searchStroke({ lab: { ...lab, includeRule: true, iterations: 1 }, rand: D.rng(5), seedValues: { ...rv, x0: 1500, y0: 400 }, evalBatch: fake });
  check('규칙 후보 포함: 첫 세대 첫 후보 = 규칙 경로 (결정마다 규칙보다 나쁘지 않음)', withRule.trials[0].rule && withRule.best.result.score >= withRule.trials[0].score);
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
