// 콘솔 진행률 막대 (2026-11-06 사용자 요청: "학습 진행율을 바를 통해서 보여줘")
// 예: [██████████░░░░░░░░░░░░░░]  42% · 경과 12분 · 남은 약 16분
// 줄 단위 출력에 앞에 붙여 쓴다(pipeline.mjs가 하위 도구 출력을 줄 단위로 걸러 보여 주므로 \r 갱신 대신 줄마다 막대).

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** 분·초 표시 */
export function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 90) return `${Math.round(sec)}초`;
  if (sec < 5400) return `${Math.round(sec / 60)}분`;
  return `${Math.floor(sec / 3600)}시간 ${Math.round((sec % 3600) / 60)}분`;
}

/** 막대만: [████░░░░]  42% */
export function bar(frac, width = 24) {
  const f = clamp01(frac);
  const n = Math.round(f * width);
  return `[${'█'.repeat(n)}${'░'.repeat(width - n)}] ${String(Math.round(f * 100)).padStart(3)}%`;
}

/**
 * 막대 + 경과·남은 시간 추정. startMs = 시작 시각(Date.now()), frac = 0~1.
 * 남은 시간 = 경과 × (1 − f) / f (진행이 고르다고 가정한 대략값)
 */
export function progressLine(frac, startMs, width = 24) {
  const f = clamp01(frac);
  const el = (Date.now() - startMs) / 1000;
  const left = f > 0.005 ? (el * (1 - f)) / f : NaN;
  return `${bar(f, width)} · 경과 ${fmtDur(el)}${f < 1 ? ` · 남은 약 ${fmtDur(left)}` : ''}`;
}
