// v3.0.0 학습 파이프라인 (2026-11-06 사용자 요청): 진화 탐색 시범 → PPO 학습 → 평가 → 비교 보고서를 명령 하나로.
// 진화 탐색(CEM) 시범이 이미 있으면 --demos로 주고, 없으면 --alone 시드로 먼저 모은다.
//
//   ① 시범:   node tools/cem-demos.mjs --alone <시드> --push none          (--demos 를 주면 건너뜀)
//   ② 학습:   node tools/ppo-train.mjs --demos <demos.json> …              (모방 → PPO → 최고 체크포인트 → 학습 직후 평가)
//   ③ 비교:   평가 시드(기본 11·12·13)에서 진화 탐색도 돌려 규칙 경로 · 진화 탐색 · PPO를 같은 시드로 비교 (--no-cem-eval 로 건너뜀)
//   ④ 보고서: results/<날짜>/<시각>_pipeline_<이름>/report.md · run.json, results/INDEX.md
//
// 실행 예:
//   node tools/pipeline.mjs --demos results/2026-11-06/<시각>_cem-demos_kr210-alone10/demos.json --name run2
//   node tools/pipeline.mjs --alone 101-120 --name run3                    (시범 수집부터)
// 옵션: --iterations 40(PPO 반복) --bc 3(모방 반복) --workers 14 --rule-lane-dir alternate(비교 규칙 경로, 기본 번갈아)
//       --episodes 14(반복당 에피소드, 기본 = 작업자 수 — 작업자를 줄여도 학습 조건 유지) --eval-seeds 11,12,13 --population 32 --cem-iterations 4 (진화 탐색 예산) --demo-filter better|all --no-cem-eval
//       --no-git: 단계마다 하는 git 커밋·push를 끈다 (기본: 켬 — 2026-11-06 사용자 요청 "각 단계별로 중간마다 커밋 및 push")
//         커밋 = 그 단계의 결과 폴더 + results/INDEX.md만, 메시지 앞에 [날짜 시각 KST]. push 전에 fetch, 충돌 시 rebase(강제 push 없음).
// 측면 로봇 셀은 아직 다루지 않는다(2026-11-06 사용자 결정: 대형 단독 먼저).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRunDir, finishRun } from './lib/run-dir.mjs';
import { progressLine } from './lib/progress.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const NAME = arg('name', 'run');
const WORKERS = arg('workers', '14');
const RULE_DIR = arg('rule-lane-dir', 'alternate');
const EVAL_SEEDS = arg('eval-seeds', '11,12,13').split(',').map(Number);
const run = makeRunDir(root, 'pipeline', `kr210-${NAME}`);
const t0 = Date.now();
const min = () => ((Date.now() - t0) / 60000).toFixed(0);
console.log(`[파이프라인] ${run.rel} — 시작 ${run.t.local}`);

// 전체 진행률 막대 (2026-11-06 사용자 요청): 하위 도구 실행 수 기준 — ① 시범(있으면) + ② PPO + ③ 평가 시드마다 진화 탐색
const TOTAL_STEPS = (arg('demos') ? 0 : 1) + 1 + (has('no-cem-eval') ? 0 : EVAL_SEEDS.length);
let stepsDone = 0;

/** 하위 도구 실행: 중요한 줄만 앞에 [단계]를 붙여 보여 주고, 전체 출력은 반환 */
function step(tag, script, args, show = /진행|✔|모방|PPO\s+\d+\/|평가|저장:|시드 \d+:|오류|Error/) {
  return new Promise((resolve, reject) => {
    console.log(`\n전체 ${progressLine(stepsDone / TOTAL_STEPS, t0)} — 단계 ${stepsDone + 1}/${TOTAL_STEPS}`);
    console.log(`[${tag}] node ${script} ${args.join(' ')}`);
    const p = spawn(process.execPath, [`${root}/${script}`, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    p.stdout.on('data', (d) => {
      const s = String(d);
      out += s;
      buf += s;
      const parts = buf.split(/\r|\n/);
      buf = parts.pop();
      for (const line of parts) if (line.trim() && show.test(line)) console.log(`  [${tag} · ${min()}분] ${line.trim()}`);
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? (stepsDone++, resolve(out)) : reject(new Error(`${tag} 실패 (코드 ${code}): ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}
const savedPath = (out, re) => {
  const m = out.match(re);
  if (!m) throw new Error('결과 경로를 찾지 못함');
  return m[1].trim().replace(/\\/g, '/');
};
// ---- 단계별 git 커밋·push ----
const GIT = !has('no-git');
const repo = `${root}/..`;
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitStep(title, paths) {
  if (!GIT) return;
  try {
    const rels = [...new Set([...paths, `${root}/results/INDEX.md`])].map((p) => `v3.0.0/${p.replace(/\\/g, '/').replace(`${root.replace(/\\/g, '/')}/`, '')}`);
    git('add', '--', ...rels);
    if (!git('diff', '--cached', '--name-only')) return console.log(`  [git] ${title}: 바뀐 파일 없음`);
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const stampKst = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
    const msg = `[${stampKst} KST] v3.0.0 파이프라인 ${NAME}: ${title}\n\n${rels.map((r) => `- ${r}`).join('\n')}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    git('commit', '-q', '-m', msg);
    git('fetch', '-q', 'origin');
    try { git('push', '-q', 'origin', 'HEAD:main'); } catch {
      git('pull', '--rebase', '-q', 'origin', 'main');
      git('push', '-q', 'origin', 'HEAD:main');
    }
    console.log(`  [git] ${title} → 커밋 ${git('rev-parse', '--short', 'HEAD')} push 완료`);
  } catch (e) {
    console.log(`  [git] ${title}: 커밋·push 실패 — ${String(e.stderr ?? e.message).trim().split('\n').slice(-2).join(' ')} (학습은 계속)`);
  }
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f1 = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');

// ① 시범
let demos = arg('demos');
if (!demos) {
  const out = await step('① 시범 수집', 'tools/cem-demos.mjs', ['--alone', arg('alone', '101-110'), '--push', 'none', '--population', arg('population', '32'), '--iterations', arg('cem-iterations', '4'), '--workers', WORKERS, '--name', NAME]);
  demos = savedPath(out, /저장: (.+demos\.json)/);
  const demoDirs = [...out.matchAll(/결과 폴더 \| `([^`]+)`/g)].map((m) => m[1]);
  commitStep(`① 진화 탐색 시범 수집 완료`, [demos.replace(/\/demos\.json$/, ''), ...[...out.matchAll(/\| `(results\/[^`]+_cem_[^`]+)` \|/g)].map((m) => m[1]), ...demoDirs]);
}
const demosAbs = demos.match(/^([A-Za-z]:|\/)/) ? demos : `${root}/${demos}`;
const dm = JSON.parse(readFileSync(demosAbs, 'utf8'));
console.log(`\n시범: ${demos} — ${dm.count ?? dm.demos.length}개`);

// ② PPO 학습 (+ 학습 직후 평가 시드에서 PPO vs 규칙)
const trainArgs = ['--demos', demosAbs, '--name', NAME, '--iterations', arg('iterations', '40'), '--bc', arg('bc', '3'), '--workers', WORKERS,
  '--eval-seeds', EVAL_SEEDS.join(','), '--rule-lane-dir', RULE_DIR, '--demo-filter', arg('demo-filter', 'better'),
  // 반복당 에피소드 수 (기본 = 작업자 수). 작업자를 줄여도 --episodes 14로 학습 조건을 그대로 둔다 (2026-11-07, 8코어 PC)
  ...(arg('episodes') ? ['--episodes', arg('episodes')] : [])];
const trainOut = await step('② PPO 학습', 'tools/ppo-train.mjs', trainArgs);
const trainDir = savedPath(trainOut, /저장: (.+?)\/ — 전체/);
const evalMd = readFileSync(`${trainDir}/cell-eval-alone.md`, 'utf8');
const ppoRows = [...evalMd.matchAll(/^\| (\d+) \| \*\*([\d.]+)%\*\* \| ([\d.]+)% \|/gm)].map((m) => ({ seed: +m[1], ppo: +m[2], rule: +m[3] }));
const best = JSON.parse(readFileSync(`${trainDir}/policy-best.json`, 'utf8'));
commitStep(`② PPO 학습·평가 완료 (PPO ${mean(ppoRows.map((r) => r.ppo)).toFixed(1)}% vs 규칙 ${mean(ppoRows.map((r) => r.rule)).toFixed(1)}%)`, [trainDir]);

// ③ 같은 평가 시드에서 진화 탐색
const cemRows = [];
if (!has('no-cem-eval')) {
  for (const seed of EVAL_SEEDS) {
    const out = await step(`③ 진화 탐색 시드 ${seed}`, 'tools/train.mjs', ['--config', 'alone', '--seed', String(seed), '--population', arg('population', '32'), '--iterations', arg('cem-iterations', '4'), '--workers', WORKERS, '--lane-dir', RULE_DIR, '--no-stop'],
      /저장:|오류|Error/);
    const dir = savedPath(out, /저장: (.+?)\/ \(/);
    const rep = readFileSync(`${dir}/report.md`, 'utf8');
    const m = rep.match(/회수율 \(개수 \/ 질량\) \| \*\*([\d.]+)%\*\* \/ [\d.]+% \| \*\*([\d.]+)%\*\*/);
    cemRows.push({ seed, cem: m ? +m[1] : NaN, rule: m ? +m[2] : NaN, dir: dir.replace(`${root.replace(/\\/g, '/')}/`, '') });
  }
  commitStep(`③ 평가 시드 진화 탐색 완료 (${mean(cemRows.map((r) => r.cem)).toFixed(1)}%)`, cemRows.map((r) => r.dir));
}

// ④ 보고서
const rel = (p) => p.replace(/\\/g, '/').replace(`${root.replace(/\\/g, '/')}/`, '');
const L = [];
L.push(`# 학습 파이프라인 결과 — ${run.t.local} (${NAME})`, '');
L.push(`- 명령: \`node ${process.argv.slice(2).length ? `tools/pipeline.mjs ${process.argv.slice(2).join(' ')}` : 'tools/pipeline.mjs'}\` · 소요 ${min()}분`);
L.push(`- 교사(진화 탐색 시범): \`${rel(demosAbs)}\` (${dm.count ?? dm.demos.length}개)`);
L.push(`- PPO 학습: \`${rel(trainDir)}\` — 최고 체크포인트 ${best.phase === 'bc' ? '모방 직후' : `PPO 반복 ${best.iter}`}, 학습 평가 ${best.eval?.rate?.toFixed(1) ?? '—'}%`);
L.push(`- 정책 파일: \`${rel(trainDir)}/policy-best.json\` (앱 학습 패널 [정책 불러오기 (PPO)])`);
L.push(`- 비교 규칙 경로: 쓸기 방향 \`${RULE_DIR}\`. 평가 시드 ${EVAL_SEEDS.join('·')} (학습·시범에 쓰지 않은 배치)`, '');
L.push('## 같은 시드 비교 — KR 210 단독, 10분', '', '| 시드 | 규칙 경로 | 진화 탐색 (교사, 현장 불가) | PPO 정책 (현장용) |', '|---|---|---|---|');
for (const seed of EVAL_SEEDS) {
  const p = ppoRows.find((r) => r.seed === seed), c = cemRows.find((r) => r.seed === seed);
  L.push(`| ${seed} | ${f1(p?.rule)} | ${f1(c?.cem)} | **${f1(p?.ppo)}** |`);
}
L.push(`| 평균 | ${f1(mean(ppoRows.map((r) => r.rule)))} | ${f1(mean(cemRows.map((r) => r.cem)))} | **${f1(mean(ppoRows.map((r) => r.ppo)))}** |`, '');
L.push('- 진화 탐색 행이 비어 있으면 --no-cem-eval로 건너뛴 것이다.');
L.push(`- 3D 재생: PPO·규칙 = \`${rel(trainDir)}/ppo-alone-s<시드>.rsim.json.gz\`·\`rule-alone-s<시드>…\`${cemRows.length ? `, 진화 탐색 = ${cemRows.map((r) => `\`${r.dir}\``).join(', ')}` : ''}`);
writeFileSync(`${run.dir}/report.md`, L.join('\n') + '\n');
finishRun(root, run, {
  summary: `PPO ${f1(mean(ppoRows.map((r) => r.ppo)))} · 진화 탐색 ${f1(mean(cemRows.map((r) => r.cem)))} · 규칙(${RULE_DIR}) ${f1(mean(ppoRows.map((r) => r.rule)))} (시드 ${EVAL_SEEDS.join('·')}, 교사 시범 ${dm.count ?? dm.demos.length}개)`,
  detail: { demos: rel(demosAbs), train: rel(trainDir), cem: cemRows, ppo: ppoRows },
});
commitStep('④ 비교 보고서', [run.dir]);
console.log(`\n전체 ${progressLine(1, t0)} — 완료`);
console.log('\n' + L.join('\n'));
console.log(`\n저장: ${run.rel}/report.md`);
