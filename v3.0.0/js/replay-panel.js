// 에피소드 재생 패널 + 3D 화면 재생 막대 (PRD_v.3.0.0 FR-63 일부): 헤드리스 결과(.rsim.json.gz)를 3D로 다시 보기
// 패널: 파일 열기, 에피소드 정보·결과, 회수율 곡선(목표선·현재 시각), 재생 종료
// 화면 막대: 처음으로 · 재생/일시정지 · 배속 · 시간 막대 · 시각 / 오른쪽 위 정보: 회수율·목표·단계·관절각
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20];

const fmtT = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * @param root 패널 컨테이너, bar 3D 화면 재생 막대, info 3D 화면 정보 상자
 * @param h { onFile(file), onPlay(), onRestart(), onSpeed(x), onSeek(t), onExit(), onRobot(slot) }
 */
export function mountReplayPanel(root, bar, info, h) {
  root.innerHTML = `
    <p class="hint">헤드리스 실행 결과(<code>node tools/episode.mjs</code>가 만든 <code>.rsim.json.gz</code>)를 불러와 3D로 다시 봅니다. 재생 중에는 앱의 시뮬레이션이 멈추고, 저장된 설정은 바뀌지 않습니다.</p>
    <div class="data-actions">
      <button type="button" class="btn btn-small" data-rp="open">에피소드 불러오기</button>
      <button type="button" class="btn btn-small" data-rp="exit" hidden>재생 종료</button>
      <input type="file" data-rp="file" accept=".gz,.json,application/json,application/gzip" hidden />
    </div>
    <p class="sim-status rp-status" aria-live="polite"></p>
    <dl class="dr-stats rp-meta"></dl>
    <canvas class="rp-chart" width="300" height="120" aria-label="회수율 곡선" hidden></canvas>`;
  bar.innerHTML = `
    <button type="button" class="rp-btn" data-rp="restart" title="처음으로">⏮</button>
    <button type="button" class="rp-btn rp-play" data-rp="play" title="재생 / 일시정지 (Space)">▶</button>
    <select data-rp="speed" aria-label="배속">${REPLAY_SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>
    <input type="range" data-rp="seek" min="0" max="1000" step="1" value="0" aria-label="재생 위치" />
    <span class="rp-time">0:00.0 / 0:00.0</span>`;
  const $ = (s, el = root) => el.querySelector(s);
  const file = $('[data-rp=file]');
  $('[data-rp=open]').addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    if (file.files[0]) h.onFile(file.files[0]);
    file.value = '';
  });
  $('[data-rp=exit]').addEventListener('click', () => h.onExit());
  $('[data-rp=play]', bar).addEventListener('click', () => h.onPlay());
  $('[data-rp=restart]', bar).addEventListener('click', () => h.onRestart());
  $('[data-rp=speed]', bar).addEventListener('change', (e) => h.onSpeed(Number(e.target.value)));
  const seek = $('[data-rp=seek]', bar);
  let seeking = false;
  seek.addEventListener('input', () => {
    seeking = true;
    h.onSeek(Number(seek.value) / 1000);
  });
  seek.addEventListener('change', () => (seeking = false));
  info.addEventListener('change', (e) => {
    if (e.target.matches('[data-rp=robot]')) h.onRobot(e.target.value);
  });
  const chart = $('.rp-chart');

  return {
    /** 패널 (불러오기·종료 때). ui = { active, status, meta: [[k, v]], speed, slots, slot } */
    render(ui) {
      $('.rp-status').textContent = ui.status ?? '';
      $('[data-rp=exit]').hidden = !ui.active;
      bar.hidden = !ui.active;
      info.hidden = !ui.active;
      chart.hidden = !ui.active;
      $('.rp-meta').innerHTML = ui.active ? ui.meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') : '';
      if (!ui.active) return;
      $('[data-rp=speed]', bar).value = String(ui.speed);
      const names = { main: '대형', left: '왼쪽', right: '오른쪽' };
      info.innerHTML = `
        <div class="rp-rate"></div>
        <div class="rp-prog"><i></i><s></s></div>
        <div class="rp-label"></div>
        <label class="rp-robot">관절각 <select data-rp="robot">${ui.slots.map((s) => `<option value="${s}" ${s === ui.slot ? 'selected' : ''}>${names[s]}</option>`).join('')}</select></label>
        <table class="rp-joints"></table>`;
    },
    /** 매 프레임 (재생 중) */
    renderFrame(f) {
      $('[data-rp=play]', bar).textContent = f.playing ? '⏸' : '▶';
      if (!seeking) seek.value = String(Math.round((1000 * f.t) / Math.max(1e-6, f.duration)));
      $('.rp-time', bar).textContent = `${fmtT(f.t)} / ${fmtT(f.duration)}`;
      const rate = $('.rp-rate', info);
      if (!rate) return;
      const pct = Math.max(0, Math.min(100, f.rate ?? 0));
      const tgt = Math.max(0, Math.min(100, f.target));
      rate.innerHTML = `<b>${(f.rate ?? 0).toFixed(1)}%</b> <small>회수율 (질량 ${(f.rateKg ?? 0).toFixed(1)}%) · 목표 ${f.target}%</small>`;
      const bar_ = $('.rp-prog i', info);
      bar_.style.width = `${pct}%`;
      bar_.classList.toggle('ok', pct >= tgt);
      $('.rp-prog s', info).style.left = `${tgt}%`;
      $('.rp-label', info).textContent = `대형: ${f.label || '—'}`;
      $('.rp-joints', info).innerHTML = (f.q[f.slot] ?? []).map((v, i) => `<tr><th>J${i + 1}</th><td>${v.toFixed(1)}°</td></tr>`).join('');
      drawChart(chart, f);
    },
  };
}

/** 회수율 곡선: 가로 = 시간, 세로 = 0~100%, 목표선(점선), 현재 시각(세로선) */
function drawChart(cv, f) {
  if (cv.hidden || !f.history?.length) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, L = 30, B = 16, T = 6, R = 6;
  const light = document.documentElement.dataset.theme === 'light';
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = light ? '#5b6672' : '#8b98a5';
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
  const x = (t) => L + ((W - L - R) * t) / Math.max(1e-6, f.duration);
  const y = (p) => H - B - ((H - B - T) * p) / 100;
  for (const p of [0, 50, 100]) {
    ctx.beginPath();
    ctx.moveTo(L, y(p));
    ctx.lineTo(W - R, y(p));
    ctx.stroke();
    ctx.fillText(`${p}%`, 2, y(p) + 3);
  }
  ctx.fillText('0', L, H - 3);
  ctx.fillText(`${Math.round(f.duration)} s`, W - R - 34, H - 3);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#f5a524';
  ctx.beginPath();
  ctx.moveTo(L, y(f.target));
  ctx.lineTo(W - R, y(f.target));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#3d9be9';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  f.history.forEach(([t, p], i) => (i ? ctx.lineTo(x(t), y(p)) : ctx.moveTo(x(t), y(p))));
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = light ? '#1d2733' : '#e6edf3';
  ctx.beginPath();
  ctx.moveTo(x(f.t), T);
  ctx.lineTo(x(f.t), H - B);
  ctx.stroke();
}
