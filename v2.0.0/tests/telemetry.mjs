// v1.1.2: 관절 계측(각도·속도·토크·추정 전류)과 기록·엑셀 작성 검증
// 실행: node tests/telemetry.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const imp = (m) => import(pathToFileURL(`${root}/js/${m}`));
const K = await imp('kinematics.js');
const T = await imp('telemetry.js');
const X = await imp('xlsx.js');
const G = await imp('gripper.js');
const { robots } = JSON.parse(readFileSync(root + '/js/robots.json', 'utf8'));

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};
const DT = 1 / 60;

// 1. 정적 중력 토크 = 위치 에너지의 관절 미분 (dV/dq) — 부호·크기 검증 (전 모델)
{
  let worst = 0, worstName = '';
  for (const robot of robots) {
    const tel = new T.JointTelemetry(robot, null, { noise: false });
    const V = (q) => {
      const { frames } = K.forwardKinematics(robot, q);
      const segs = K.linkSegments(robot, frames);
      let v = 0;
      segs.forEach((s, k) => { v += tel.segMass[k] * T.G * ((s.a[2] + s.b[2]) / 2000); });
      return v;
    };
    const q = [10, 25, -30, 40, 50, -20];
    const { frames } = K.forwardKinematics(robot, q);
    const tau = tel.statics(frames, 0, [0, 0, 0]).tau;
    for (let i = 0; i < 6; i++) {
      const h = 1e-4;
      const qp = q.slice(), qm = q.slice();
      qp[i] += h; qm[i] -= h;
      const dV = (V(qp) - V(qm)) / (2 * h * K.DEG); // N·m (J/rad)
      const err = Math.abs(dV - tau[i]) / Math.max(1, Math.abs(dV));
      if (err > worst) { worst = err; worstName = `${robot.name} J${i + 1} (${tau[i].toFixed(2)} vs ${dV.toFixed(2)})`; }
    }
  }
  check('중력 토크 = dV/dq (전 15모델 × 6축, 상대 오차 < 1e-3)', worst < 1e-3, `최대 ${worst.toExponential(1)} ${worstName}`);
}

// 2. 정격·질량 근사가 크기 순서를 따른다
{
  const by = (id) => robots.find((r) => r.id === id);
  const m = ['abb-irb1200-5-09', 'ur-ur10e', 'kuka-kr210-r2700'].map((id) => new T.JointTelemetry(by(id)).massKg);
  check('링크 질량 근사: 소형 < 협동 중형 < 대형', m[0] < m[1] && m[1] < m[2], m.map((v) => `${v.toFixed(0)} kg`).join(' / '));
  const allPos = robots.every((r) => new T.JointTelemetry(r).ratedTau.every((t) => t >= 1));
  check('정격토크 6축 모두 ≥ 1 N·m (전 모델)', allPos);
}

// 3. 홈 자세 정지: 속도 0, 전류는 정격 안
{
  const robot = robots.find((r) => r.id === 'kuka-kr210-r2700');
  const tel = new T.JointTelemetry(robot, G.SKIMMER_SPEC, { noise: false });
  const q = K.homeJoints(robot);
  const { frames } = K.forwardKinematics(robot, q);
  tel.update(q, frames, DT);
  const o = tel.update(q, frames, DT);
  check('정지 자세: 속도 0, 전류 < 정격', o.qd.every((v) => v === 0) && o.currentPct.every((p) => p < 100), `전류 % ${o.currentPct.map((p) => p.toFixed(0)).join(', ')}`);
  check('홈 자세에서 J2·J3에 중력 부하가 있다', Math.abs(o.tau[1]) > 1 && Math.abs(o.tau[2]) > 1, `τ2 ${o.tau[1].toFixed(0)} · τ3 ${o.tau[2].toFixed(0)} N·m`);
}

// 4. 가속 → 관성 토크, 회전 방향 → 마찰 부호
{
  const robot = robots.find((r) => r.id === 'ur-ur10e');
  const tel = new T.JointTelemetry(robot, null, { noise: false });
  let q = [0, 30, -30, 0, 60, 0];
  const run = (qdDeg, n) => {
    let o;
    for (let k = 0; k < n; k++) {
      q = q.slice(); q[0] += qdDeg(k) * DT;
      o = tel.update(q, K.forwardKinematics(robot, q).frames, DT);
    }
    return o;
  };
  run(() => 0, 2);
  const acc = run((k) => (k + 1) * 3, 20); // J1 가속
  const cruise = run(() => 60, 60); // 60°/s 등속
  check('J1 가속 중 토크 > 등속 토크 > 0 (관성 + 마찰)', acc.tau[0] > cruise.tau[0] && cruise.tau[0] > 0, `가속 ${acc.tau[0].toFixed(2)} · 등속 ${cruise.tau[0].toFixed(2)} N·m, 속도 ${cruise.qd[0].toFixed(1)}°/s`);
}

// 5. 부하가 늘면 J2·J3 전류 증가, 욕 저항은 이동 방향 반대
{
  const robot = robots.find((r) => r.id === 'kuka-kr210-r2700');
  const q = [0, 40, -10, 0, 60, 0];
  const { frames } = K.forwardKinematics(robot, q);
  const tel = new T.JointTelemetry(robot, G.SKIMMER_SPEC, { noise: false });
  const a = tel.update(q, frames, DT, { extraKg: 0 });
  tel.reset();
  const b = tel.update(q, frames, DT, { extraKg: 20 });
  check('툴 끝 부하 20 kg → J2·J3 |전류| 증가', Math.abs(b.current[1]) > Math.abs(a.current[1]) && Math.abs(b.current[2]) > Math.abs(a.current[2]),
    `J2 ${a.current[1].toFixed(2)} → ${b.current[1].toFixed(2)} A, J3 ${a.current[2].toFixed(2)} → ${b.current[2].toFixed(2)} A`);
  // 욕 저항: TCP를 −X로 움직이며 잠김 1 vs 0 → J1 토크 차이가 생김
  const step = (imm) => {
    const t = new T.JointTelemetry(robot, G.SKIMMER_SPEC, { noise: false });
    let qq = [10, 40, -10, 0, 60, 0], o;
    for (let k = 0; k < 10; k++) { qq = qq.slice(); qq[1] -= 0.2; o = t.update(qq, K.forwardKinematics(robot, qq).frames, DT, { immersed: imm }); }
    return o;
  };
  const dry = step(0), wet = step(1);
  const diff = wet.tau.map((v, i) => v - dry.tau[i]);
  check('잠긴 툴이 움직이면 욕 저항 토크가 더해진다', Math.max(...diff.map(Math.abs)) > 1, diff.map((v) => v.toFixed(1)).join(', '));
}

// 6. 기록기: 20 Hz 샘플, 단계 이벤트, 사이클 요약
{
  const robot = robots.find((r) => r.id === 'kuka-kr210-r2700');
  const tel = new T.JointTelemetry(robot, G.SKIMMER_SPEC, { noise: false });
  const log = new T.TelemetryLog({ hz: 20 });
  log.start(0);
  let simT = 0, q = K.homeJoints(robot);
  for (let k = 0; k < 600; k++) { // 10 s
    simT += DT;
    q = q.slice(); q[0] += 0.2;
    const o = tel.update(q, K.forwardKinematics(robot, q).frames, DT);
    if (log.due(simT)) {
      const phase = simT < 4 ? '스윕' : '스쿱 상승';
      log.push(simT, { robot: 'main', model: robot.name, activity: 'skim', phase, cycle: simT < 7 ? 1 : 2, lane: 3, alarm: false, tel: o, tool: 'skimmer', loadKg: 9, collectedOwn: simT < 7 ? 0 : 5, collectedTotal: 5 });
    }
  }
  log.stop(simT);
  const sheets = log.sheets([['robot', robot.name]]);
  const data = sheets.find((s) => s.name === 'data').rows;
  check('20 Hz × 10 s ≈ 200행, 열 수 = 헤더', Math.abs(data.length - 1 - 200) <= 2 && data.every((r) => r.length === T.DATA_COLUMNS.length), `${data.length - 1}행, ${T.DATA_COLUMNS.length}열`);
  const cycles = sheets.find((s) => s.name === 'cycles').rows;
  check('사이클 요약: 1번 완료 + 2번 진행 중', cycles.length === 3 && cycles[1][cycles[0].indexOf('result')] === 'done' && cycles[2][cycles[0].indexOf('result')] === 'in-progress', cycles.slice(1).map((r) => `#${r[2]} ${r[6]} s ${r.at(-1)}`).join(' / '));
  const ev = sheets.find((s) => s.name === 'events').rows;
  check('이벤트: 기록 시작·정지 + 단계 변화', ev.some((r) => r[3] === '기록 시작') && ev.some((r) => r[3] === '기록 정지') && ev.filter((r) => r[3] === '단계').length >= 2, `${ev.length - 1}건`);

  // 7. XLSX: ZIP 구조·CRC·시트 XML 확인 (다시 읽기)
  const bytes = X.buildXlsx(sheets);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const n = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  let p = cdOff, okCrc = true;
  const names = [];
  const dec = new TextDecoder();
  const texts = {};
  for (let i = 0; i < n; i++) {
    const nameLen = dv.getUint16(p + 28, true), crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true), lh = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lnl = dv.getUint16(lh + 26, true);
    const data = bytes.subarray(lh + 30 + lnl, lh + 30 + lnl + size);
    if (X.crc32(data) !== crc) okCrc = false;
    names.push(name);
    texts[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  check('XLSX: 파일 구성 (Content_Types, workbook, 시트 5개, styles)', names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml') && names.filter((s) => s.startsWith('xl/worksheets/')).length === 5, names.join(', '));
  check('XLSX: 모든 항목 CRC 일치', okCrc);
  const s1 = texts['xl/worksheets/sheet1.xml'];
  check('XLSX: data 시트 행 수·헤더·한글 단계 문자열', (s1.match(/<row /g) || []).length === data.length && s1.includes('q1_deg') && s1.includes('스윕'), `${(s1.match(/<row /g) || []).length}행`);
  check('XLSX 열 이름: 0 → A, 25 → Z, 26 → AA, 52 → BA', X.colName(0) === 'A' && X.colName(25) === 'Z' && X.colName(26) === 'AA' && X.colName(52) === 'BA');
  if (process.env.XLSX_OUT) { (await import('node:fs')).writeFileSync(process.env.XLSX_OUT, bytes); console.log('    저장:', process.env.XLSX_OUT); }
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exitCode = fail ? 1 : 0;
