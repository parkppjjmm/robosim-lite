// 실행 기록 폴더 (2026-11-06 사용자 요청: 결과를 덮어쓰지 않고 날짜·시각별로 남긴다)
//   results/<YYYY-MM-DD>/<HHMM>_<종류>_<이름>/   (한국 시각 = 이 PC 시각)
//   - run.json: 명령, 시각, git 커밋, Node 버전, 요약
//   - results/INDEX.md: 모든 실행을 시간순으로 한 줄씩 (도구가 끝날 때 자동 추가)
// 같은 분에 같은 이름이 있으면 -2, -3 … 을 붙인다(덮어쓰지 않음).
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pad = (n) => String(n).padStart(2, '0');

/** 로컬 시각 → { date: 'YYYY-MM-DD', hhmm: 'HHMM', iso } */
export function stamp(d = new Date()) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hhmm: `${pad(d.getHours())}${pad(d.getMinutes())}`, iso: d.toISOString(), local: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

const safe = (s) => String(s).replace(/[^0-9A-Za-z가-힣._-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * 새 실행 폴더를 만든다.
 * @param root v3.0.0 폴더
 * @param kind baseline | cem | ppo-train | ppo-eval | episode | …
 * @param name 조건 요약 (예: kr210-push-s11)
 * @param out 명령행 --out (주면 그 경로를 그대로 씀)
 * @returns { dir(절대), rel(root 기준), kind, name, t: stamp }
 */
export function makeRunDir(root, kind, name, out = null) {
  const t = stamp();
  let rel = out ?? `results/${t.date}/${t.hhmm}_${safe(kind)}_${safe(name)}`;
  if (!out) for (let k = 2; existsSync(`${root}/${rel}`); k++) rel = `results/${t.date}/${t.hhmm}_${safe(kind)}_${safe(name)}-${k}`;
  const dir = `${root}/${rel}`;
  mkdirSync(dir, { recursive: true });
  return { dir, rel, kind, name, t };
}

function gitHead(root) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() + (execSync('git status --porcelain -- .', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? ' (+수정)' : '');
  } catch {
    return null;
  }
}

/**
 * 실행이 끝나면 호출: run.json 저장 + results/INDEX.md에 한 줄 추가
 * @param run makeRunDir 결과
 * @param info { summary: 한 줄 요약(표에 표시), detail: run.json에 넣을 객체 }
 */
export function finishRun(root, run, { summary = '', detail = {} } = {}) {
  const end = stamp();
  const meta = {
    kind: run.kind, name: run.name, folder: run.rel, startedLocal: run.t.local, started: run.t.iso, finished: end.iso,
    command: `node ${process.argv.slice(1).map((a) => a.replace(/\\/g, '/').replace(`${root.replace(/\\/g, '/')}/`, '')).join(' ')}`,
    git: gitHead(root), node: process.version, summary, ...detail,
  };
  writeFileSync(`${run.dir}/run.json`, JSON.stringify(meta, null, 1));
  const idx = `${root}/results/INDEX.md`;
  if (!existsSync(idx)) {
    writeFileSync(idx, '# 실행 기록 (시간순, 도구가 자동 추가)\n\n폴더 규칙은 `README.md`. 시각은 이 PC 시각(한국).\n\n| 날짜 | 시각 | 종류 | 폴더 | 요약 |\n|---|---|---|---|---|\n');
  }
  const s = readFileSync(idx, 'utf8');
  const line = `| ${run.t.date} | ${run.t.hhmm.slice(0, 2)}:${run.t.hhmm.slice(2)} | ${run.kind} | \`${run.rel.replace(/^results\//, '')}\` | ${String(summary).replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`;
  appendFileSync(idx, (s.endsWith('\n') ? '' : '\n') + line);
  return meta;
}
