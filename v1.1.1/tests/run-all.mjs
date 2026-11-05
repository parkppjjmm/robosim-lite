// 검증 스크립트 일괄 실행. 새 환경(다른 노트북)에서 코드가 정상 동작하는지 빠르게 확인할 때 사용한다.
// 실행: node tests/run-all.mjs          (기본 9종, 약 1분)
//       node tests/run-all.mjs --full   (스트레스·수치 검증·측면 로봇 동시 실행 포함, 수 분)
// 브라우저 화면 확인은 start.bat(또는 python serve.py)으로 앱을 열어 README의 시연 예제를 따라 한다.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const quick = ['reach.mjs', 'safety.mjs', 'ik-trajectory.mjs', 'planner.mjs', 'physics.mjs', 'gripper.mjs', 'pick-place.mjs', 'minor-fixes.mjs', 'dross.mjs'];
const full = [...quick, 'planner-stress.mjs', 'numeric-review.mjs', 'cell-robots.mjs']; // cell-robots: 측면 로봇 동시 실행 재현(수 분)
const list = process.argv.includes('--full') ? full : quick;

let failed = 0;
for (const name of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [here + name], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`\n=== ${name} — ${ok ? 'OK' : `실패 (exit ${r.status})`} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log((r.stdout || '').trim().split('\n').slice(-8).join('\n'));
  if (!ok) console.log(r.stderr);
}
console.log(`\n${failed ? `실패 ${failed}건` : '모두 정상 실행'} (${list.length}개 스크립트)`);
process.exit(failed ? 1 : 0);
