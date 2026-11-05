// 정지 및 알람 (PRD FR-11): 알람 상태, 배너, 비프음, 알람 로그(영구 저장)
import { getState, setState } from './state.js';

const MAX_LOG = 100;
export const ALARM_LABEL = { SELF: '자기 충돌 (Self Collision)', OBSTACLE: '장애물 충돌 (Obstacle Collision)', SINGULARITY: '특이점 (Singularity)' };

let active = null;
const listeners = new Set();
let audioCtx = null;

/**
 * 알람 발생. 이미 알람 중이면 무시한다 (Reset 전까지 첫 알람 유지).
 * @param {{ types: string[], messages: string[], links: number[], obstacles: string[] }} alarm
 * @param {{ log?: boolean, sound?: boolean }} opts 저장된 자세 복원 시에는 로그·알람음 없이 잠금만 건다
 */
export function raiseAlarm(alarm, { log = true, sound = true } = {}) {
  if (active) return;
  active = { ...alarm, time: new Date().toISOString() };
  if (log) {
    setState((s) => ({
      alarmLog: [...s.alarmLog, { time: active.time, types: alarm.types, messages: alarm.messages }].slice(-MAX_LOG),
    }));
  }
  if (sound && !getState().settings.muted) beep();
  listeners.forEach((fn) => fn(active));
}

/** 사용자 Reset: 알람 해제 후 조작 허용 */
export function resetAlarm() {
  if (!active) return;
  active = null;
  listeners.forEach((fn) => fn(null));
}

/** 알람 상태 여부 (true이면 모든 모션 명령 거부) */
export function isAlarmActive() {
  return active !== null;
}

export function getActiveAlarm() {
  return active;
}

export function onAlarmChange(fn) {
  listeners.add(fn);
}

export function clearAlarmLog() {
  setState({ alarmLog: [] });
}

// 브라우저 자동재생 정책: 첫 사용자 입력(마우스 또는 키보드) 시 AudioContext를 만든다
const unlockAudio = () => {
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  removeEventListener('pointerdown', unlockAudio, true);
  removeEventListener('keydown', unlockAudio, true);
};
addEventListener('pointerdown', unlockAudio, true);
addEventListener('keydown', unlockAudio, true);

function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.2);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.2 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.2 + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.2);
    osc.stop(t0 + i * 0.2 + 0.13);
  }
}

// ---------- UI ----------

const timeText = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS

/** 상단 알람 배너 */
export function mountAlarmBanner(slot) {
  const render = (alarm) => {
    slot.replaceChildren();
    slot.classList.toggle('active', !!alarm);
    if (!alarm) return;
    const banner = document.createElement('div');
    banner.className = 'alarm-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <svg class="alarm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="currentColor"/><path d="M12 10v5M12 17.5v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
      <div class="alarm-text">
        <strong>${alarm.types.map((t) => ALARM_LABEL[t]).join(' + ')} — 로봇 정지</strong>
        <span>${alarm.messages.map(escapeHtml).join(' · ')}</span>
      </div>
      <time>${timeText(alarm.time)}</time>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-reset';
    btn.innerHTML = 'Reset <kbd>R</kbd>';
    btn.setAttribute('aria-label', '알람 해제 (Reset, 단축키 R)');
    btn.addEventListener('click', resetAlarm);
    banner.appendChild(btn);
    slot.appendChild(banner);
  };
  onAlarmChange(render);
  render(active);
}

/** 상태바 알람 로그 버튼 + 팝오버 */
export function mountAlarmLog(button, panel) {
  const render = () => {
    const log = getState().alarmLog;
    button.textContent = `알람 로그 (${log.length})`;
    if (panel.hidden) return;
    panel.innerHTML = `
      <div class="log-head"><strong>알람 로그</strong><span>최근 ${MAX_LOG}건 보관</span></div>
      ${log.length ? '' : '<p class="hint">기록된 알람이 없습니다.</p>'}
      <ol class="log-list">${log
        .slice()
        .reverse()
        .map(
          (e) => `<li><time>${new Date(e.time).toLocaleString('ko-KR', { hour12: false })}</time>
            <strong>${e.types.map((t) => ALARM_LABEL[t]).join(' + ')}</strong>
            <span>${e.messages.map(escapeHtml).join(' · ')}</span></li>`,
        )
        .join('')}</ol>`;
    if (log.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-small';
      clear.textContent = '로그 지우기';
      clear.addEventListener('click', () => confirm('알람 로그를 모두 지울까요?') && clearAlarmLog());
      panel.appendChild(clear);
    }
  };
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    render();
  });
  return render;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
