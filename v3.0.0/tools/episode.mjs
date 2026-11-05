// v3.0.0: 헤드리스 에피소드 1회 실행 → 3D 재생 파일(.rsim.json.gz) 저장
// 앱의 '에피소드 재생' 패널에서 이 파일을 불러오면 같은 실행을 3D로 다시 볼 수 있다(재생·일시정지·배속·시간 이동).
// 실행: node tools/episode.mjs [--main kuka-kr210-r2700] [--config alone|mode1|mode2] [--left ur-ur10e:1] [--right abb-irb1200-5-09:1]
//                             [--seed 11] [--count 160] [--simS 600] [--target 80] [--every 0.1] [--control rule|replay]
//                             [--out results/episodes/<이름>.rsim.json.gz]
//   --control replay: 대형 로봇을 정책 경로(20 Hz Δq, 규칙 재생 컨트롤러)로 움직인다 (정책 인터페이스 확인용)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/${m}`));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const { loadRapier } = await imp('tests/lib/rapier.mjs');
const TE = await imp('js/task-eval.js');
const CS = await imp('js/cell-sim.js');
const RP = await imp('js/replay.js');
const { robots } = JSON.parse(readFileSync(`${root}/js/robots.json`, 'utf8'));

const CONFIGS = {
  alone: { left: null, right: null },
  mode1: { left: 'ur-ur10e:1', right: 'abb-irb1200-5-09:1' },
  mode2: { left: 'ur-ur10e:2', right: 'ur-ur10e:2' },
};
const config = arg('config', 'mode1');
const sideOf = (v) => {
  if (!v || v === 'none') return { robotId: null, mode: 1 };
  const [robotId, mode] = v.split(':');
  return { robotId, mode: Number(mode) === 2 ? 2 : 1 };
};
const main = arg('main', 'kuka-kr210-r2700');
const left = sideOf(arg('left', CONFIGS[config]?.left));
const right = sideOf(arg('right', CONFIGS[config]?.right));
const seed = Number(arg('seed', 11));
const simS = Number(arg('simS', 600));
const control = arg('control', 'rule');
const { task, errors } = TE.sanitizeTask({
  targetRatePct: Number(arg('target', 80)), timeLimitS: simS,
  cell: { main, left, right }, dross: { seed, count: Number(arg('count', 160)) },
}, robots);
if (errors.length) {
  console.error('설정 오류: ' + errors.join(' / '));
  process.exit(1);
}
const short = (id) => (id ? id.split('-').slice(1, 2).join('') || id : 'none');
// 이름 규칙(results/README.md): <대형 제어>-<대형>-<구성>-s<시드>-<시간>s, 구성 = alone 또는 L-<왼쪽>-m<모드>_R-<오른쪽>-m<모드>
const sideTag = (s) => (s.robotId ? `${short(s.robotId)}-m${s.mode}` : 'none');
const cellTag = !left.robotId && !right.robotId ? 'alone' : `L-${sideTag(left)}_R-${sideTag(right)}`;
const out = `${root}/${arg('out', `results/episodes/${control}-${short(main)}-${cellTag}-s${seed}-${simS}s.rsim.json.gz`)}`;

const RAPIER = await loadRapier();
const record = new RP.EpisodeRecorder({ everyS: Number(arg('every', 0.1)) });
console.log(`실행: ${main} · 왼쪽 ${left.robotId ?? '없음'}${left.robotId ? ` 모드 ${left.mode}` : ''} · 오른쪽 ${right.robotId ?? '없음'}${right.robotId ? ` 모드 ${right.mode}` : ''} · 시드 ${seed} · ${simS} s · 대형 ${control}`);
const { summary, episode } = await CS.runEpisode(task, {
  RAPIER, robots, simS, record,
  controller: control === 'replay' ? new CS.RuleReplayController() : null,
});
const json = JSON.stringify(episode);
const gz = gzipSync(json);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, gz);
console.log(`회수율 ${summary.rateCount}% (질량 ${summary.rateMass}%), 목표 ${summary.targetRatePct}% ${summary.reached ? `도달 ${summary.reachS} s` : '미도달'}, 로봇별 ${JSON.stringify(summary.byRobot)}, 흘림 ${summary.spilled}, 배속 ${summary.speedup}×`);
console.log(`저장: ${out} (${(gz.length / 1e6).toFixed(2)} MB, 원본 ${(json.length / 1e6).toFixed(1)} MB, 프레임 ${episode.frames.length})`);
