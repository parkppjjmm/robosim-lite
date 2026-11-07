// v3.0.0 학습 실행 도구 (2026-11-06 사용자 요청 (b): Claude 없이 혼자 학습·평가·결과 보기)
// 실행: train.bat 더블클릭 (또는 v3.0.0 폴더에서 node tools/launcher.mjs)
// 메뉴에서 고르고 질문에 답하면(Enter = 기본값) 기존 도구(pipeline·cem-demos·ppo-train·ppo-eval·baseline)를 호출한다.
// 결과는 results/<날짜>/<시각>_…/ 에 쌓이고 results/INDEX.md·index.json이 갱신된다 → 앱 '에피소드 재생 → 실행 결과 목록'에서 3D로 본다.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
// 입력을 한 줄씩 차례로 읽는다 (직접 입력·미리 넣은 입력 모두 동작)
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
let inputClosed = false;
const ask = async (q, def = '') => {
  process.stdout.write(`${q}${def !== '' ? ` [${def}]` : ''}: `);
  const r = inputClosed ? { done: true } : await lines.next();
  if (r.done) {
    inputClosed = true;
    process.stdout.write('\n');
    return q.startsWith('번호를 고르세요') ? '0' : String(def);
  }
  const a = r.value.trim();
  return a === '' ? String(def) : a;
};
const yes = async (q, def = true) => /^(y|yes|예|네|ㅇ)$/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
const line = () => console.log('─'.repeat(72));
const WORKERS = Math.max(1, cpus().length - 2);

/** results/ 아래 실행 폴더 (최신 먼저) */
function runDirs() {
  const base = `${root}/results`;
  const out = [];
  for (const day of readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    for (const dir of readdirSync(`${base}/${day}`)) {
      const full = `${base}/${day}/${dir}`;
      if (statSync(full).isDirectory() && /^\d{4}_/.test(dir)) out.push({ rel: `results/${day}/${dir}`, full, key: `${day} ${dir}` });
    }
  }
  return out.sort((a, b) => b.key.localeCompare(a.key));
}
const pick = async (title, items, label, def = 1) => {
  if (!items.length) return null;
  console.log(title);
  items.forEach((it, i) => console.log(`  ${i + 1}) ${label(it)}`));
  const n = Number(await ask('번호', def));
  return items[Math.min(items.length, Math.max(1, n)) - 1];
};
/** 현재 채택 모델 경로 (results/adopted.json의 ppo2, v3.0.0 기준 상대 경로). 없으면 null */
const readAdopted = () => {
  try { return JSON.parse(readFileSync(`${root}/results/adopted.json`, 'utf8')).ppo2?.policy ?? null; } catch { return null; }
};
/** policy-last.json처럼 평가 기록이 없는 파일은 같은 반복의 체크포인트(checkpoints/iter-NNN.json) 평가를 쓴다 */
const checkpointRate = (dir, iter) => {
  try { return JSON.parse(readFileSync(`${dir}/checkpoints/iter-${String(iter).padStart(3, '0')}.json`, 'utf8')).eval?.rate ?? null; } catch { return null; }
};
const nextRunName = () => {
  let n = 2;
  for (const d of runDirs()) {
    const m = d.rel.match(/_ppo-train_kr210-run(\d+)/);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `run${n}`;
};
const run = (script, args) => new Promise((resolve) => {
  line();
  console.log(`실행: node ${script} ${args.join(' ')}`);
  line();
  const p = spawn(process.execPath, [`${root}/${script}`, ...args], { cwd: root, stdio: 'inherit' });
  p.on('close', (code) => resolve(code));
});
const seedRange = (s) => s.replace(/\s/g, '');
const countSeeds = (s) => s.split(',').reduce((n, p) => { const [a, b] = p.split('-').map(Number); return n + (b ? b - a + 1 : 1); }, 0);
const minutes = (m) => (m >= 60 ? `약 ${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분` : `약 ${Math.round(m)}분`);
const scale = 14 / WORKERS; // 시간 추정은 개발 PC(Worker 14) 기준

function finish(kind) {
  const latest = runDirs().slice(0, 6);
  line();
  console.log('끝났습니다. 최근 실행 폴더:');
  for (const d of latest) console.log(`  ${d.rel}`);
  console.log('');
  console.log('결과 보기');
  console.log(' - 보고서: 위 폴더의 report.md / train-report.md / cell-eval-*.md (메모장·VS Code로 열기)');
  console.log(' - 3D 재생: start.bat → 브라우저 → 오른쪽 "에피소드 재생" → "실행 결과 목록에서 열기" → 실행·파일 선택 → ▶ 열기');
  if (kind === 'ppo') console.log(' - 정책 실행: 앱 "학습 (Trial & Error)" → 정책 불러오기 (PPO) → 새 ppo-train 폴더의 policy-best.json(또는 policy-last.json — 실제 셀 평가로 고르기, 메뉴 3) → ▶ 학습 시작');
  console.log(' - 모든 실행 기록: results/INDEX.md');
}

async function menu() {
  console.log('');
  line();
  console.log(' RoboSim Lite v3.0.0 — 학습 실행 도구 (대형 로봇 KR 210 단독 셀)');
  line();
  console.log(` 이 PC: CPU 작업자 ${WORKERS}개 (시간은 개발 PC 기준을 이 PC에 맞춰 대략 계산)`);
  console.log(' 1) 전체 학습: 진화 탐색 시범 수집 → PPO 학습 → 평가 → 비교 보고서');
  console.log(' 2) PPO 학습만: 이미 모은 시범으로 PPO 학습 → 평가 → 비교 보고서');
  console.log(' 3) 모델 평가만: 학습된 PPO 모델을 10분 과제로 평가 (규칙 경로와 같은 시드 비교)');
  console.log(' 4) 규칙 경로 기준선 측정 (학습 없음)');
  console.log(' 5) 최근 실행 결과 목록 보기');
  console.log(' 0) 끝내기');
  return ask('번호를 고르세요', 0);
}

async function pipelineArgs(withSeeds) {
  const args = [];
  if (withSeeds) {
    console.log('\n[1] 진화 탐색 시범 수집 — 드로스 배치(시드)마다 10분 과제를 진화 탐색으로 풀고 결정마다 기록합니다.');
    console.log('    평가 시드(11·12·13)와 겹치지 않게 고르세요. 이미 쓴 시범 시드: 101~110');
    const seeds = seedRange(await ask('    시범 시드 범위 (예: 111-120)', '111-120'));
    args.push('--alone', seeds);
    args.est = countSeeds(seeds) * 7 * scale;
  } else {
    const demos = runDirs().filter((d) => existsSync(`${d.full}/demos.json`) && /_cem-demos_/.test(d.rel));
    const d = await pick('\n[1] 시범 모음 고르기', demos, (x) => {
      const j = JSON.parse(readFileSync(`${x.full}/demos.json`, 'utf8'));
      return `${x.rel} — 시범 ${j.count ?? j.demos.length}개`;
    });
    if (!d) {
      console.log('시범 모음이 없습니다. 메뉴 1(전체 학습)을 쓰세요.');
      return null;
    }
    args.push('--demos', `${d.rel}/demos.json`);
    args.est = 0;
  }
  console.log('\n[2] PPO 학습 — 반복 1회 = 연습 경기 여러 개 → 신경망 수정. 5회마다 시험해 가장 좋은 모델을 남깁니다.');
  const it = Number(await ask('    PPO 반복 횟수 (채택 2차 모델은 40회 학습의 40회째)', 10));
  const workers = Number(await ask('    CPU 작업자 수', WORKERS));
  const name = await ask('    학습 이름 (결과 폴더 이름에 들어감)', nextRunName());
  const cemEval = await yes('\n[3] 평가 시드에서 진화 탐색도 돌려 3가지(규칙·진화 탐색·PPO)를 비교할까요? (약 20분 추가)', true);
  const git = await yes('[4] 단계마다 git 커밋·push 할까요? (GitHub 로그인 필요, 실패해도 학습은 계속)', true);
  args.push('--iterations', String(it), '--workers', String(workers), '--name', name, '--rule-lane-dir', 'alternate');
  if (!cemEval) args.push('--no-cem-eval');
  if (!git) args.push('--no-git');
  // PPO 반복 1회는 연습 경기 수 = 작업자 수라 작업자 수와 거의 무관(약 2~3분). 진화 탐색은 작업자 수에 반비례
  args.est += 2 + it * 2.7 + 5 + (cemEval ? 20 * (14 / workers) : 0);
  return args;
}

async function main() {
  for (;;) {
    const c = await menu();
    if (c === '0') break;
    if (c === '1' || c === '2') {
      const args = await pipelineArgs(c === '1');
      if (!args) continue;
      console.log(`\n예상 시간: ${minutes(args.est)} (PC 성능에 따라 다름). 실행 중에는 이 창을 닫지 마세요.`);
      if (!(await yes('시작할까요?', true))) continue;
      const est = args.est;
      delete args.est;
      const code = await run('tools/pipeline.mjs', args);
      if (code !== 0) console.log(`\n도구가 오류로 끝났습니다 (코드 ${code}). 위 메시지를 확인하세요. 예상 ${minutes(est)}`);
      finish('ppo');
    } else if (c === '3') {
      // 모델 = ppo-train 폴더의 policy-best.json(학습 도구가 연습장 시험으로 고른 것)과 policy-last.json(마지막 반복) 둘 다
      // (2026-11-07 사용자 요청: 채택 2차 모델이 run3의 policy-last.json = 40회째라 메뉴에서도 고를 수 있게)
      const adopted = readAdopted();
      const pols = runDirs().flatMap((d) => ['policy-best.json', 'policy-last.json'].filter((f) => existsSync(`${d.full}/${f}`)).map((f) => ({ ...d, file: f, path: `${d.rel}/${f}` })));
      const def = Math.max(0, pols.findIndex((x) => x.path === adopted)) + 1;
      const p = await pick('\n학습된 모델 고르기 (★ = 현재 채택 모델, results/adopted.json)', pols, (x) => {
        const j = JSON.parse(readFileSync(`${x.full}/${x.file}`, 'utf8'));
        const rate = j.eval?.rate ?? checkpointRate(x.full, j.iter);
        const kind = x.file === 'policy-best.json' ? '연습장 최고' : '마지막 반복';
        return `${x.path === adopted ? '★ ' : ''}${x.path} — ${kind}, ${j.phase === 'bc' ? '모방 직후' : `PPO ${j.iter}회째`}, 학습 평가 ${rate != null ? rate.toFixed(1) : '—'}%${existsSync(`${x.full}/NOTE.md`) ? ' (NOTE.md 참고)' : ''}`;
      }, def);
      if (!p) { console.log('모델이 없습니다.'); continue; }
      const seeds = seedRange(await ask('평가 시드 (쉼표로)', '11,12,13'));
      const ld = await ask('비교할 규칙 경로 쓸기 방향 (robot = 기존 / alternate = 번갈아)', 'alternate');
      console.log(`\n예상 시간: ${minutes(seeds.split(',').length * 2 * scale)}`);
      await run('tools/ppo-eval.mjs', ['--policy', p.path, '--config', 'alone', '--seeds', seeds, '--rule-lane-dir', ld]);
      finish('eval');
    } else if (c === '4') {
      const dirs = await ask('쓸기 방향 (쉼표로: robot,snout,alternate)', 'robot,alternate');
      const seeds = seedRange(await ask('시드 (쉼표로)', '11,12,13'));
      await run('tools/baseline.mjs', ['--mains', 'kuka-kr210-r2700', '--configs', 'alone', '--lane-dir', dirs, '--seeds', seeds, '--workers', String(Math.min(WORKERS, 9))]);
      finish('baseline');
    } else if (c === '5') {
      line();
      const idx = existsSync(`${root}/results/INDEX.md`) ? readFileSync(`${root}/results/INDEX.md`, 'utf8').split('\n').filter((l) => /^\| \d{4}-/.test(l)) : [];
      idx.sort((x, y) => y.slice(2, 22).localeCompare(x.slice(2, 22)));
      for (const l of idx.slice(0, 10)) console.log(l.replace(/^\| /, '').replace(/ \|$/, '').replace(/ \| /g, '  ·  ').slice(0, 200));
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
});
