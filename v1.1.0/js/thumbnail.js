// 모델 카드용 SVG 실루엣 썸네일. 근사 모델(DH)의 홈 자세를 옆에서 본 모습(X-Z 평면)을 그린다.
// 크기 차이가 보이도록 도달거리의 로그 비율로 그림 크기를 정한다 (소형 ≈ 절반, 대형 = 꽉 참).
import { forwardKinematics, homeJoints, linkSegments, origin } from './kinematics.js';

const W = 120, H = 96, GROUND = 88, PAD = 6;

/**
 * @param {object} robot 카탈로그 로봇
 * @param {{ minReach: number, maxReach: number }} range 카탈로그 전체 도달거리 범위
 * @returns {string} SVG 마크업 (색은 CSS 변수 --thumb-edge / --thumb-dark 사용)
 */
export function robotThumbnail(robot, { minReach, maxReach }) {
  const { frames } = forwardKinematics(robot, homeJoints(robot));
  const segs = linkSegments(robot, frames);
  // 옆모습: 로봇 X → 오른쪽, Z → 위
  const xs = segs.flatMap((s) => [s.a[0] - s.r, s.a[0] + s.r, s.b[0] - s.r, s.b[0] + s.r]);
  const zs = segs.flatMap((s) => [s.a[2], s.b[2] + s.r]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), maxZ = Math.max(...zs);

  const t = maxReach > minReach ? Math.log(robot.reachMm / minReach) / Math.log(maxReach / minReach) : 1;
  const fill = 0.5 + 0.5 * t;
  const s = fill * Math.min((W - 2 * PAD) / (maxX - minX), (GROUND - PAD) / maxZ);
  const ox = W / 2 - ((minX + maxX) / 2) * s;
  const P = (p) => `${(ox + p[0] * s).toFixed(1)},${(GROUND - p[2] * s).toFixed(1)}`;

  const body = robot.color;
  const lines = segs.map((seg) => {
    const w = Math.max(2, 2 * seg.r * s);
    const color = seg.link === 0 || seg.link === 6 ? 'var(--thumb-dark)' : body;
    return { d: `M${P(seg.a)}L${P(seg.b)}`, w, color };
  });
  const r = robot.linkRadiiMm;
  const joints = [[origin(frames[1]), r[1]], [origin(frames[2]), r[2]]].map(
    ([p, rr]) => `<circle cx="${(ox + p[0] * s).toFixed(1)}" cy="${(GROUND - p[2] * s).toFixed(1)}" r="${Math.max(1.5, rr * 1.15 * s).toFixed(1)}" fill="var(--thumb-dark)" stroke="var(--thumb-edge)" stroke-width="1"/>`,
  );
  return `<svg class="thumb" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="M4 ${GROUND + 0.5}H${W - 4}" stroke="var(--thumb-edge)" stroke-width="1"/>
    ${[...Array(12)].map((_, i) => `<path d="M${10 + i * 9} ${GROUND + 1}l-4 5" stroke="var(--thumb-edge)" stroke-width="0.8" opacity="0.6"/>`).join('')}
    <g fill="none" stroke-linecap="round">
      ${lines.map((l) => `<path d="${l.d}" stroke="var(--thumb-edge)" stroke-width="${(l.w + 2).toFixed(1)}"/>`).join('')}
      ${lines.map((l) => `<path d="${l.d}" stroke="${l.color}" stroke-width="${l.w.toFixed(1)}"/>`).join('')}
    </g>
    ${joints.join('')}
  </svg>`;
}
