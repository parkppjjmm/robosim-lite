// 장애물 관리 패널 (PRD FR-7): 추가 / 선택 / 이름변경 / 표시·숨김 / 삭제 / 수치 편집, 바닥 on/off
// 3D 기즈모 편집은 viewer.js(TransformControls)에서 처리하고, 결과는 같은 state.obstacles로 들어온다.
import { getState, setState } from './state.js';

const OBSTACLE_TYPE_LABEL = { box: '박스', sphere: '구', cylinder: '원기둥' };

// 형상별 편집 필드: size = [x, y, z] 전체 치수 (구 = 지름, 원기둥 = 지름·높이)
const SIZE_FIELDS = {
  box: [['가로 X', 0], ['세로 Y', 1], ['높이 Z', 2]],
  sphere: [['지름', 0]],
  cylinder: [['지름', 0], ['높이', 2]],
};

const round10 = (v) => Math.round(v / 10) * 10;

/**
 * @param {HTMLElement} root
 * @param {{ getRobot: () => object, onSelect: (id: string|null) => void }} opts
 * @returns {{ render: () => void, select: (id: string|null) => void }}
 */
export function mountObstaclePanel(root, { getRobot, onSelect }) {
  let selectedId = null;
  let editorFor = undefined; // 현재 그려진 편집기의 장애물 id (입력 중 재렌더링으로 포커스 잃지 않도록)

  root.innerHTML = `
    <div class="ob-add" role="group" aria-label="장애물 추가">
      <button type="button" class="btn btn-small" data-add="box">+ 박스</button>
      <button type="button" class="btn btn-small" data-add="sphere">+ 구</button>
      <button type="button" class="btn btn-small" data-add="cylinder">+ 원기둥</button>
    </div>
    <label class="toggle"><input type="checkbox" role="switch" id="floor-toggle" /><span>바닥 충돌 검사 (Floor, Z = 0)</span></label>
    <ul class="ob-list" aria-label="장애물 목록"></ul>
    <div class="ob-editor"></div>
    <p class="hint">숨긴 장애물은 충돌 검사에서 제외됩니다.</p>`;
  const list = root.querySelector('.ob-list');
  const editor = root.querySelector('.ob-editor');
  const floorToggle = root.querySelector('#floor-toggle');

  root.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => addObstacle(btn.dataset.add)),
  );
  floorToggle.addEventListener('change', () =>
    setState((s) => ({ settings: { ...s.settings, floorEnabled: floorToggle.checked } })),
  );

  const updateObstacle = (id, patch) =>
    setState((s) => ({ obstacles: s.obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));

  function select(id) {
    selectedId = id;
    onSelect(id);
    render();
  }

  function addObstacle(type) {
    const R = getRobot().reachMm;
    const { obstacles } = getState();
    // 로봇 정면(+X)을 피해 원주 방향으로 돌아가며 배치, 바닥 위에 올려 둔다
    const angle = ((35 + 30 * obstacles.length) % 360) * (Math.PI / 180);
    const size =
      type === 'sphere' ? Array(3).fill(round10(R * 0.25))
      : type === 'cylinder' ? [round10(R * 0.2), round10(R * 0.2), round10(R * 0.6)]
      : [round10(R * 0.25), round10(R * 0.25), round10(R * 0.6)];
    const n = obstacles.filter((o) => o.type === type).length + 1;
    const ob = {
      id: `ob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${OBSTACLE_TYPE_LABEL[type]} ${n}`,
      type,
      pos: [round10(Math.cos(angle) * R * 0.8), round10(Math.sin(angle) * R * 0.8), size[2] / 2],
      size,
      rot: [0, 0, 0],
      visible: true,
    };
    selectedId = ob.id;
    setState({ obstacles: [...obstacles, ob] });
    onSelect(ob.id);
  }

  function renderList() {
    const { obstacles } = getState();
    list.replaceChildren();
    if (!obstacles.length) {
      list.innerHTML = '<li class="hint">장애물이 없습니다.</li>';
      return;
    }
    for (const ob of obstacles) {
      const li = document.createElement('li');
      li.className = 'ob-row' + (ob.id === selectedId ? ' selected' : '') + (ob.visible === false ? ' hidden-ob' : '');
      li.innerHTML = `
        <button type="button" class="ob-name" aria-pressed="${ob.id === selectedId}">
          <span class="ob-type">${OBSTACLE_TYPE_LABEL[ob.type]}</span><span></span>
        </button>
        <button type="button" class="btn btn-icon" data-act="vis" aria-label="${ob.visible === false ? '표시' : '숨김'}"
          title="${ob.visible === false ? '표시 (충돌 검사 포함)' : '숨김 (충돌 검사 제외)'}">${ob.visible === false ? '표시' : '숨김'}</button>
        <button type="button" class="btn btn-icon" data-act="del" aria-label="${'삭제'}" title="삭제">삭제</button>`;
      li.querySelector('.ob-name span:last-child').textContent = ob.name; // 사용자 입력 → textContent
      li.querySelector('.ob-name').addEventListener('click', () => select(ob.id === selectedId ? null : ob.id));
      li.querySelector('[data-act=vis]').addEventListener('click', () => updateObstacle(ob.id, { visible: ob.visible === false }));
      li.querySelector('[data-act=del]').addEventListener('click', () => {
        if (selectedId === ob.id) select(null);
        setState((s) => ({ obstacles: s.obstacles.filter((o) => o.id !== ob.id) }));
      });
      list.appendChild(li);
    }
  }

  function renderEditor() {
    const ob = getState().obstacles.find((o) => o.id === selectedId);
    editorFor = ob?.id ?? null;
    editor.replaceChildren();
    if (!ob) return;

    const field = (label, value, onCommit, { min } = {}) => {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      wrap.innerHTML = `<span>${label}</span><input type="number" step="10" ${min !== undefined ? `min="${min}"` : ''} />`;
      const input = wrap.querySelector('input');
      input.value = String(value);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (input.value === '' || !Number.isFinite(v) || (min !== undefined && v < min)) {
          input.value = String(value);
          return;
        }
        value = v;
        onCommit(v);
      });
      return wrap;
    };
    const group = (title, children) => {
      const fs = document.createElement('fieldset');
      fs.innerHTML = `<legend>${title}</legend>`;
      children.forEach((c) => fs.appendChild(c));
      return fs;
    };
    const vecField = (key, i, label, opts) =>
      field(label, ob[key][i], (v) => {
        const cur = getState().obstacles.find((o) => o.id === ob.id);
        const next = cur[key].slice();
        next[i] = v;
        if (key === 'size' && ob.type === 'sphere') next.fill(v);
        if (key === 'size' && ob.type === 'cylinder' && i === 0) next[1] = v;
        updateObstacle(ob.id, { [key]: next });
      }, opts);

    const nameWrap = document.createElement('label');
    nameWrap.className = 'field field-wide';
    nameWrap.innerHTML = '<span>이름</span><input type="text" maxlength="40" />';
    const nameInput = nameWrap.querySelector('input');
    nameInput.value = ob.name;
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim();
      if (!name) return (nameInput.value = ob.name);
      updateObstacle(ob.id, { name });
    });

    editor.append(
      nameWrap,
      group('위치 (mm)', ['X', 'Y', 'Z'].map((l, i) => vecField('pos', i, l))),
      group('크기 (mm)', SIZE_FIELDS[ob.type].map(([l, i]) => vecField('size', i, l, { min: 1 }))),
    );
    if (ob.type !== 'sphere') {
      editor.append(group('회전 (°, Rz·Ry·Rx)', ['Rx', 'Ry', 'Rz'].map((l, i) => vecField('rot', i, l))));
    }
  }

  function render() {
    const { obstacles, settings } = getState();
    if (selectedId && !obstacles.some((o) => o.id === selectedId)) {
      selectedId = null;
      onSelect(null);
    }
    floorToggle.checked = settings.floorEnabled;
    renderList();
    // 같은 장애물을 편집 중이면 편집기는 다시 그리지 않는다 (입력 포커스 유지)
    if (editorFor !== selectedId || !editor.contains(document.activeElement)) renderEditor();
  }

  render();
  return { render, select };
}
