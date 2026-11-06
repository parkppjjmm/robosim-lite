// results/index.json 다시 만들기 — 앱 '에피소드 재생'의 "실행 결과 목록"이 읽는 파일 (v3.0.0, 2026-11-06)
// 도구(baseline·train·cem-demos·ppo-train·ppo-eval·episode·pipeline)가 끝날 때 자동으로 갱신된다(tools/lib/run-dir.mjs finishRun).
// 손으로 다시 만들 때: node tools/results-index.mjs
import { fileURLToPath } from 'node:url';
import { writeResultsIndex } from './lib/run-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const list = writeResultsIndex(root);
console.log(`results/index.json: 실행 ${list.length}개, 3D 재생 파일 ${list.reduce((s, r) => s + r.replays.length, 0)}개`);
