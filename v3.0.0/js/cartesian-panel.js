// 직교 조그 패널 (PRD FR-5): TCP X/Y/Z(mm), Rx/Ry/Rz(°) ± 버튼, 스텝 크기, 월드/툴 좌표계
import { getState, setState } from './state.js';

const AXES = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
const MM_STEPS = [1, 10, 50];
const DEG_STEPS = [1, 5, 15];

/**
 * @param {HTMLElement} root
 * @param {{ onJog: (axis: number, sign: 1 | -1) => void }} opts axis 0~2 = 이동, 3~5 = 회전
 * @returns {{ render: () => void }}
 */
export function mountCartesianPanel(root, { onJog }) {
  root.innerHTML = `
    <div class="cart-opts">
      <div class="segmented" role="radiogroup" aria-label="기준 좌표계">
        <button type="button" role="radio" data-frame="world">월드</button>
        <button type="button" role="radio" data-frame="tool">툴</button>
      </div>
      <label>이동 <select data-step="mm">${MM_STEPS.map((v) => `<option value="${v}">${v} mm</option>`).join('')}</select></label>
      <label>회전 <select data-step="deg">${DEG_STEPS.map((v) => `<option value="${v}">${v}°</option>`).join('')}</select></label>
    </div>
    <div class="cart-grid">
      ${AXES.map(
        (a, i) => `
        <button type="button" class="btn" data-axis="${i}" data-sign="-1" aria-label="${a} 마이너스">${a} −</button>
        <button type="button" class="btn" data-axis="${i}" data-sign="1" aria-label="${a} 플러스">${a} +</button>`,
      ).join('')}
    </div>`;

  root.querySelectorAll('[data-frame]').forEach((btn) =>
    btn.addEventListener('click', () => setState((s) => ({ settings: { ...s.settings, cartFrame: btn.dataset.frame } }))),
  );
  root.querySelector('[data-step=mm]').addEventListener('change', (e) =>
    setState((s) => ({ settings: { ...s.settings, cartStepMm: Number(e.target.value) } })),
  );
  root.querySelector('[data-step=deg]').addEventListener('change', (e) =>
    setState((s) => ({ settings: { ...s.settings, cartStepDeg: Number(e.target.value) } })),
  );
  root.querySelectorAll('[data-axis]').forEach((btn) =>
    btn.addEventListener('click', () => onJog(Number(btn.dataset.axis), Number(btn.dataset.sign))),
  );

  function render() {
    const { cartFrame, cartStepMm, cartStepDeg } = getState().settings;
    root.querySelectorAll('[data-frame]').forEach((btn) => {
      const on = btn.dataset.frame === cartFrame;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    });
    root.querySelector('[data-step=mm]').value = String(cartStepMm);
    root.querySelector('[data-step=deg]').value = String(cartStepDeg);
  }

  render();
  return { render };
}
