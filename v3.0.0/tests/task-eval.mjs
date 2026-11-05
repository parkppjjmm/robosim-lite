// v3.0.0 1단계: 작업 설정(task)·회수율 평가기·헤드리스 셀 시뮬레이터(cell-sim) 검증 (PRD_v.3.0.0 FR-54·55, AC-56·57)
// - sanitizeTask 기본값·범위·오류
// - 같은 task·seed → 같은 결과 (경로 계획 후처리 반복 횟수 고정 모드)
// - 정책 자리에 '규칙 재생 컨트롤러'(20 Hz Δq)를 넣으면 규칙 경로와 거의 같은 회수 (AC-57)
// 실행: node tests/task-eval.mjs   (SIM_S로 에피소드 길이 변경, 기본 90 s)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadRapier } from './lib/rapier.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const TE = await imp('task-eval.js');
const CS = await imp('cell-sim.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const RAPIER = await loadRapier();
const SIM_S = Number(process.env.SIM_S) || 90;

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

// ---- 1. 작업 설정 ----
{
  const { task, errors } = TE.sanitizeTask({}, robots);
  check('기본 task: 목표 80%, 600 s, 작업 영역, AI = 대형(KR 210), 오류 없음',
    errors.length === 0 && task.targetRatePct === 80 && task.timeLimitS === 600 && task.zone === 'work' && task.aiRobot.slot === 'main' && task.aiRobot.robotId === 'kuka-kr210-r2700',
    JSON.stringify({ target: task.targetRatePct, time: task.timeLimitS, ai: task.aiRobot }));
  const b = TE.sanitizeTask({ targetRatePct: 150, timeLimitS: 5, dross: { count: 9999 } }, robots).task;
  check('범위 밖 값은 한계로 자름 (목표 ≤ 100, 시간 ≥ 30 s, 드로스 ≤ 400)', b.targetRatePct === 100 && b.timeLimitS === 30 && b.dross.count === 400, `${b.targetRatePct} / ${b.timeLimitS} / ${b.dross.count}`);
  const c = TE.sanitizeTask({ aiRobot: { slot: 'left' }, cell: { left: { robotId: 'ur-ur10e', mode: 1 } } }, robots).task;
  check('AI 로봇 = 왼쪽 측면 UR10e 선택', c.aiRobot.slot === 'left' && c.aiRobot.robotId === 'ur-ur10e');
  const e1 = TE.sanitizeTask({ aiRobot: { slot: 'right' } }, robots).errors;
  check('빈 슬롯을 AI 로봇으로 고르면 오류', e1.length === 1, e1.join());
  const e2 = TE.sanitizeTask({ cell: { main: 'ur-ur5e' } }, robots).errors;
  check('도달거리가 부족한 대형 로봇은 오류', e2.length >= 1, e2[0]);
  const e3 = TE.sanitizeTask({ cell: { left: { robotId: 'kuka-kr210-r2700', mode: 1 } } }, robots).errors;
  check('대형 로봇을 측면에 두면 오류', e3.length === 1, e3.join());
}

// ---- 2. 결정성 + 규칙 재생 회귀 ----
const { task } = TE.sanitizeTask({ timeLimitS: SIM_S, cell: { left: { robotId: 'ur-ur10e', mode: 1 }, right: { robotId: 'abb-irb1200-5-09', mode: 1 } } }, robots);
const run = (o = {}) => CS.runEpisode(task, { RAPIER, robots, simS: SIM_S, ...o });
const a = await run();
const b = await run();
const sig = (r) => JSON.stringify({ rate: r.summary.rateCount, kg: r.summary.rateMass, by: r.summary.byRobot, cyc: r.summary.mainCycles, hist: r.out.history });
check(`같은 task·seed 두 번 → 같은 결과 (${SIM_S} s, 대형 + 측면 2대)`, sig(a) === sig(b), `회수율 ${a.summary.rateCount}% / ${b.summary.rateCount}%, 로봇별 ${JSON.stringify(a.summary.byRobot)}`);
check('규칙 실행: 안전 위반 0, 잠금 위반 0', a.summary.mainBlocked === 0 && a.summary.sideBlocked === 0 && a.summary.lockViolations === 0);
check('평가기: 회수 + 남음 + 흘림 ≤ 전체, 회수 = 박스 합', a.summary.collected + a.summary.remaining + a.summary.spilled <= a.summary.total
  && a.summary.collected === Object.values(a.summary.byRobot).reduce((s, v) => s + v.n, 0), JSON.stringify({ c: a.summary.collected, r: a.summary.remaining, s: a.summary.spilled, t: a.summary.total }));
console.log(`    배속 ${a.summary.speedup}× (시뮬레이션 ${a.summary.simS} s / 실제 ${a.summary.wallS} s)`);

const r = await run({ controller: new CS.RuleReplayController() });
const diff = Math.abs(r.summary.collected - a.summary.collected);
check('정책 자리에 규칙 재생(20 Hz Δq) → 규칙과 거의 같은 회수 (차 ≤ 2개 또는 10%)', r.summary.mainControl === 'policy' && r.summary.mainBlocked === 0 && diff <= Math.max(2, 0.1 * a.summary.collected),
  `규칙 ${a.summary.collected}개 (대형 ${a.summary.byRobot.main.n}) / 재생 ${r.summary.collected}개 (대형 ${r.summary.byRobot.main.n}), 정책 스텝 ${r.out.policySteps}`);

// ---- 3. 에피소드 기록 → 재생 (FR-63a, AC-71 Node 부분) ----
{
  const RP = await imp('replay.js');
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const rec = new RP.EpisodeRecorder({ everyS: 0.1, keyEveryS: 5 });
  const r3 = await run({ simS: 30, record: rec });
  const ep = RP.parseEpisode(JSON.parse(gunzipSync(gzipSync(JSON.stringify(r3.episode))).toString()));
  check('기록: 30 s → 프레임 301개, 대형·측면 관절값·회수율 포함', ep.frames.length === 301 && ep.frames.at(-1).q.main.length === 6 && !!ep.frames.at(-1).q.left && ep.frames.at(-1).rate === r3.summary.rateCount,
    `프레임 ${ep.frames.length}, 마지막 회수율 ${ep.frames.at(-1).rate}%`);
  const pl = new RP.EpisodePlayer(ep);
  const end = Array.from(pl.stateAt(pl.duration).particles.buf);
  const mid = pl.stateAt(12.34);
  const back = Array.from(pl.stateAt(pl.duration).particles.buf); // 되감기 후 다시 끝으로 → 같은 입자 위치
  check('재생: 되감기·앞으로 이동 후 같은 시각 = 같은 상태, 관절값 보간', end.every((v, i) => v === back[i]) && mid.t === 12.34 && mid.q.main.every(Number.isFinite),
    `12.34 s = ${mid.k}번 프레임, 회수율 ${mid.rate}%`);
  check('재생: 형식 검사 (schema 다르면 오류)', (() => { try { RP.parseEpisode({ schema: 'x' }); return false; } catch { return true; } })());
  const gz = gzipSync(JSON.stringify(r3.episode)).length;
  check('용량: 30 s 기록 gzip < 0.2 MB', gz < 200000, `${(gz / 1e3).toFixed(0)} kB`);
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
