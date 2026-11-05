// 충돌 검사 (PRD FR-8, FR-9). DOM 비의존 — Worker(2-C 플래너)에서도 재사용한다.
// 링크는 캡슐(선분 a-b + 반경 r), 장애물은 박스(OBB) / 구 / 원기둥으로 표현한다.
// 거리는 부호 있는 거리: 양수 = 떨어진 거리, 음수 = 침투 깊이 (mm)

import { DEG } from './kinematics.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 선분-선분 최소거리 (Ericson, Real-Time Collision Detection 5.1.9) */
export function segmentSegmentDistance(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return Math.sqrt(dot(r, r));
  if (a <= 1e-9) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-9) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const diff = sub(lerp3(p1, q1, s), lerp3(p2, q2, t));
  return Math.sqrt(dot(diff, diff));
}

export function pointSegmentDistance(p, a, b) {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 > 1e-9 ? clamp01(dot(sub(p, a), ab) / len2) : 0;
  const d = sub(p, lerp3(a, b, t));
  return Math.sqrt(dot(d, d));
}

/** 회전행렬 R = Rz·Ry·Rx (deg, kinematics.rotationToRPY와 같은 규약), row-major 3x3 */
export function rotationFromRPY([rx, ry, rz]) {
  const [cx, sx] = [Math.cos(rx * DEG), Math.sin(rx * DEG)];
  const [cy, sy] = [Math.cos(ry * DEG), Math.sin(ry * DEG)];
  const [cz, sz] = [Math.cos(rz * DEG), Math.sin(rz * DEG)];
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/**
 * 장애물 목록을 검사용 형태로 변환 (월드→로컬 변환, 경계구 반경 미리 계산)
 * size는 항상 [x, y, z] 전체 치수: 구 = 지름, 원기둥 = [지름, 지름, 높이]
 */
export function compileObstacles(obstacles) {
  return obstacles.map((o) => {
    const R = rotationFromRPY(o.rot ?? [0, 0, 0]);
    const [sx, sy, sz] = o.size;
    const half = [sx / 2, sy / 2, sz / 2];
    let bound;
    if (o.type === 'sphere') bound = sx / 2;
    else if (o.type === 'cylinder') bound = Math.hypot(sx / 2, sz / 2);
    else bound = Math.hypot(...half);
    return { id: o.id, name: o.name, type: o.type, pos: o.pos, R, half, bound };
  });
}

/** 월드 점 → 장애물 로컬 좌표 (Rᵀ (p - pos)) */
function toLocal(ob, p) {
  const d = sub(p, ob.pos);
  const R = ob.R;
  return [
    R[0] * d[0] + R[3] * d[1] + R[6] * d[2],
    R[1] * d[0] + R[4] * d[1] + R[7] * d[2],
    R[2] * d[0] + R[5] * d[1] + R[8] * d[2],
  ];
}

/** 부호 있는 거리 함수 (볼록 형상 → 선분 위에서 볼록 함수) */
function sdf(ob, p) {
  const [x, y, z] = toLocal(ob, p);
  const [hx, hy, hz] = ob.half;
  if (ob.type === 'sphere') return Math.hypot(x, y, z) - hx;
  if (ob.type === 'cylinder') {
    const dr = Math.hypot(x, y) - hx;
    const dz = Math.abs(z) - hz;
    return Math.min(Math.max(dr, dz), 0) + Math.hypot(Math.max(dr, 0), Math.max(dz, 0));
  }
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** 캡슐-장애물 부호 있는 거리. 볼록 SDF의 선분 최소값을 황금분할 탐색으로 구한다. */
export function capsuleObstacleDistance(seg, ob) {
  if (ob.type === 'sphere') return pointSegmentDistance(ob.pos, seg.a, seg.b) - ob.half[0] - seg.r;
  const f = (t) => sdf(ob, lerp3(seg.a, seg.b, t));
  let lo = 0, hi = 1;
  let x1 = hi - GOLDEN * (hi - lo), x2 = lo + GOLDEN * (hi - lo);
  let f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < 24; i++) {
    if (f1 < f2) {
      hi = x2; x2 = x1; f2 = f1;
      x1 = hi - GOLDEN * (hi - lo); f1 = f(x1);
    } else {
      lo = x1; x1 = x2; f1 = f2;
      x2 = lo + GOLDEN * (hi - lo); f2 = f(x2);
    }
  }
  return Math.min(f1, f2, f(0), f(1)) - seg.r;
}

/**
 * Self collision 검사 쌍 생성 (로봇별 1회). 링크 7 = 그리퍼 몸체, 8 = 그리퍼 손가락, 9 = 파지한 물체.
 * - 인접 링크(|i-j| < 2)는 항상 맞닿아 있으므로 제외
 * - (4,6) 전완-플랜지: 짧은 손목 링크로 연결되어 관절 한계 내에서 구조적으로 닿지 않음 → 제외
 * - (2,4) 상완-전완: 짧은 엘보 링크로 연결되어 시작부가 항상 겹침 → 전완 시작부를 잘라서 검사 (접힘 감지는 유지)
 * - 손목 이후끼리(5~8)는 서로 붙어 있으므로 제외, 파지한 물체(9)는 자기 충돌 대상에서 제외
 * - (4,7),(4,8) 전완-그리퍼: 전완 캡슐 끝(손목 중심)의 반구가 플랜지 쪽으로 튀어나와 홈 자세에서도 맞닿는 근사 오차 →
 *   전완 끝을 손목 중심-플랜지 거리(d6)만큼 잘라서 검사 (손목을 크게 접어 그리퍼가 전완에 닿는 경우는 계속 감지)
 */
export function buildSelfPairs(robot, segments) {
  const r = robot.linkRadiiMm;
  const d6 = Math.abs(robot.dh[5].d);
  const pairs = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const la = segments[i].link, lb = segments[j].link;
      const [lo, hi] = la < lb ? [la, lb] : [lb, la];
      if (hi - lo < 2 || (lo === 4 && hi === 6) || lo >= 5 || hi === 9) continue;
      // 협동 로봇(UR): 실제 상완은 어깨 오프셋만큼 옆으로 나가 있어 베이스와 닿지 않는다 → 구형 손목 근사에서 생기는 0-2 오탐 제외 (v1.1.1)
      if (robot.cobot && lo === 0 && hi === 2) continue;
      const trim = lo === 2 && hi === 4 ? 1.5 * (r[1] + r[3]) : 0;
      // 전완(link 4)은 그리퍼보다 앞 순서 → i 쪽 끝을 자른다
      const trimEndI = lo === 4 && hi >= 7 && la === 4 ? d6 : 0;
      pairs.push({ i, j, trimJ: trim, trimEndI });
    }
  }
  return pairs;
}

function trimEnd(seg, len) {
  const d = sub(seg.b, seg.a);
  const L = Math.sqrt(dot(d, d));
  if (L < 1e-6 || len <= 0) return seg.b;
  return lerp3(seg.a, seg.b, Math.max(0.2, 1 - len / L));
}

function trimStart(seg, len) {
  const d = sub(seg.b, seg.a);
  const L = Math.sqrt(dot(d, d));
  if (L < 1e-6 || len <= 0) return seg.a;
  return lerp3(seg.a, seg.b, Math.min(len / L, 0.6));
}

/**
 * Self collision 검사
 * @returns {{ hit: boolean, pairs: Array<[number, number]>, dists: number[], minDistance: number }}
 *   pairs는 여유거리 안에 들어온 링크 번호 쌍, dists[k]는 pairs[k]의 거리 (mm)
 */
export function checkSelfCollision(segments, pairs, marginMm) {
  let minDistance = Infinity;
  const hits = [], dists = [];
  for (const p of pairs) {
    const A = segments[p.i], B = segments[p.j];
    const bStart = p.trimJ ? trimStart(B, p.trimJ) : B.a;
    const aEnd = p.trimEndI ? trimEnd(A, p.trimEndI) : A.b;
    const d = segmentSegmentDistance(A.a, aEnd, bStart, B.b) - A.r - B.r;
    if (d < minDistance) minDistance = d;
    if (d < marginMm) {
      hits.push([A.link, B.link]);
      dists.push(d);
    }
  }
  return { hit: hits.length > 0, pairs: hits, dists, minDistance };
}

/**
 * 장애물 + 바닥 충돌 검사
 * @param segments 링크 캡슐 (베이스 link 0은 고정 설치물이므로 제외)
 * @param compiled compileObstacles() 결과
 * @param {{ floor: boolean, skip?: (seg, ob) => boolean, skipFloor?: (seg) => boolean }} opts 바닥(z=0) 검사 여부(바닥은 링크2 이후만 검사),
 *   skip: 이 쌍은 장애물 검사에서 제외 (예: 물리 모드의 그리퍼 손가락, 파지한 물체 자신), skipFloor: 이 캡슐은 바닥 검사 제외
 * @returns {{ hit: boolean, hits: Array<{link:number, obstacleId:string, d:number}>, minDistance: number }}
 */
export function checkObstacleCollision(segments, compiled, marginMm, opts = { floor: true }) {
  let minDistance = Infinity;
  const hits = [];
  for (const seg of segments) {
    if (seg.link === 0) continue;
    if (opts.floor && seg.link >= 2 && !opts.skipFloor?.(seg)) {
      const d = Math.min(seg.a[2], seg.b[2]) - seg.r;
      if (d < minDistance) minDistance = d;
      if (d < marginMm) hits.push({ link: seg.link, obstacleId: 'floor', d });
    }
    for (const ob of compiled) {
      if (opts.skip?.(seg, ob)) continue;
      // 경계구로 빠른 제외 (하한 거리)
      const lower = pointSegmentDistance(ob.pos, seg.a, seg.b) - ob.bound - seg.r;
      if (lower > marginMm) {
        if (lower < minDistance) minDistance = lower;
        continue;
      }
      const d = capsuleObstacleDistance(seg, ob);
      if (d < minDistance) minDistance = d;
      if (d < marginMm) hits.push({ link: seg.link, obstacleId: ob.id, d });
    }
  }
  return { hit: hits.length > 0, hits, minDistance };
}
