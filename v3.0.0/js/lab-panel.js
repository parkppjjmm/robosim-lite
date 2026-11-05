// 학습 (Trial & Error) 설정 창 — PRD_v.3.0.0 4.5·FR-67. 탐색 범위·점수 규칙·탐색량·과제를 정하고
// 앱에서 바로 학습(Worker) 하거나, 설정을 파일로 내보내 헤드리스(node tools/train.mjs --lab 파일)로 돌린다.
import { STROKE_PARAMS, REWARD_DEFAULTS } from './stroke-lab.js';

const REWARD_LABELS = [
  ['perDross', '드로스 1개 회수', '+'],
  ['wallBonus', '벽 띠·모서리 드로스면 추가', '+'],
  ['emptyStroke', '헛질 (한 번 쓸어 0개)', '−'],
  ['spill', '흘림 1개', '−'],
  ['perSecond', '스트로크 1초', '−'],
  ['infeasible', '계획 불가 (도달 불가·충돌)', '−'],
];

/**
 * @param h { onStart(cfg), onStop(), onExport(cfg), onImport(file), onReplay(which), onSaveLog(), onReset() }
 * @returns { render(ui), read() → { lab, task, workers, compare }, load(cfg) }
 */
export function mountLabPanel(root, h) {
  root.innerHTML = `
    <p class="hint">스쿱 열린 면 방향(J6)·쓸어 가는 방향·위치·기울임 등을 바꿔 가며 시도(Trial)하고, 점수 규칙으로 가장 좋은 것만 실행합니다(진화 탐색 → 다음 단계 강화학습).
    대형 로봇이 학습 대상이고, 측면 로봇은 '드로스 제거 셀'에서 고른 대로 기존 경로로 함께 일합니다.</p>
    <fieldset class="lab-box"><legend>과제</legend>
      <div class="lab-grid">
        <label>목표 회수율 <span><input type="number" data-lab-task="targetRatePct" min="10" max="100" step="1" value="80" /> %</span></label>
        <label>제한 시간 <span><input type="number" data-lab-task="timeLimitS" min="30" max="3600" step="30" value="600" /> s</span></label>
      </div>
      <p class="hint lab-cell"></p>
    </fieldset>
    <fieldset class="lab-box"><legend>점수 규칙 (보상)</legend>
      <div class="lab-grid">${REWARD_LABELS.map(([k, t, s]) => `<label>${t} <span>${s === '+' ? '+' : ''}<input type="number" data-lab-reward="${k}" step="any" value="${REWARD_DEFAULTS[k]}" /></span></label>`).join('')}</div>
      <p class="hint">음수가 벌점입니다. 예: 헛질을 크게 줄이려면 헛질 값을 −50처럼 더 작게.</p>
    </fieldset>
    <fieldset class="lab-box"><legend>시도할 범위 (탐색 변수)</legend>
      <table class="lab-search"><thead><tr><th>변수</th><th>탐색</th><th>최소</th><th>최대</th><th>고정값</th></tr></thead>
      <tbody>${STROKE_PARAMS.map((p) => `<tr data-key="${p.key}"><th title="${p.label}">${p.label} <small>${p.unit}</small></th>
        <td><input type="checkbox" data-s="on" checked /></td>
        <td><input type="number" data-s="min" step="any" value="${p.range[0]}" /></td>
        <td><input type="number" data-s="max" step="any" value="${p.range[1]}" /></td>
        <td><input type="number" data-s="fixed" step="any" value="${p.fixed}" /></td></tr>`).join('')}</tbody></table>
      <p class="hint">탐색을 끄면 고정값을 씁니다. 열린 면 방향 0° = 진행 방향(지금 규칙 경로), ±90° = 옆, ±180° = 뒤.</p>
    </fieldset>
    <fieldset class="lab-box"><legend>탐색 방법 · 양</legend>
      <div class="lab-grid">
        <label>방법 <select data-lab="method"><option value="cem">진화 탐색 (CEM)</option><option value="random">무작위 탐색</option><option value="ppo" disabled>강화학습 (PPO) — 다음 단계</option></select></label>
        <label>세대당 후보 <input type="number" data-lab="population" min="2" max="256" value="16" /></label>
        <label>세대 수 (결정마다) <input type="number" data-lab="iterations" min="1" max="50" value="3" /></label>
        <label>병렬 Worker <input type="number" data-lab="workers" min="1" max="64" value="4" /></label>
        <label>난수 시드 <input type="number" data-lab="seed" min="1" value="1" /></label>
        <label class="lab-check"><input type="checkbox" data-lab="includeRule" checked /> 규칙 경로도 후보에 넣기</label>
        <label class="lab-check"><input type="checkbox" data-lab="compare" checked /> 끝나면 규칙 경로와 비교 실행</label>
      </div>
      <p class="hint lab-cost"></p>
    </fieldset>
    <div class="data-actions">
      <button type="button" class="btn btn-small btn-primary" data-lab-act="start">▶ 학습 시작</button>
      <button type="button" class="btn btn-small" data-lab-act="stop">■ 중지</button>
      <button type="button" class="btn btn-small" data-lab-act="export" title="node tools/train.mjs --lab 파일 로 헤드리스 실행">설정 내보내기</button>
      <button type="button" class="btn btn-small" data-lab-act="import">설정 가져오기</button>
      <button type="button" class="btn btn-small" data-lab-act="reset">기본값</button>
      <input type="file" data-lab-act="file" accept=".json,application/json" hidden />
    </div>
    <p class="sim-status lab-status" aria-live="polite"></p>
    <div class="lab-progress" hidden>
      <div class="rp-prog"><i></i><s></s></div>
      <canvas class="lab-chart" width="300" height="110" aria-label="결정별 최고 점수와 규칙 점수"></canvas>
      <table class="lab-decisions"></table>
    </div>
    <div class="data-actions lab-result" hidden>
      <button type="button" class="btn btn-small" data-lab-act="replay-lab">학습 결과 3D 재생</button>
      <button type="button" class="btn btn-small" data-lab-act="replay-rule">규칙 결과 3D 재생</button>
      <button type="button" class="btn btn-small" data-lab-act="save">결과 저장 (로그·에피소드)</button>
    </div>
    <dl class="dr-stats lab-summary"></dl>`;
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const fileIn = $('[data-lab-act=file]');
  const act = (k, f) => $(`[data-lab-act=${k}]`).addEventListener('click', f);
  act('start', () => h.onStart(read()));
  act('stop', () => h.onStop());
  act('export', () => h.onExport(read()));
  act('import', () => fileIn.click());
  act('reset', () => h.onReset());
  act('replay-lab', () => h.onReplay('lab'));
  act('replay-rule', () => h.onReplay('rule'));
  act('save', () => h.onSaveLog());
  fileIn.addEventListener('change', () => {
    if (fileIn.files[0]) h.onImport(fileIn.files[0]);
    fileIn.value = '';
  });
  root.addEventListener('input', () => renderCost());

  function read() {
    const v = (sel) => $(sel).value;
    const search = {};
    for (const tr of $$('.lab-search tbody tr')) {
      const g = (k) => tr.querySelector(`[data-s=${k}]`);
      search[tr.dataset.key] = { on: g('on').checked, min: +g('min').value, max: +g('max').value, fixed: +g('fixed').value };
    }
    const reward = { ...REWARD_DEFAULTS };
    for (const el of $$('[data-lab-reward]')) reward[el.dataset.labReward] = +el.value;
    return {
      lab: { method: v('[data-lab=method]'), population: +v('[data-lab=population]'), iterations: +v('[data-lab=iterations]'), seed: +v('[data-lab=seed]'), includeRule: $('[data-lab=includeRule]').checked, search, reward },
      task: { targetRatePct: +v('[data-lab-task=targetRatePct]'), timeLimitS: +v('[data-lab-task=timeLimitS]') },
      workers: +v('[data-lab=workers]'),
      compare: $('[data-lab=compare]').checked,
    };
  }

  function load(cfg) {
    const lab = cfg.lab ?? {};
    const set = (sel, val) => val !== undefined && ($(sel).value = String(val));
    set('[data-lab=method]', lab.method);
    set('[data-lab=population]', lab.population);
    set('[data-lab=iterations]', lab.iterations);
    set('[data-lab=seed]', lab.seed);
    if (lab.includeRule !== undefined) $('[data-lab=includeRule]').checked = !!lab.includeRule;
    for (const [k, val] of Object.entries(lab.reward ?? {})) {
      const el = $(`[data-lab-reward=${k}]`);
      if (el) el.value = String(val);
    }
    for (const [k, s] of Object.entries(lab.search ?? {})) {
      const tr = $(`.lab-search tr[data-key=${k}]`);
      if (!tr) continue;
      tr.querySelector('[data-s=on]').checked = !!s.on;
      for (const f of ['min', 'max', 'fixed']) if (s[f] !== undefined) tr.querySelector(`[data-s=${f}]`).value = String(s[f]);
    }
    set('[data-lab-task=targetRatePct]', cfg.task?.targetRatePct);
    set('[data-lab-task=timeLimitS]', cfg.task?.timeLimitS);
    if (cfg.workers) set('[data-lab=workers]', cfg.workers);
    renderCost();
  }

  function renderCost() {
    const c = read();
    const per = c.lab.population * c.lab.iterations;
    // 후보 1개 평가 ≈ 1.3 s (Node 측정, 코어 1개) — 브라우저 WASM도 비슷
    const sec = (per * 1.3) / Math.max(1, c.workers);
    $('.lab-cost').textContent = `결정 1번에 시도 ${per}개 → 약 ${sec.toFixed(0)} s (Worker ${c.workers}개 기준). 10분 과제는 결정 약 14번 → 학습 약 ${Math.ceil((sec * 14) / 60)}분 + 시뮬레이션.`;
  }

  return {
    read,
    load,
    setDefaultWorkers(n) {
      $('[data-lab=workers]').value = String(n);
      renderCost();
    },
    /** ui = { status, running, cellText, target, progress: { t, timeLimitS, rate }, decisions: [...], summary, rule, hasResult, hasRule } */
    render(ui) {
      $('.lab-status').textContent = ui.status ?? '';
      $('.lab-cell').textContent = ui.cellText ?? '';
      $('[data-lab-act=start]').disabled = !!ui.running;
      $('[data-lab-act=stop]').disabled = !ui.running;
      $$('.lab-box input, .lab-box select').forEach((el) => (el.disabled = !!ui.running));
      const pr = $('.lab-progress');
      pr.hidden = !(ui.running || ui.decisions?.length);
      if (!pr.hidden) {
        const pct = Math.max(0, Math.min(100, ui.progress?.rate ?? 0));
        const tgt = ui.target ?? 80;
        const bar = $('.lab-progress .rp-prog i');
        bar.style.width = `${pct}%`;
        bar.classList.toggle('ok', pct >= tgt);
        $('.lab-progress .rp-prog s').style.left = `${tgt}%`;
        const ds = ui.decisions ?? [];
        $('.lab-decisions').innerHTML = `<tr><th>#</th><th>시각</th><th>회수율</th><th>최고 / 규칙</th><th>스트로크</th></tr>` + ds.slice(-8).reverse().map((d) => {
          const v = d.best.values;
          return `<tr><td>${d.n}</td><td>${d.t}s</td><td>${d.rate}%</td><td>${d.best.score}${d.best.rule ? ' (규칙)' : ` / ${d.ruleScore ?? '—'}`}</td><td>${v.headingDeg.toFixed(0)}° · 열린 면 ${v.yaw0Deg.toFixed(0)}→${v.yaw1Deg.toFixed(0)}° · 기울임 ${v.tiltDeg.toFixed(0)}°</td></tr>`;
        }).join('');
        drawChart($('.lab-chart'), ds);
      }
      $('.lab-result').hidden = !ui.hasResult;
      $('[data-lab-act=replay-rule]').hidden = !ui.hasRule;
      $('.lab-summary').innerHTML = (ui.summary ?? []).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    },
  };
}

/** 결정별 최고 점수(파랑)와 같은 결정의 규칙 레인 점수(회색) */
function drawChart(cv, ds) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, L = 34, B = 14, T = 6, R = 6;
  ctx.clearRect(0, 0, W, H);
  if (!ds.length) return;
  const light = document.documentElement.dataset.theme === 'light';
  const vals = ds.flatMap((d) => [d.best.score, d.ruleScore ?? d.best.score]);
  const lo = Math.min(0, ...vals), hi = Math.max(10, ...vals);
  const x = (i) => L + ((W - L - R) * (ds.length === 1 ? 0.5 : i / (ds.length - 1)));
  const y = (v) => H - B - ((H - B - T) * (v - lo)) / (hi - lo);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = light ? '#5b6672' : '#8b98a5';
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
  for (const v of [lo, 0, hi]) {
    ctx.beginPath();
    ctx.moveTo(L, y(v));
    ctx.lineTo(W - R, y(v));
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 2, y(v) + 3);
  }
  ctx.fillText('결정 →', W - R - 40, H - 2);
  const line = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ds.forEach((d, i) => {
      const v = key(d);
      i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
    });
    ctx.stroke();
  };
  line((d) => d.ruleScore ?? d.best.score, light ? '#9aa3ad' : '#6b7682');
  line((d) => d.best.score, '#3d9be9');
  ctx.lineWidth = 1;
}
