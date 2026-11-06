// 드로스 제거 셀 패널 (PRD_v.1.1.1 FR-25~FR-30): 사용 스위치, 설정, 스키밍 실행(1사이클·자동 연속), 집계 표시
import { DROSS_FIELDS, DROSS_LIMITS, LANE_DIRS } from './dross.js';

/**
 * @param {HTMLElement} root
 * @param {{ onToggle(enabled), onField(key, value), onRunCycle(), onAuto(), onStop(), onRespawn(), onView(), onUseLargeRobot() }} h
 * @returns {{ render(ui) }}
 *   ui = { enabled, cfg, robotOk, robotName, physics, status: 'idle'|'planning'|'running'|'paused', auto, label, error,
 *          stats(DrossField.stats() | null), cycles, lastS, avgS }
 */
export function mountDrossPanel(root, h) {
  root.innerHTML = `
    <label class="toggle"><input type="checkbox" role="switch" id="dross-toggle" /><span>드로스 제거 셀 사용 (Dross Removal Cell)</span></label>
    <p class="hint dr-req" hidden></p>
    <div class="dr-body">
      <div class="data-actions dr-actions">
        <button type="button" class="btn btn-small" data-dr="cycle" title="드로스가 가장 많은 레인을 1회 스키밍">▶ 1사이클</button>
        <button type="button" class="btn btn-small" data-dr="auto" title="Esc 또는 정지를 누를 때까지 반복">⟳ 자동 연속</button>
        <button type="button" class="btn btn-small" data-dr="stop">■ 정지</button>
        <button type="button" class="btn btn-small" data-dr="respawn" title="설정(개수·시드)으로 드로스를 처음부터 다시 배치 (물리 리셋)">↺ 다시 배치</button>
        <button type="button" class="btn btn-small" data-dr="view" title="셀 전체가 보이는 위치로 카메라 이동">셀 보기</button>
      </div>
      <p class="sim-status dr-status" aria-live="polite"></p>
      <dl class="dr-stats" aria-label="드로스 집계"></dl>
      <fieldset class="dr-sides">
        <legend>측면 로봇 (소형 · 협동 로봇, 포트 좌·우 받침대)</legend>
        ${['left', 'right'].map((slot) => `
        <div class="dr-side" data-slot="${slot}">
          <div class="dr-side-row">
            <span class="dr-side-name">${slot === 'left' ? '왼쪽 (L)' : '오른쪽 (R)'}</span>
            <select data-side-robot aria-label="${slot === 'left' ? '왼쪽' : '오른쪽'} 측면 로봇"></select>
            <select data-side-mode aria-label="역할">
              <option value="1">모드 1 · 제거</option>
              <option value="2">모드 2 · 보조 밀기</option>
              <option value="3">모드 3 · 타이밍 밀기</option>
            </select>
          </div>
          <p class="hint dr-side-status"></p>
        </div>`).join('')}
        <p class="hint">모드 1: 자기 쪽 바깥 띠의 드로스를 작은 스쿱으로 떠서 옆의 측면 드로스 박스에 버립니다(대형 로봇은 가운데 레인만 맡아 동시에 작업).
        모드 2: 밀대로 벽 쪽 드로스를 포트 가운데(대형 로봇 레인)로 밀어 줍니다. 대형 로봇이 포트 밖(드로스 박스)에 있을 때만 들어갑니다.
        모드 3 (v3.0.0): 밀어 주기만 하고 회수는 대형 로봇만. 대형이 박스에 다녀오는 동안, 돌아오기 전에 끝낼 수 있는 밀기만 시작해 대형이 덜 기다립니다(10분 57.5%, 모드 2 53.3%).</p>
      </fieldset>
      <label class="field dr-lanedir"><span>대형 쓸기 방향 <small>(열린 면 방향)</small></span>
        <select data-dr-lanedir>${Object.entries(LANE_DIRS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <p class="hint dr-lanedir-hint">로봇 쪽: 스나우트 쪽에서 로봇 쪽으로 쓸기(열린 면이 로봇을 봄). 스나우트 쪽: 반대로 쓸어 스나우트 앞까지 담고, 들어 올린 뒤 물러나 천천히 돌려 운반. 번갈아: 사이클마다 바꿈(10분 72.9%, 기존 61.3%). 측면 로봇이 있으면 로봇 쪽으로만 쓸어요.</p>
      <details class="thresholds">
        <summary>셀 설정 (Settings)</summary>
        <div class="threshold-fields">
          ${DROSS_FIELDS.map(([k, label, unit, step]) => {
            const [lo, hi] = DROSS_LIMITS[k];
            return `<label class="field"><span>${label}${unit ? ` <small>(${unit})</small>` : ''}</span>` +
              `<input type="number" min="${lo}" max="${hi}" step="${step}" data-dr-field="${k}" /></label>`;
          }).join('')}
        </div>
        <p class="hint">초기 개수·시드는 '다시 배치'(물리 리셋) 때 반영되고, 발생률·잠김 깊이·스윕 속도는 바로 반영됩니다.</p>
      </details>
      <p class="hint">아연 포트 욕면에 떠 있는 드로스를 스키머(수직 봉 + 사각 스쿱)로 떠서 드로스 박스에 버립니다. 레인은 드로스가 가장 많은 곳부터 고르고, 모든 이동은 안전 검사를 통과해야 실행됩니다. 포트 벽·스나우트·드로스 박스는 고정 설비로 충돌 검사 대상이고, 드로스는 작업 대상이라 스쿱이 닿아도 됩니다.</p>
    </div>
    <div class="dr-large" hidden><button type="button" class="btn btn-small" data-dr="large">대형 로봇으로 바꾸기</button></div>`;

  const $ = (sel) => root.querySelector(sel);
  const toggle = $('#dross-toggle');
  toggle.addEventListener('change', () => h.onToggle(toggle.checked));
  root.querySelectorAll('.dr-side').forEach((row) => {
    const slot = row.dataset.slot;
    row.querySelector('[data-side-robot]').addEventListener('change', (e) => h.onSideRobot(slot, e.target.value || null));
    row.querySelector('[data-side-mode]').addEventListener('change', (e) => h.onSideMode(slot, Number(e.target.value)));
  });
  $('[data-dr-lanedir]').addEventListener('change', (e) => h.onField('laneDir', e.target.value));
  const act = { cycle: h.onRunCycle, auto: h.onAuto, stop: h.onStop, respawn: h.onRespawn, view: h.onView, large: h.onUseLargeRobot };
  root.querySelectorAll('[data-dr]').forEach((b) => b.addEventListener('click', () => act[b.dataset.dr]()));
  root.querySelectorAll('[data-dr-field]').forEach((input) =>
    input.addEventListener('change', () => {
      const k = input.dataset.drField;
      const [lo, hi] = DROSS_LIMITS[k];
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v)) return render();
      h.onField(k, Math.min(hi, Math.max(lo, v)));
    }),
  );

  let ui = null;
  function render(next = ui) {
    ui = next;
    if (!ui) return;
    toggle.checked = ui.enabled;
    const req = $('.dr-req');
    const problem = !ui.enabled ? '' : !ui.robotOk
      ? `${ui.robotName}은(는) 도달거리가 짧아 셀을 쓸 수 없습니다. 대형 로봇(도달거리 2.4 m 이상)을 선택하세요.`
      : !ui.physics ? '물리 모드에서 드로스가 시뮬레이션됩니다 (물체 · 시뮬레이션 패널).' : '';
    req.textContent = problem;
    req.hidden = !problem;
    $('.dr-large').hidden = !(ui.enabled && !ui.robotOk);
    $('.dr-body').hidden = !ui.enabled;
    if (!ui.enabled) return;
    root.querySelectorAll('[data-dr-field]').forEach((input) => {
      if (document.activeElement !== input) input.value = String(ui.cfg[input.dataset.drField]);
    });
    const ld = $('[data-dr-lanedir]');
    if (document.activeElement !== ld) ld.value = ui.cfg.laneDir ?? 'robot';
    ld.disabled = ui.status !== 'idle' || !!ui.hasSides;
    ld.title = ui.hasSides ? '측면 로봇이 있으면 로봇 쪽으로만 쓸어요 (스나우트 쪽 경로가 측면 로봇과 너무 가까움)' : '';
    const busy = ui.status !== 'idle';
    const ready = ui.robotOk && ui.physics;
    $('[data-dr=cycle]').disabled = busy || !ready;
    $('[data-dr=auto]').disabled = busy || !ready;
    $('[data-dr=stop]').disabled = !busy && !ui.auto;
    $('[data-dr=respawn]').disabled = busy || !ready;
    const st = $('.dr-status');
    st.className = 'sim-status dr-status' + (ui.error ? ' error' : '');
    st.textContent = ui.error
      ? ui.error
      : ui.status === 'planning' ? `계획 중… ${ui.label ?? ''}`
      : ui.status === 'running' ? `${ui.auto ? '자동 연속 · ' : ''}실행 중: ${ui.label ?? ''}`
      : ui.status === 'paused' ? `일시정지: ${ui.label ?? ''}`
      : ready ? '대기 — ▶ 1사이클 또는 ⟳ 자동 연속을 누르세요' : '';
    renderSides(ui);
    const s = ui.stats;
    const fmtKg = (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0));
    $('.dr-stats').innerHTML = s
      ? [
        ['작업 영역 욕면', `${s.work}개 · ${fmtKg(s.workKg)} kg · 덮임 ${s.coverage.toFixed(1)}%`],
        ['회수 (드로스 박스)', `${s.bin}개 · ${fmtKg(s.binKg)} kg`],
        ['흘림 (바닥) · 운반 중', `${s.spilled}개 · ${s.carried}개`],
        ['스나우트 너머', `${s.far}개 (다른 로봇 담당 영역)`],
        ...(s.bins && Object.keys(s.bins).length > 1 ? [['박스별 회수', Object.entries(s.bins).map(([k, v]) => `${{ main: '대형', left: '왼쪽', right: '오른쪽' }[k]} ${v}`).join(' · ')]] : []),
        ['사이클', `${ui.cycles}회${ui.cycles ? ` · 최근 ${ui.lastS.toFixed(1)} s · 평균 ${ui.avgS.toFixed(1)} s` : ''}`],
        ['발생 누적', `${s.spawned}개 (발생률 ${ui.cfg.ratePerMin}개/분)`],
      ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
      : '';
  }

  /** 측면 로봇 선택·역할·상태 */
  function renderSides(u) {
    const sides = u.sides;
    if (!sides) return;
    root.querySelectorAll('.dr-side').forEach((row) => {
      const slot = row.dataset.slot;
      const cfg = sides[slot];
      const sel = row.querySelector('[data-side-robot]');
      if (sel.options.length !== sides.candidates.length + 1) {
        sel.innerHTML = '<option value="">없음</option>' + sides.candidates.map((c) => `<option value="${c.id}">${c.maker} ${c.name}${c.cobot ? ' (협동)' : ''} · ${c.reachMm} mm</option>`).join('');
      }
      if (document.activeElement !== sel) sel.value = cfg.robotId ?? '';
      const mode = row.querySelector('[data-side-mode]');
      if (document.activeElement !== mode) mode.value = String(cfg.mode);
      sel.disabled = mode.disabled = !!u.busy;
      mode.hidden = !cfg.robotId;
      const st = row.querySelector('.dr-side-status');
      st.className = 'hint dr-side-status' + (cfg.error ? ' dr-err' : '');
      st.textContent = !cfg.robotId ? '' : cfg.error ?? `${cfg.installing ? '설치 중… (도달 범위·레인 계산)' : cfg.label || '대기'}${cfg.cycles ? ` · 작업 ${cfg.cycles}회` : ''}${cfg.binCount != null ? ` · 측면 박스 ${cfg.binCount}개` : ''}${cfg.lanes != null ? ` · 레인 ${cfg.lanes}개` : ''}`;
    });
  }

  return { render };
}
