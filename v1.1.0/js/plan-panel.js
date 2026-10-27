// 자동 경로 계획 패널 (PRD FR-12~FR-14): A(시작)·B(목표)만 지정하면 중간 경유점을 자동 생성한다.
// A/B는 현재 자세, Waypoint, TCP 좌표 중 하나로 지정한다. 생성된 경유점은 목록과 3D 라벨로 보여 준다.
import { getState, setState } from './state.js';

export const PLAN_REASON_LABEL = {
  'start-collision': 'A(시작) 사용 불가',
  'goal-collision': 'B(목표) 사용 불가',
  'ik-failed': '도달 불가 (Out of Reach)',
  'singularity-blocked': '특이점 차단',
  timeout: '시간 초과',
  cancelled: '취소됨',
  error: '오류',
};

const TCP_FIELDS = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
// 끝점 지정 방식: A는 현재 자세도 가능
const MODES = { A: ['current', 'waypoint', 'pose'], B: ['waypoint', 'pose'] };
const MODE_LABEL = { current: '현재 자세', waypoint: 'Waypoint', pose: 'TCP 좌표' };

/**
 * @param {HTMLElement} root
 * @param {{ getRobot, getTcp: () => number[], onPlan: (req) => void, onCancel, onRun, onPause, onRewind, onSaveWaypoints }} opts
 *   onPlan req: { start, goal } 각각 { type: 'current' } | { type: 'waypoint', id } | { type: 'pose', pos, rpy }
 * @returns {{ render: (ui) => void, renderInputs: () => void }}
 *   ui = { status: 'idle'|'planning'|'approach'|'ready'|'running'|'paused', progress, error, stats, stale, vertices: [{label, tcp}] }
 */
export function mountPlanPanel(root, { getRobot, getTcp, onPlan, onCancel, onRun, onPause, onRewind, onSaveWaypoints }) {
  const endpoint = (key, title) => `
    <div class="plan-end" data-end="${key}">
      <div class="plan-end-head">
        <span class="plan-tag plan-tag-${key}">${key}</span><strong>${title}</strong>
        <div class="segmented" role="radiogroup" aria-label="${key} 지정 방식">
          ${MODES[key].map((m) => `<button type="button" role="radio" data-mode="${m}">${MODE_LABEL[m]}</button>`).join('')}
        </div>
      </div>
      <label class="field" data-show="waypoint"><span>Waypoint</span><select data-wp></select></label>
      <div class="plan-tcp" data-show="pose">
        ${TCP_FIELDS.map((f) => `<label class="field"><span>${f}</span><input type="number" step="1" data-tcp="${f}" aria-label="${key} ${f}" /></label>`).join('')}
        <button type="button" class="btn btn-small" data-act="tcp-now">현재 TCP 값 가져오기</button>
      </div>
      <p class="hint" data-show="current">계획 시점의 로봇 자세를 A로 씁니다.</p>
    </div>`;

  root.innerHTML = `
    <p class="hint plan-off">기능 설정에서 <strong>자동 경로 계획</strong>을 켜면 사용할 수 있습니다.</p>
    <fieldset class="plan-body">
      <p class="hint plan-intro">A와 B만 지정하면 장애물·자기 충돌을 피하고 특이점과 도달 범위(Out of Reach)를 고려한 중간 경유점을 자동으로 만듭니다.</p>
      ${endpoint('A', '시작')}
      ${endpoint('B', '목표')}
      <label class="toggle"><input type="checkbox" role="switch" data-opt="avoidSingularity" /><span>특이점 회피 (Singularity) — 경고 구간까지 피함</span></label>
      <div class="wp-row wp-buttons">
        <button type="button" class="btn btn-primary" data-act="plan">경로 생성</button>
        <button type="button" class="btn" data-act="cancel">취소</button>
      </div>
      <progress max="1" value="0" hidden></progress>
      <div class="plan-result" aria-live="polite"></div>
      <div class="plan-vertices" hidden>
        <div class="plan-vertices-head"><strong>자동 생성 경유점</strong><span data-count></span></div>
        <ol></ol>
      </div>
      <div class="wp-row wp-buttons">
        <button type="button" class="btn" data-act="run">▶ 실행</button>
        <button type="button" class="btn" data-act="pause">⏸ 일시정지</button>
        <button type="button" class="btn" data-act="rewind">⏮ A로 이동</button>
      </div>
      <button type="button" class="btn btn-small" data-act="save">경유점을 Waypoint 목록에 추가</button>
    </fieldset>
    <p class="hint">로봇이 A에 있지 않으면 실행 시 충돌을 피하는 경로로 A까지 먼저 이동합니다. 실행 속도는 Waypoint 재생 속도를 따릅니다.</p>`;

  const $ = (sel) => root.querySelector(sel);
  const body = $('.plan-body');
  const progress = $('progress');
  const result = $('.plan-result');
  const vertBox = $('.plan-vertices');
  const mode = { A: 'current', B: 'waypoint' };
  let ui = { status: 'idle' };

  for (const key of ['A', 'B']) {
    const box = $(`[data-end=${key}]`);
    box.querySelectorAll('[data-mode]').forEach((btn) =>
      btn.addEventListener('click', () => {
        mode[key] = btn.dataset.mode;
        renderInputs();
      }),
    );
    box.querySelector('[data-act=tcp-now]').addEventListener('click', () => fillTcp(box, getTcp()));
  }
  const optInput = $('[data-opt=avoidSingularity]');
  optInput.addEventListener('change', () =>
    setState((s) => ({ settings: { ...s.settings, planAvoidSingularity: optInput.checked } })),
  );

  const readEnd = (key) => {
    const box = $(`[data-end=${key}]`);
    const label = key === 'A' ? 'A(시작)' : 'B(목표)';
    if (mode[key] === 'current') return { spec: { type: 'current' } };
    if (mode[key] === 'waypoint') {
      const id = box.querySelector('[data-wp]').value;
      return id ? { spec: { type: 'waypoint', id } } : { error: `${label} Waypoint를 선택하세요.` };
    }
    const inputs = TCP_FIELDS.map((f) => box.querySelector(`[data-tcp=${f}]`));
    const v = inputs.map((i) => Number(i.value));
    if (inputs.some((i) => i.value === '') || !v.every(Number.isFinite)) return { error: `${label} TCP 좌표 6개를 모두 입력하세요.` };
    return { spec: { type: 'pose', pos: v.slice(0, 3), rpy: v.slice(3) } };
  };

  $('[data-act=plan]').addEventListener('click', () => {
    const a = readEnd('A'), b = readEnd('B');
    if (a.error || b.error) return setError(a.error ?? b.error);
    onPlan({ start: a.spec, goal: b.spec });
  });
  $('[data-act=cancel]').addEventListener('click', onCancel);
  $('[data-act=run]').addEventListener('click', onRun);
  $('[data-act=pause]').addEventListener('click', onPause);
  $('[data-act=rewind]').addEventListener('click', onRewind);
  $('[data-act=save]').addEventListener('click', onSaveWaypoints);

  function fillTcp(box, v) {
    TCP_FIELDS.forEach((f, i) => (box.querySelector(`[data-tcp=${f}]`).value = String(Math.round(v[i] * 10) / 10)));
  }

  function setError(text) {
    result.className = 'plan-result error';
    result.textContent = text;
  }

  /** A/B 입력 (Waypoint 목록·로봇 변경 시) */
  function renderInputs() {
    const robot = getRobot();
    const wps = robot ? getState().waypoints.filter((w) => w.robotId === robot.id) : [];
    for (const key of ['A', 'B']) {
      const box = $(`[data-end=${key}]`);
      const sel = box.querySelector('[data-wp]');
      const prev = sel.value;
      const fallback = key === 'A' ? wps[0]?.id : wps.at(-1)?.id;
      sel.replaceChildren(...(wps.length ? wps.map((w) => new Option(w.name, w.id)) : [new Option('(Waypoint 없음)', '')]));
      sel.value = wps.some((w) => w.id === prev) ? prev : fallback ?? '';
      box.querySelectorAll('[data-mode]').forEach((btn) => {
        const on = btn.dataset.mode === mode[key];
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', String(on));
      });
      box.querySelectorAll('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== mode[key]));
      if (mode[key] === 'pose' && box.querySelector('[data-tcp=X]').value === '') fillTcp(box, getTcp());
    }
    optInput.checked = getState().settings.planAvoidSingularity;
  }

  function render(next = ui) {
    ui = next;
    const enabled = getState().features.autoPathPlanning;
    root.classList.toggle('disabled', !enabled);
    body.disabled = !enabled;
    optInput.checked = getState().settings.planAvoidSingularity;
    const { status } = ui;
    const busy = status === 'planning' || status === 'approach';
    const hasPlan = ['ready', 'running', 'paused', 'approach'].includes(status) && !!ui.stats;
    $('[data-act=plan]').disabled = busy;
    $('[data-act=cancel]').disabled = !busy;
    $('[data-act=run]').disabled = !hasPlan || status === 'running' || busy;
    $('[data-act=run]').textContent = status === 'paused' ? '▶ 계속' : '▶ 실행';
    $('[data-act=pause]').disabled = status !== 'running';
    $('[data-act=rewind]').disabled = !hasPlan || busy;
    $('[data-act=save]').disabled = !hasPlan;

    progress.hidden = !busy;
    progress.value = ui.progress ?? 0;
    if (busy) {
      result.className = 'plan-result';
      result.textContent = status === 'approach' ? '현재 자세 → A 이동 경로 계산 중…' : `경로 탐색 중… ${ui.nodes ? `노드 ${ui.nodes}개` : ''}`;
    } else if (ui.error) {
      setError(ui.error);
    } else if (hasPlan) {
      const s = ui.stats;
      result.className = 'plan-result ok';
      result.textContent =
        `${s.direct ? '직선 경로' : '우회 경로'} · 계산 ${s.timeMs} ms` +
        (s.optimized?.applied ? ` · 최적화 최소여유 ${s.optimized.clearanceBefore}→${s.optimized.clearanceAfter} mm` : '') +
        ` · 이동 ${ui.duration.toFixed(1)} s (100% 기준)` +
        (ui.stale ? ' — ⚠ 계획 이후 환경이 바뀌었습니다. 다시 생성을 권장합니다.' : '');
      result.classList.toggle('stale', !!ui.stale);
    } else {
      result.className = 'plan-result';
      result.textContent = '';
    }

    // 자동 생성 경유점 목록 (A, 1, 2, …, B)
    const verts = hasPlan ? ui.vertices ?? [] : [];
    vertBox.hidden = !verts.length;
    vertBox.querySelector('[data-count]').textContent = verts.length > 2 ? `중간 ${verts.length - 2}개` : '중간 경유점 없음 (직선)';
    vertBox.querySelector('ol').innerHTML = verts
      .map((v) => `<li><span class="plan-tag${v.label === 'A' ? ' plan-tag-A' : v.label === 'B' ? ' plan-tag-B' : ''}">${v.label}</span>` +
        `<span class="plan-xyz">${v.tcp.map((x) => x.toFixed(0)).join(', ')}</span></li>`)
      .join('');
  }

  renderInputs();
  render();
  return { render, renderInputs };
}
