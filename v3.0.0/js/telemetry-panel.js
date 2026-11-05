// 실시간 계측 · 데이터 패널 + 3D 뷰 오버레이 (PRD_v.1.1.2 FR-37~40)
// 버튼(각도·속도·전류·토크)을 켠 항목만 오버레이 표에 보인다. 아무것도 켜지 않으면 오버레이는 숨는다.
// 모든 항목에 막대(각도 = 관절 범위 안의 위치, 속도 = 최대 속도 대비, 전류·토크 = 정격 대비)가 붙고,
// '그래프'를 켜면 3D 화면 아래쪽에 켠 항목별 시계열 그래프(J1~J6, 최근 5·10·30 s)를 그린다 (v1.1.2).

export const METRICS = [
  ['angle', '각도', 'Angle', 'deg'],
  ['velocity', '속도', 'Velocity', 'deg/s'],
  ['current', '전류', 'Current', 'A'],
  ['torque', '토크', 'Torque', 'N·m'],
];

/**
 * @param root 패널 요소, overlay 3D 뷰 위 오버레이 요소
 * @param h { onToggle(key), onRobot(id), onHz(hz), onRecord(), onExport(), onClear() }
 * @returns { render(ui), renderOverlay(data) }
 *   ui = { show: {angle, velocity, current, torque}, robots: [{id, name}], robot, hz, recording, rows, durationS, full, cycles }
 *   data = { name, q, qd, current, currentPct, tau, ratedA } | null
 */
export function mountTelemetryPanel(root, overlay, h) {
  root.innerHTML = `
    <p class="hint">버튼을 누른 항목만 3D 화면 왼쪽 위에 실시간(10 Hz)으로 표시합니다. 전류·토크는 근사 동역학으로 추정한 값입니다(실측 아님).</p>
    <div class="tm-toggles" role="group" aria-label="표시 항목">
      ${METRICS.map(([k, ko, en]) => `<button type="button" class="btn btn-small tm-chip" data-tm="${k}" aria-pressed="false">${ko} <small>${en}</small></button>`).join('')}
    </div>
    <div class="tm-graph-row">
      <button type="button" class="btn btn-small tm-chip" data-tm-graph aria-pressed="false">📈 그래프 <small>Chart</small></button>
      <label class="field"><span>구간 <small>(s)</small></span>
        <select data-tm-win aria-label="그래프 시간 구간"><option value="5">5</option><option value="10" selected>10</option><option value="30">30</option></select>
      </label>
    </div>
    <label class="field"><span>표시할 로봇</span><select data-tm-robot aria-label="표시할 로봇"></select></label>
    <fieldset class="tm-rec">
      <legend>데이터 기록 (머신러닝용)</legend>
      <label class="field"><span>샘플링 <small>(Hz)</small></span>
        <select data-tm-hz aria-label="샘플링 주기"><option value="10">10</option><option value="20" selected>20</option><option value="30">30</option><option value="60">60</option></select>
      </label>
      <div class="data-actions">
        <button type="button" class="btn btn-small" data-tm-act="record">● 기록 시작</button>
        <button type="button" class="btn btn-small" data-tm-act="export" title="data · cycles · events · columns · meta 시트">⬇ 엑셀 추출 (.xlsx)</button>
        <button type="button" class="btn btn-small" data-tm-act="clear">지우기</button>
      </div>
      <p class="sim-status tm-status" aria-live="polite"></p>
      <p class="hint">기록 중에는 모든 로봇(대형·측면)의 각도·속도·가속도·토크·전류와 TCP·단계·사이클·부하·드로스 상황이 시간대별로 한 행씩 쌓입니다(시뮬레이션 시간 기준). 사이클 요약과 단계 변화·알람 이벤트도 함께 추출됩니다.</p>
    </fieldset>`;
  const $ = (s) => root.querySelector(s);
  root.querySelectorAll('[data-tm]').forEach((b) => b.addEventListener('click', () => h.onToggle(b.dataset.tm)));
  $('[data-tm-robot]').addEventListener('change', (e) => h.onRobot(e.target.value));
  $('[data-tm-graph]').addEventListener('click', () => h.onGraph());
  $('[data-tm-win]').addEventListener('change', (e) => h.onWindow(Number(e.target.value)));
  $('[data-tm-hz]').addEventListener('change', (e) => h.onHz(Number(e.target.value)));
  $('[data-tm-act=record]').addEventListener('click', () => h.onRecord());
  $('[data-tm-act=export]').addEventListener('click', () => h.onExport());
  $('[data-tm-act=clear]').addEventListener('click', () => h.onClear());

  let ui = null;
  function render(next = ui) {
    ui = next;
    if (!ui) return;
    root.querySelectorAll('[data-tm]').forEach((b) => {
      const on = !!ui.show[b.dataset.tm];
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const g = $('[data-tm-graph]');
    g.classList.toggle('active', !!ui.graph);
    g.setAttribute('aria-pressed', String(!!ui.graph));
    if (document.activeElement !== $('[data-tm-win]')) $('[data-tm-win]').value = String(ui.windowS);
    const sel = $('[data-tm-robot]');
    const key = ui.robots.map((r) => r.id + r.name).join();
    if (sel.dataset.key !== key) {
      sel.innerHTML = ui.robots.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
      sel.dataset.key = key;
    }
    if (document.activeElement !== sel) sel.value = ui.robot;
    const hz = $('[data-tm-hz]');
    hz.value = String(ui.hz);
    hz.disabled = ui.recording;
    const rec = $('[data-tm-act=record]');
    rec.textContent = ui.recording ? '■ 기록 정지' : '● 기록 시작';
    rec.classList.toggle('btn-attention', ui.recording);
    $('[data-tm-act=export]').disabled = !ui.rows;
    $('[data-tm-act=clear]').disabled = !ui.rows || ui.recording;
    const st = $('.tm-status');
    st.className = 'sim-status tm-status' + (ui.full ? ' warn' : '');
    st.textContent = ui.rows
      ? `${ui.recording ? '기록 중 · ' : '기록됨 · '}${ui.rows.toLocaleString()}행 · ${ui.durationS.toFixed(1)} s · 사이클 요약 ${ui.cycles}건${ui.full ? ' · 한도 도달(기록 중지)' : ''}`
      : ui.recording ? '기록 중 · 0행' : '기록 없음';
  }

  /** 오버레이 표 (선택한 항목만) */
  function renderOverlay(d) {
    const cols = METRICS.filter(([k]) => ui?.show[k]);
    overlay.hidden = !cols.length || !d;
    if (overlay.hidden) return;
    const f = (v, n = 1) => (Math.abs(v) < 0.05 && n === 1 ? 0 : v).toFixed(n);
    const head = `<tr><th>${d.name}</th>${cols.map(([, ko, , u]) => `<th>${ko}<small>${u}</small></th>`).join('')}</tr>`;
    // 막대: 크기 막대(속도·전류·토크, 0 → 100%)와 위치 막대(각도: 관절 범위 안 위치 + 0° 눈금)
    const bar = (pct, cls, val) => `<td class="tm-cur${cls}"><span class="tm-bar" style="width:${Math.min(100, pct).toFixed(0)}%"></span><span class="tm-val">${val}</span></td>`;
    const level = (pct) => (pct > 90 ? ' over' : pct > 70 ? ' warn' : '');
    const rows = [0, 1, 2, 3, 4, 5].map((i) => {
      const cells = cols.map(([k]) => {
        if (k === 'angle') {
          const [lo, hi] = d.limits[i];
          const pos = ((d.q[i] - lo) / (hi - lo)) * 100;
          const zero = ((0 - lo) / (hi - lo)) * 100;
          const edge = Math.min(pos, 100 - pos) < 5 ? ' warn' : '';
          return `<td class="tm-cur tm-ang${edge}"><span class="tm-zero" style="left:${zero.toFixed(1)}%"></span><span class="tm-pos" style="left:${Math.max(0, Math.min(100, pos)).toFixed(1)}%"></span><span class="tm-val">${f(d.q[i])}</span></td>`;
        }
        if (k === 'velocity') {
          const pct = (100 * Math.abs(d.qd[i])) / d.maxSpeed[i];
          return bar(pct, level(pct), f(d.qd[i]));
        }
        if (k === 'torque') {
          const pct = (100 * Math.abs(d.tau[i])) / d.ratedTau[i];
          return bar(pct, level(pct), f(d.tau[i]));
        }
        return bar(d.currentPct[i], level(d.currentPct[i]), f(d.current[i], 2));
      }).join('');
      return `<tr><th>J${i + 1}</th>${cells}</tr>`;
    }).join('');
    const notes = [];
    if (ui.show.angle) notes.push('각도 막대 = 관절 범위 안 위치(세로선 0°, 끝 5% 주황)');
    if (ui.show.velocity) notes.push('속도 = 최대 속도 대비');
    if (ui.show.current || ui.show.torque) notes.push(`전류·토크 = 정격 대비(정격 ${d.ratedA} A) · 추정값`);
    overlay.innerHTML = `<table>${head}${rows}</table><p>${notes.join(' · ')}</p>`;
  }

  return { render, renderOverlay };
}

// ---------------------------------------------------------------------------
// 시계열 그래프 (canvas): 켠 항목마다 한 칸, J1~J6 선, 최근 windowS초
// ---------------------------------------------------------------------------
export const JOINT_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];

/**
 * @param canvas 그래프 캔버스, hist = [{ t, q, qd, current, tau }] (시간 오름차순), opt = { metrics: [[key, ko, en, unit]], windowS, name, limits, light }
 */
export function drawTelemetryChart(canvas, hist, opt) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const fg = opt.light ? '#1d2733' : '#e6edf3', muted = opt.light ? '#5b6b7b' : '#8b9aa9', grid = opt.light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)';
  const field = { angle: 'q', velocity: 'qd', current: 'current', torque: 'tau' };
  const tEnd = hist.length ? hist[hist.length - 1].t : 0;
  const tStart = tEnd - opt.windowS;
  const pts = hist.filter((h) => h.t >= tStart);
  // 범례
  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'middle';
  let lx = 8;
  g.fillStyle = '#ffd23f';
  g.fillText(opt.name, lx, 9);
  lx += g.measureText(opt.name).width + 14;
  JOINT_COLORS.forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect(lx, 6, 12, 3);
    g.fillStyle = fg;
    g.fillText(`J${i + 1}`, lx + 15, 9);
    lx += 40;
  });
  g.fillStyle = muted;
  g.textAlign = 'right';
  g.fillText(`최근 ${opt.windowS} s · 시뮬레이션 시간`, W - 8, 9);
  g.textAlign = 'left';
  const top = 20, n = opt.metrics.length, gap = 6;
  const rowH = (H - top - 16 - gap * (n - 1)) / n;
  const left = 54, right = 8;
  opt.metrics.forEach(([key, ko, , unit], k) => {
    const y0 = top + k * (rowH + gap);
    const f = field[key];
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) for (const v of p[f]) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    if (key !== 'angle') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-3); lo = -m; hi = m; } // 0 기준 대칭
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const X = (t) => left + ((t - tStart) / opt.windowS) * (W - left - right);
    const Y = (v) => y0 + rowH - ((v - lo) / (hi - lo)) * rowH;
    // 틀·격자
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.strokeRect(left + 0.5, y0 + 0.5, W - left - right - 1, rowH - 1);
    for (let s = Math.ceil(tStart); s <= tEnd; s += opt.windowS > 10 ? 5 : 1) {
      const x = Math.round(X(s)) + 0.5;
      g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + rowH); g.stroke();
    }
    if (lo < 0 && hi > 0) {
      g.strokeStyle = muted;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(left, Math.round(Y(0)) + 0.5); g.lineTo(W - right, Math.round(Y(0)) + 0.5); g.stroke();
      g.setLineDash([]);
    }
    // 축 라벨
    g.fillStyle = fg;
    g.fillText(ko, 6, y0 + 9);
    g.fillStyle = muted;
    g.fillText(unit, 6, y0 + 22);
    g.textAlign = 'right';
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
    g.fillText(fmt(hi), left - 4, y0 + 7);
    g.fillText(fmt(lo), left - 4, y0 + rowH - 6);
    g.textAlign = 'left';
    // 선
    g.save();
    g.beginPath(); g.rect(left, y0, W - left - right, rowH); g.clip();
    g.lineWidth = 1.5;
    for (let j = 0; j < 6; j++) {
      g.strokeStyle = JOINT_COLORS[j];
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p[f][j])) : g.moveTo(X(p.t), Y(p[f][j]))));
      g.stroke();
    }
    g.restore();
  });
  // 시간 축
  g.fillStyle = muted;
  g.textAlign = 'center';
  g.fillText(`−${opt.windowS} s`, left + 12, H - 7);
  g.fillText('지금', W - right - 14, H - 7);
  g.textAlign = 'left';
}
