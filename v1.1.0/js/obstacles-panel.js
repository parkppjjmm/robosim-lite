// 장애물(물체) 관리 패널 (PRD FR-7): 추가 / 선택 / 이름변경 / 표시·숨김 / 삭제 / 수치 편집, 바닥 on/off
// v1.1.0 (PRD_v.1.1.0 FR-18·20): 시뮬레이션 모드(고정/물리) 스위치, 물리 컨트롤, 물체 물성 편집.
// 모드는 시뮬레이션 전체 단위로만 고른다 — 물체별 고정/물리 선택은 없다(규칙 0).
// 3D 기즈모 편집은 viewer.js(TransformControls)에서 처리하고, 결과는 같은 state.obstacles(배치)로 들어온다.
import { getState, setState } from './state.js';
import { DEFAULT_PHYSICS, PHYSICS_LIMITS } from './physics.js';

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
 * @param {{ getRobot: () => object, onSelect: (id: string|null) => void,
 *           onSimMode: (mode) => void, onPhysicsToggle: () => void, onPhysicsReset: () => void, onSaveLayout: () => void }} opts
 * @returns {{ render: () => void, select: (id: string|null) => void, renderSim: (ui) => void }}
 *   ui = { mode: 'static'|'physics', loading, error, running, layoutChanged, awake, total, outOfRange: Set<id> }
 */
export function mountObstaclePanel(root, { getRobot, onSelect, onSimMode, onPhysicsToggle, onPhysicsReset, onSaveLayout }) {
  let selectedId = null;
  let editorFor = undefined; // 현재 그려진 편집기의 장애물 id (입력 중 재렌더링으로 포커스 잃지 않도록)
  let simUI = { mode: 'static', outOfRange: new Set() };

  root.innerHTML = `
    <div class="sim-mode">
      <div class="sim-mode-head">
        <span>시뮬레이션 모드</span>
        <div class="segmented" role="radiogroup" aria-label="시뮬레이션 모드 (Simulation Mode)">
          <button type="button" role="radio" data-sim="static" title="모든 물체 고정 (v1.0.0과 동일)">고정 (Static)</button>
          <button type="button" role="radio" data-sim="physics" title="모든 물체에 중력·충돌 적용">물리 (Physics)</button>
        </div>
      </div>
      <div class="sim-controls" hidden>
        <button type="button" class="btn btn-small" data-phys="toggle">⏸ 일시정지</button>
        <button type="button" class="btn btn-small" data-phys="reset" title="물체를 배치 위치로 되돌림">↺ 리셋</button>
        <button type="button" class="btn btn-small" data-phys="save" title="지금 물체 위치를 새 배치로 저장">현재 상태를 배치로 저장</button>
      </div>
      <p class="sim-status" aria-live="polite"></p>
    </div>
    <div class="ob-add" role="group" aria-label="장애물 추가">
      <button type="button" class="btn btn-small" data-add="box">+ 박스</button>
      <button type="button" class="btn btn-small" data-add="sphere">+ 구</button>
      <button type="button" class="btn btn-small" data-add="cylinder">+ 원기둥</button>
    </div>
    <label class="toggle"><input type="checkbox" role="switch" id="floor-toggle" /><span>바닥 충돌 검사 (Floor, Z = 0)</span></label>
    <ul class="ob-list" aria-label="장애물 목록"></ul>
    <div class="ob-editor"></div>
    <p class="hint">숨긴 장애물은 충돌 검사와 물리 시뮬레이션에서 제외됩니다. 물리 모드에서 편집한 값은 배치에 저장되고, 리셋하면 반영됩니다.</p>`;
  const list = root.querySelector('.ob-list');
  const editor = root.querySelector('.ob-editor');
  const floorToggle = root.querySelector('#floor-toggle');

  root.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => addObstacle(btn.dataset.add)),
  );
  root.querySelectorAll('[data-sim]').forEach((btn) => btn.addEventListener('click', () => onSimMode(btn.dataset.sim)));
  root.querySelector('[data-phys=toggle]').addEventListener('click', onPhysicsToggle);
  root.querySelector('[data-phys=reset]').addEventListener('click', onPhysicsReset);
  root.querySelector('[data-phys=save]').addEventListener('click', onSaveLayout);
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
      physics: { ...DEFAULT_PHYSICS },
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
      const lost = simUI.mode === 'physics' && simUI.outOfRange?.has(ob.id);
      li.innerHTML = `
        <button type="button" class="ob-name" aria-pressed="${ob.id === selectedId}">
          <span class="ob-type">${OBSTACLE_TYPE_LABEL[ob.type]}</span>${lost ? '<span class="ob-type ob-lost" title="바닥 아래로 떨어지거나 멀리 날아가 시뮬레이션에서 제외됨">범위 이탈</span>' : ''}<span></span>
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
    editor.append(physicsGroup(ob));
  }

  /** 물성 편집 (물리 모드에서만 사용). 질량 칸이 비어 있으면 밀도와 부피로 질량을 계산한다. */
  function physicsGroup(ob) {
    const ph = { ...DEFAULT_PHYSICS, ...(ob.physics ?? {}) };
    const commit = (patch) => {
      const cur = getState().obstacles.find((o) => o.id === ob.id);
      updateObstacle(ob.id, { physics: { ...DEFAULT_PHYSICS, ...(cur.physics ?? {}), ...patch } });
    };
    const volumeM3 = () => {
      const [x, y, z] = ob.size.map((v) => v / 1000);
      if (ob.type === 'sphere') return (Math.PI / 6) * x * x * x;
      if (ob.type === 'cylinder') return (Math.PI / 4) * x * x * z;
      return x * y * z;
    };
    const fs = document.createElement('fieldset');
    fs.className = 'ob-physics';
    fs.innerHTML = '<legend>물성 (물리 모드)</legend>';
    const numField = (label, key, step, allowEmpty) => {
      const [lo, hi] = PHYSICS_LIMITS[key];
      const wrap = document.createElement('label');
      wrap.className = 'field';
      wrap.innerHTML = `<span>${label}</span><input type="number" step="${step}" min="${lo}" max="${hi}" ${allowEmpty ? 'placeholder="자동"' : ''} />`;
      const input = wrap.querySelector('input');
      input.value = ph[key] == null ? '' : String(ph[key]);
      input.addEventListener('change', () => {
        if (allowEmpty && input.value === '') return commit({ [key]: null });
        const v = Number(input.value);
        if (input.value === '' || !Number.isFinite(v) || v < lo || v > hi) {
          input.value = ph[key] == null ? '' : String(ph[key]);
          return;
        }
        commit({ [key]: v });
      });
      return wrap;
    };
    fs.append(
      numField('밀도 kg/m³', 'densityKgM3', 50),
      numField('질량 kg', 'massKg', 0.1, true),
      numField('마찰', 'friction', 0.05),
      numField('반발', 'restitution', 0.05),
    );
    const mass = ph.massKg ?? ph.densityKgM3 * volumeM3();
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `질량 ${mass < 10 ? mass.toFixed(2) : mass.toFixed(1)} kg${ph.massKg == null ? ' (밀도 × 부피)' : ' (지정값)'} · 마찰·반발은 맞닿은 두 면의 평균으로 적용`;
    fs.append(note);
    return fs;
  }

  /** 시뮬레이션 모드·물리 컨트롤 표시 */
  function renderSim(next = simUI) {
    simUI = next;
    const physics = simUI.mode === 'physics';
    root.querySelectorAll('[data-sim]').forEach((btn) => {
      const on = btn.dataset.sim === simUI.mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
      btn.disabled = !!simUI.loading;
    });
    root.querySelector('.sim-controls').hidden = !physics || !!simUI.loading;
    root.querySelector('[data-phys=toggle]').textContent = simUI.running ? '⏸ 일시정지' : '▶ 실행';
    root.querySelector('[data-phys=reset]').classList.toggle('btn-attention', !!simUI.layoutChanged);
    const status = root.querySelector('.sim-status');
    status.className = 'sim-status' + (simUI.error ? ' error' : simUI.layoutChanged ? ' warn' : '');
    status.textContent = simUI.loading
      ? '물리엔진(Rapier) 불러오는 중…'
      : simUI.error
        ? simUI.error
        : physics
          ? (simUI.layoutChanged ? '배치가 바뀌었습니다 — 리셋하면 반영됩니다. ' : '') +
            `물체 ${simUI.total ?? 0}개 · 움직이는 물체 ${simUI.awake ?? 0}개${simUI.outOfRange?.size ? ` · 범위 이탈 ${simUI.outOfRange.size}개` : ''}${simUI.running ? '' : ' · 일시정지'}` +
            (simUI.pushMode ? ' · 장애물 감지 OFF: 로봇이 물체를 밀어냄' : ' · 장애물 감지 ON: 닿기 전에 정지')
          : '모든 물체가 배치 위치에 고정됩니다 (v1.0.0과 동일).';
    renderList();
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
  renderSim();
  return { render, select, renderSim };
}
