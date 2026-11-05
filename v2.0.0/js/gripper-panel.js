// 그리퍼 패널 (PRD_v.1.1.0 FR-21, FR-22): 사용 스위치, 열기/닫기, 상태, 치수(로봇별 사용자 수정)
import { GRIPPER_FIELDS, GRIPPER_LIMITS, GRIPPER_DEFAULTS } from './gripper.js';

const SIZE_LABEL = { small: '소형', medium: '중형', large: '대형' };

/**
 * @param {HTMLElement} root
 * @param {{ onToggle: (enabled: boolean) => void, onCommand: (cmd: 'open'|'close') => void,
 *           onSpecChange: (key: string, value: number) => void, onSpecReset: () => void }} opts
 * @returns {{ render: (ui) => void }}
 *   ui = { robot, enabled, spec, overridden: string[], state: 'open'|'closed'|'opening'|'closing'|'holding', opening, holdingName, physicsMode }
 */
export function mountGripperPanel(root, { onToggle, onCommand, onSpecChange, onSpecReset }) {
  root.innerHTML = `
    <label class="toggle"><input type="checkbox" role="switch" id="gripper-toggle" /><span>그리퍼 사용 (Gripper)</span></label>
    <p class="hint gr-tool-note" hidden></p>
    <div class="gr-body">
      <div class="gr-actions">
        <button type="button" class="btn btn-small" data-gr="open" title="손가락 열기 (파지 중이면 놓기)">열기 (Open)</button>
        <button type="button" class="btn btn-small" data-gr="close" title="손가락 닫기 (물리 모드: 사이에 있는 물체 파지)">닫기 (Close)</button>
        <span class="gr-state" aria-live="polite"></span>
      </div>
      <fieldset class="gr-spec">
        <legend></legend>
        ${GRIPPER_FIELDS.map(([k, label, unit]) => {
          const [lo, hi] = GRIPPER_LIMITS[k];
          const step = unit === 's' ? 0.05 : unit === 'kg' ? 0.1 : 1;
          return `<label class="field" data-field="${k}"><span>${label} <small>(${unit})</small></span>` +
            `<input type="number" min="${lo}" max="${hi}" step="${step}" data-spec="${k}" /></label>`;
        }).join('')}
        <button type="button" class="btn btn-small gr-reset" data-gr="reset">기본값으로 되돌리기</button>
      </fieldset>
      <p class="hint">치수는 로봇 모델별로 저장됩니다. 그리퍼를 켜면 TCP가 손가락 끝으로 바뀌어 TCP 표시·직교 조그·직선 보간·자동 경로 계획(TCP 지정)에 반영됩니다. 저장된 Waypoint(관절값)는 그대로입니다. 단축키 G: 열기/닫기.</p>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const toggle = $('#gripper-toggle');
  toggle.addEventListener('change', () => onToggle(toggle.checked));
  root.querySelectorAll('[data-gr]').forEach((btn) =>
    btn.addEventListener('click', () => (btn.dataset.gr === 'reset' ? onSpecReset() : onCommand(btn.dataset.gr))),
  );
  root.querySelectorAll('[data-spec]').forEach((input) =>
    input.addEventListener('change', () => {
      const k = input.dataset.spec;
      const [lo, hi] = GRIPPER_LIMITS[k];
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v)) return render();
      onSpecChange(k, Math.min(hi, Math.max(lo, v)));
    }),
  );

  let ui = null;
  function render(next = ui) {
    ui = next;
    if (!ui?.robot) return;
    toggle.checked = ui.enabled;
    // 드로스 셀의 스키머가 달려 있으면 그리퍼 설정 대신 안내만 (v1.1.1)
    const note = $('.gr-tool-note');
    note.textContent = ui.toolNote ?? '';
    note.hidden = !ui.toolNote;
    toggle.disabled = !!ui.toolNote;
    $('.gr-body').hidden = !ui.enabled || !!ui.toolNote;
    if (!ui.enabled || ui.toolNote) return;
    const base = GRIPPER_DEFAULTS[ui.robot.sizeClass] ?? GRIPPER_DEFAULTS.medium;
    $('.gr-spec legend').textContent = `치수 — ${ui.robot.name} (${SIZE_LABEL[ui.robot.sizeClass] ?? ''} 기본값 기준)`;
    root.querySelectorAll('[data-spec]').forEach((input) => {
      const k = input.dataset.spec;
      if (document.activeElement !== input) input.value = String(ui.spec[k]);
      const changed = ui.overridden.includes(k);
      input.closest('.field').classList.toggle('gr-changed', changed);
      input.title = changed ? `기본값 ${base[k]}에서 변경됨` : '기본값';
    });
    $('.gr-reset').disabled = !ui.overridden.length;
    const s = $('.gr-state');
    const w = `${ui.opening.toFixed(0)} mm`;
    s.textContent =
      ui.state === 'holding' ? `파지 중: ${ui.holdingName} (${w})`
      : ui.state === 'opening' ? `여는 중… ${w}`
      : ui.state === 'closing' ? `닫는 중… ${w}`
      : ui.state === 'closed' ? `닫힘 (${w})`
      : `열림 (${w})`;
    s.className = 'gr-state' + (ui.state === 'holding' ? ' holding' : '');
  }

  return { render };
}
