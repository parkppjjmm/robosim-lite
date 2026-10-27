// Waypoint 패널 (PRD FR-6): 현재 자세 저장, 이름 변경, 삭제, 드래그 순서 변경, 클릭 이동, 시퀀스 재생 컨트롤
// v1.1.0 (FR-23): Waypoint 도착 동작 — 없음 / 그리퍼 열기 / 그리퍼 닫기 / 대기(초)
import { getState, setState, WAIT_LIMITS_S } from './state.js';

export const ACTION_LABEL = { none: '도착 동작 없음', open: '그리퍼 열기 (Open)', close: '그리퍼 닫기 (Close)', wait: '대기 (Wait)' };
const ACTION_ICON = { none: '', open: '열기', close: '닫기', wait: '대기' };

/**
 * @param {HTMLElement} root
 * @param {{ getRobot: () => object, getJoints: () => number[], getDefaultAction?: () => object,
 *           onMoveTo: (wp) => void, onPlay: () => void, onPause: () => void, onResume: () => void, onStop: () => void }} opts
 *   getDefaultAction: "현재 자세 저장" 시 제안할 도착 동작 (현재 그리퍼 상태 기준)
 * @returns {{ renderList: () => void, renderPlayback: (pb) => void }}
 *   pb = { status: 'idle'|'playing'|'paused', activeId, t, duration }
 */
export function mountWaypointPanel(root, { getRobot, getJoints, getDefaultAction = () => ({ type: 'none' }), onMoveTo, onPlay, onPause, onResume, onStop }) {
  root.innerHTML = `
    <button type="button" class="btn btn-small" data-act="add">+ 현재 자세 저장</button>
    <ol class="wp-list" aria-label="Waypoint 목록 (드래그로 순서 변경)"></ol>
    <div class="wp-play">
      <div class="wp-row">
        <span class="wp-label">보간</span>
        <div class="segmented" role="radiogroup" aria-label="보간 방식">
          <button type="button" role="radio" data-mode="joint">관절 (PTP)</button>
          <button type="button" role="radio" data-mode="linear">직선 (LIN)</button>
        </div>
      </div>
      <label class="wp-row">
        <span class="wp-label">속도</span>
        <input type="range" min="10" max="200" step="10" data-speed aria-label="재생 속도(%)" />
        <output data-speed-out></output>
      </label>
      <div class="wp-row wp-buttons">
        <button type="button" class="btn" data-act="play">▶ 재생</button>
        <button type="button" class="btn" data-act="pause">⏸ 일시정지</button>
        <button type="button" class="btn" data-act="stop">⏹ 정지</button>
      </div>
      <div class="wp-progress" aria-live="polite"></div>
    </div>
    <p class="hint">속도 100% = 관절 최대속도의 50% (200%에서 최대속도). 이동 버튼은 관절 보간으로 이동합니다.
      도착 동작(열기·닫기·대기)은 시퀀스 재생에서 Waypoint에 도착한 뒤 실행하고, 끝나면 다음으로 진행합니다.</p>`;

  const list = root.querySelector('.wp-list');
  const progress = root.querySelector('.wp-progress');
  const speed = root.querySelector('[data-speed]');
  const speedOut = root.querySelector('[data-speed-out]');
  const btnPlay = root.querySelector('[data-act=play]');
  const btnPause = root.querySelector('[data-act=pause]');
  const btnStop = root.querySelector('[data-act=stop]');
  let playback = { status: 'idle', activeId: null, t: 0, duration: 0 };

  // 현재 로봇의 Waypoint만 다룬다 (로봇 로드 전에는 빈 목록)
  const mine = () => (getRobot() ? getState().waypoints.filter((w) => w.robotId === getRobot().id) : []);
  const others = () => getState().waypoints.filter((w) => w.robotId !== getRobot()?.id);

  root.querySelector('[data-act=add]').addEventListener('click', () => {
    const n = mine().length + 1;
    const wp = {
      id: `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `P${n}`,
      robotId: getRobot().id,
      joints: getJoints().map((v) => Math.round(v * 100) / 100),
      action: getDefaultAction(),
    };
    setState((s) => ({ waypoints: [...s.waypoints, wp] }));
  });
  root.querySelectorAll('[data-mode]').forEach((btn) =>
    btn.addEventListener('click', () => setState((s) => ({ settings: { ...s.settings, playMode: btn.dataset.mode } }))),
  );
  speed.addEventListener('input', () => {
    speedOut.textContent = `${speed.value}%`;
    setState((s) => ({ settings: { ...s.settings, speedPct: Number(speed.value) } }));
  });
  btnPlay.addEventListener('click', () => (playback.status === 'paused' ? onResume() : onPlay()));
  btnPause.addEventListener('click', onPause);
  btnStop.addEventListener('click', onStop);

  // ---- 드래그 순서 변경 ----
  let dragId = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!dragId || !li) return;
    e.preventDefault();
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!dragId || !li || li.dataset.id === dragId) return;
    e.preventDefault();
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    const items = mine();
    const moving = items.find((w) => w.id === dragId);
    const rest = items.filter((w) => w.id !== dragId);
    let idx = rest.findIndex((w) => w.id === li.dataset.id);
    if (after) idx += 1;
    rest.splice(idx, 0, moving);
    setState({ waypoints: [...others(), ...rest] });
  });

  function renderList() {
    const items = mine();
    list.replaceChildren();
    if (!items.length) {
      list.innerHTML = '<li class="hint">저장된 Waypoint가 없습니다.</li>';
    }
    items.forEach((wp, i) => {
      const li = document.createElement('li');
      li.className = 'wp-item';
      li.dataset.id = wp.id;
      li.draggable = true;
      li.innerHTML = `
        <span class="wp-handle" aria-hidden="true" title="드래그로 순서 변경">⋮⋮</span>
        <span class="wp-index">${i + 1}</span>
        <input type="text" class="wp-name" maxlength="30" aria-label="Waypoint ${i + 1} 이름" />
        <button type="button" class="btn btn-icon" data-act="go" title="이 자세로 이동">이동</button>
        <button type="button" class="btn btn-icon" data-act="del" title="삭제">삭제</button>
        <div class="wp-action">
          <span class="wp-action-icon" data-type="${wp.action?.type ?? 'none'}">${ACTION_ICON[wp.action?.type ?? 'none']}</span>
          <select aria-label="Waypoint ${i + 1} 도착 동작">
            ${Object.entries(ACTION_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
          <input type="number" min="${WAIT_LIMITS_S[0]}" max="${WAIT_LIMITS_S[1]}" step="0.1" aria-label="대기 시간(초)" />
          <small>s</small>
        </div>`;
      li.title = `J: ${wp.joints.map((v) => v.toFixed(1)).join(', ')}`;
      const name = li.querySelector('.wp-name');
      name.value = wp.name;
      // 입력창에서는 드래그 대신 텍스트 선택이 되도록
      name.addEventListener('pointerdown', () => (li.draggable = false));
      name.addEventListener('blur', () => (li.draggable = true));
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) return (name.value = wp.name);
        setState((s) => ({ waypoints: s.waypoints.map((w) => (w.id === wp.id ? { ...w, name: v } : w)) }));
      });
      // 도착 동작 (FR-23)
      const action = wp.action ?? { type: 'none' };
      const sel = li.querySelector('.wp-action select');
      const sec = li.querySelector('.wp-action input');
      sel.value = action.type;
      sec.value = String(action.sec ?? 1);
      sec.hidden = li.querySelector('.wp-action small').hidden = action.type !== 'wait';
      const setAction = (next) => setState((s) => ({ waypoints: s.waypoints.map((w) => (w.id === wp.id ? { ...w, action: next } : w)) }));
      sel.addEventListener('change', () => setAction(sel.value === 'wait' ? { type: 'wait', sec: Number(sec.value) || 1 } : { type: sel.value }));
      sec.addEventListener('change', () => {
        const v = Number(sec.value);
        if (!Number.isFinite(v)) return (sec.value = String(action.sec ?? 1));
        setAction({ type: 'wait', sec: Math.min(WAIT_LIMITS_S[1], Math.max(WAIT_LIMITS_S[0], v)) });
      });
      for (const el of [sel, sec]) {
        el.addEventListener('pointerdown', () => (li.draggable = false));
        el.addEventListener('blur', () => (li.draggable = true));
      }
      li.querySelector('[data-act=go]').addEventListener('click', () => onMoveTo(wp));
      li.querySelector('[data-act=del]').addEventListener('click', () =>
        setState((s) => ({ waypoints: s.waypoints.filter((w) => w.id !== wp.id) })),
      );
      list.appendChild(li);
    });
    renderPlayback(playback);
  }

  function renderPlayback(pb) {
    playback = pb;
    const { playMode, speedPct } = getState().settings;
    root.querySelectorAll('[data-mode]').forEach((btn) => {
      const on = btn.dataset.mode === playMode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    });
    if (document.activeElement !== speed) speed.value = String(speedPct);
    speedOut.textContent = `${speedPct}%`;

    const count = mine().length;
    btnPlay.disabled = pb.status === 'playing' || count === 0;
    btnPlay.textContent = pb.status === 'paused' ? '▶ 계속' : '▶ 재생';
    btnPause.disabled = pb.status !== 'playing';
    btnStop.disabled = pb.status === 'idle';
    list.querySelectorAll('li[data-id]').forEach((li) => li.classList.toggle('active', li.dataset.id === pb.activeId));
    if (pb.status === 'idle') {
      progress.textContent = '';
    } else {
      const idx = mine().findIndex((w) => w.id === pb.activeId);
      const doing = pb.phase === 'action' ? `${idx + 1}/${count} ${ACTION_ICON[pb.actionType] ?? ''} 동작 중` : `${idx + 1}/${count} 이동 중`;
      progress.textContent =
        `${pb.status === 'paused' ? '일시정지' : '재생 중'} · ${idx >= 0 ? doing : ''} · ` +
        `${pb.t.toFixed(1)} / ${pb.duration.toFixed(1)} s`;
    }
  }

  renderList();
  return { renderList, renderPlayback };
}
