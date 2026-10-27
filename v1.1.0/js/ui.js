// 화면 공통 동작 (3단계): 테마 전환, 섹션 접기, 좁은 화면 드로어, 키보드 단축키, 아이콘
import { getState, setState } from './state.js';

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  selfCollision: svg('<rect x="3" y="9" width="11" height="6" rx="3"/><rect x="10" y="4" width="6" height="11" rx="3" transform="rotate(35 13 9.5)"/><path d="M17 17l3 3M20 17l-3 3"/>'),
  obstacleCollision: svg('<path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  singularity: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>'),
  autoPathPlanning: svg('<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M6.5 16.5C9 9 14 15 17.5 7.5" stroke-dasharray="2.5 2.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>'),
  models: svg('<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  controls: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
};

// ---------- 테마 ----------

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

/**
 * 테마 전환 버튼. onChange(theme)는 3D 뷰 색 갱신용.
 * 반환하는 render()는 settings.theme이 바뀔 때마다 호출자가 부른다 (버튼 클릭, 가져오기, 초기화 공통).
 */
export function mountThemeToggle(button, onChange) {
  const render = () => {
    const { theme } = getState().settings;
    applyTheme(theme);
    const next = theme === 'dark' ? 'light' : 'dark';
    button.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
    button.setAttribute('aria-label', next === 'light' ? '라이트 테마로 전환' : '다크 테마로 전환');
    button.title = button.getAttribute('aria-label');
    onChange(theme);
  };
  button.addEventListener('click', () => {
    setState((s) => ({ settings: { ...s.settings, theme: s.settings.theme === 'dark' ? 'light' : 'dark' } }));
  });
  render();
  return render;
}

// ---------- 섹션 접기 ----------

/** <section class="sec" data-sec="key"> 의 헤더 버튼으로 본문을 접고 펼친다. 상태는 settings.collapsed에 저장. */
export function mountSections(root) {
  const sections = [...root.querySelectorAll('.sec[data-sec]')];
  for (const sec of sections) {
    const btn = sec.querySelector('.sec-toggle');
    btn.insertAdjacentHTML('beforeend', `<span class="sec-chevron">${ICONS.chevron}</span>`);
    btn.addEventListener('click', () => {
      const key = sec.dataset.sec;
      setState((s) => {
        const collapsed = { ...s.settings.collapsed };
        if (collapsed[key]) delete collapsed[key];
        else collapsed[key] = true;
        return { settings: { ...s.settings, collapsed } };
      });
      render();
    });
  }
  function render() {
    const { collapsed } = getState().settings;
    // (가져오기/초기화로 상태가 통째로 바뀔 때도 호출된다)
    for (const sec of sections) {
      const closed = !!collapsed[sec.dataset.sec];
      sec.classList.toggle('collapsed', closed);
      sec.querySelector('.sec-toggle').setAttribute('aria-expanded', String(!closed));
    }
  }
  render();
  return render;
}

// ---------- 드로어 (1024px 이하) ----------

export function mountDrawers() {
  const backdrop = document.getElementById('drawer-backdrop');
  const buttons = [...document.querySelectorAll('[data-drawer]')];
  const panelOf = (btn) => document.getElementById(btn.getAttribute('aria-controls'));
  const close = () => {
    buttons.forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
      panelOf(b).classList.remove('open');
    });
    backdrop.hidden = true;
  };
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      const wasOpen = btn.getAttribute('aria-expanded') === 'true';
      close();
      if (wasOpen) return;
      btn.setAttribute('aria-expanded', 'true');
      panelOf(btn).classList.add('open');
      backdrop.hidden = false;
    }),
  );
  backdrop.addEventListener('click', close);
  // 넓은 화면으로 돌아가면 드로어 상태 해제
  matchMedia('(min-width: 1025px)').addEventListener('change', (e) => e.matches && close());
  return { close, isOpen: () => !backdrop.hidden };
}

// ---------- 단축키 ----------

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);
const isTyping = (el) =>
  !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.tagName === 'INPUT' && TEXT_INPUTS.has(el.type)));
// Space가 원래 동작(클릭/토글)을 하는 요소
const spaceActivates = (el) =>
  !!el && (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')));

/**
 * Space = 재생/일시정지, Esc = 정지, R = 알람 Reset.
 * 글자 입력 중이면 Esc 외에는 무시하고, 버튼/체크박스에 포커스가 있으면 Space는 그 요소의 기본 동작에 맡긴다.
 */
export function mountShortcuts({ onPlayPause, onStop, onReset, onGripper }) {
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const el = document.activeElement;
    const typing = isTyping(el);
    if (e.key === 'Escape') {
      if (typing) el.blur();
      onStop();
      return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      if (spaceActivates(el)) return;
      e.preventDefault();
      onPlayPause();
    } else if (e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') {
      onReset();
    } else if (onGripper && (e.key === 'g' || e.key === 'G' || e.key === 'ㅎ')) {
      onGripper(); // 그리퍼 열기/닫기 (v1.1.0)
    }
  });
}
