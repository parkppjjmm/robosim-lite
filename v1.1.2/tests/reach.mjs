// 1단계: 12개 모델 FK 최대 도달거리 vs 카탈로그 (±5% 이내)
// 실행: node tests/reach.mjs  (Node 18+)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
// 프로젝트 루트: 인자로 주거나, 생략하면 이 파일의 상위 폴더
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const K = await import(pathToFileURL(root + '/js/kinematics.js'));
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));
const f = (v) => v.map((x) => x.toFixed(1)).join(', ');
const r0 = robots[0];
console.log('q=0 tcp', f(K.forwardKinematics(r0, [0,0,0,0,0,0]).tcp.pos), 'z6', f(K.axisZ(K.forwardKinematics(r0,[0,0,0,0,0,0]).frames[6])));
const h = K.forwardKinematics(r0, K.homeJoints(r0));
console.log('home tcp', f(h.tcp.pos), 'rpy', f(h.tcp.rpy), 'z6', f(K.axisZ(h.frames[6])));
console.log('J2=+30 tcp', f(K.forwardKinematics(r0,[0,30,0,0,90,0]).tcp.pos), ' J3=+30', f(K.forwardKinematics(r0,[0,0,30,0,90,0]).tcp.pos), ' J1=+30', f(K.forwardKinematics(r0,[30,0,0,0,90,0]).tcp.pos));
// RPY roundtrip check
const Rx=(a)=>[1,0,0,0,0,Math.cos(a),-Math.sin(a),0,0,Math.sin(a),Math.cos(a),0,0,0,0,1];
const Ry=(a)=>[Math.cos(a),0,Math.sin(a),0,0,1,0,0,-Math.sin(a),0,Math.cos(a),0,0,0,0,1];
const Rz=(a)=>[Math.cos(a),-Math.sin(a),0,0,Math.sin(a),Math.cos(a),0,0,0,0,1,0,0,0,0,1];
const D=Math.PI/180; const T=K.multiply(K.multiply(Rz(40*D),Ry(-25*D)),Rx(70*D));
console.log('rpy roundtrip (70,-25,40):', f(K.rotationToRPY(T)));
// Jacobian vs finite difference
let maxErr = 0;
for (const r of robots) {
  const q = [12, 23, -34, 45, 56, -67];
  const J = K.jacobian(r, q);
  const p0 = K.forwardKinematics(r, q).tcp.pos;
  for (let i = 0; i < 6; i++) {
    const q2 = q.slice(); q2[i] += 1e-4;
    const p1 = K.forwardKinematics(r, q2).tcp.pos;
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs((p1[k]-p0[k])/(1e-4*D) - J[k][i]));
  }
}
console.log('Jacobian linear part max FD error (mm/rad):', maxErr.toFixed(4));
console.log('\n| 모델 | 카탈로그(mm) | FK 최대(mm) | 오차 |');
let ok = true;
for (const r of robots) {
  const m = K.maxReach(r);
  const e = (m - r.reachMm) / r.reachMm * 100;
  if (Math.abs(e) > 5) ok = false;
  console.log(`| ${r.maker} ${r.name} | ${r.reachMm} | ${m.toFixed(0)} | ${e >= 0 ? '+' : ''}${e.toFixed(2)}% |`);
}
console.log(ok ? 'ALL WITHIN ±5%' : 'SOME OUT OF RANGE');
