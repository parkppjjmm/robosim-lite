// 물리 시뮬레이션 (PRD_v.1.1.0 FR-17, FR-18): Rapier 월드 래퍼. DOM 비의존.
// RAPIER 모듈은 주입받는다 — 브라우저는 physics-loader.js, Node 테스트는 tests/lib/rapier.mjs.
// 좌표계: 로봇 베이스 기준 Z-up. 앱은 mm, Rapier는 SI(m, kg, s) → 경계에서만 변환한다.
import { rotationFromRPY } from './collision.js';

// 물체 물성 기본값 (물리 모드에서만 사용). massKg가 null이면 밀도와 부피로 질량을 정한다.
export const DEFAULT_PHYSICS = { densityKgM3: 500, massKg: null, friction: 0.6, restitution: 0.1 };
export const PHYSICS_LIMITS = {
  densityKgM3: [1, 20000],
  massKg: [0.01, 1000],
  friction: [0, 2],
  restitution: [0, 1],
};

export const MM = 0.001; // mm → m
const RAD = 180 / Math.PI;
// 범위 이탈: 바닥 아래 1 m 또는 원점에서 50 m 밖으로 나간 물체는 비활성화한다
export const OUT_OF_RANGE = { minZMm: -1000, maxRadiusMm: 50000 };
// Rapier 원기둥의 축은 로컬 Y, 앱의 원기둥 축은 로컬 Z → X축으로 +90° 돌려서 붙인다
const CYLINDER_FIX = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
export const FLOOR_FRICTION = 0.6;

/** 회전행렬(row-major 3x3) → 쿼터니언 {x, y, z, w} */
export function quatFromMatrix(R) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return { x, y, z, w };
}

/** 쿼터니언 → 회전행렬(row-major 3x3) */
export function matrixFromQuat({ x, y, z, w }) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** 회전행렬 → ZYX 오일러 [Rx, Ry, Rz] (deg, R = Rz·Ry·Rx — 장애물 rot 규약과 동일) */
export function rpyFromMatrix(R) {
  const ry = Math.atan2(-R[6], Math.hypot(R[0], R[3]));
  if (Math.abs(Math.cos(ry)) < 1e-9) return [Math.atan2(-R[5], R[4]) * RAD, ry * RAD, 0];
  return [Math.atan2(R[7], R[8]) * RAD, ry * RAD, Math.atan2(R[3], R[0]) * RAD];
}

/** 물체 하나의 충돌체 설명 (크기 mm → m, 물성 적용) */
function colliderDesc(RAPIER, ob) {
  const [sx, sy, sz] = ob.size.map((v) => v * MM);
  let desc;
  if (ob.type === 'sphere') desc = RAPIER.ColliderDesc.ball(sx / 2);
  else if (ob.type === 'cylinder') desc = RAPIER.ColliderDesc.cylinder(sz / 2, sx / 2).setRotation(CYLINDER_FIX);
  else desc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
  const ph = { ...DEFAULT_PHYSICS, ...(ob.physics ?? {}) };
  desc.setFriction(ph.friction).setRestitution(ph.restitution);
  if (ph.massKg != null) desc.setMass(ph.massKg);
  else desc.setDensity(ph.densityKgM3);
  return desc;
}

/**
 * 물리 월드. 배치(layout = 장애물 목록)로 동적 바디를 만들고, 고정 주기로 스텝한다.
 * 숨긴 장애물은 시뮬레이션하지 않는다(v1.0.0의 "숨김 = 충돌 검사 제외"와 같은 의미).
 */
export class PhysicsWorld {
  /**
   * @param {object} RAPIER init()이 끝난 Rapier 모듈
   * @param {{ gravity?: number[], dt?: number }} opts gravity: m/s² (Z-up)
   */
  constructor(RAPIER, { gravity = [0, 0, -9.81], dt = 1 / 60 } = {}) {
    this.RAPIER = RAPIER;
    this.dt = dt;
    this.world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    this.world.timestep = dt;
    // 바닥: 윗면이 Z = 0인 넓은 정적 판 (100 m × 100 m). 마찰은 물체 기본값과 같은 0.6.
    // Rapier는 맞닿은 두 면의 마찰·반발 계수를 평균(Average)해서 쓴다 → 물체 마찰 0.1이면 바닥과의 실효 마찰은 0.35.
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 50, 0.5).setTranslation(0, 0, -0.5).setFriction(FLOOR_FRICTION));
    this.objects = new Map(); // id → { body, ob }
    this.outOfRange = new Set();
    this.time = 0;
  }

  setGravity([x, y, z]) {
    this.world.gravity = { x, y, z };
    this.objects.forEach(({ body }) => body.wakeUp());
  }

  /** 배치로 물체를 (다시) 만든다. 순서는 배치 순서를 따른다(결정성). */
  load(obstacles) {
    const { RAPIER, world } = this;
    for (const { body } of this.objects.values()) world.removeRigidBody(body);
    this.objects.clear();
    this.outOfRange.clear();
    this.time = 0;
    for (const ob of obstacles) {
      if (ob.visible === false) continue;
      const [px, py, pz] = ob.pos.map((v) => v * MM);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(px, py, pz)
          .setRotation(quatFromMatrix(rotationFromRPY(ob.rot ?? [0, 0, 0])))
          .setCcdEnabled(true),
      );
      world.createCollider(colliderDesc(RAPIER, ob), body);
      this.objects.set(ob.id, { body, ob });
    }
  }

  /** 한 스텝 진행. 범위를 벗어난 물체는 비활성화한다. */
  step() {
    this.world.step();
    this.time += this.dt;
    for (const [id, { body }] of this.objects) {
      if (this.outOfRange.has(id)) continue;
      const t = body.translation();
      if (t.z / MM < OUT_OF_RANGE.minZMm || Math.hypot(t.x, t.y) / MM > OUT_OF_RANGE.maxRadiusMm) {
        body.setEnabled(false);
        this.outOfRange.add(id);
      }
    }
  }

  /**
   * 물체 현재 자세. pos: mm, R: 회전행렬(row-major 3x3), quat: {x,y,z,w}
   * @returns {Map<string, { pos: number[], R: number[], quat: object, out: boolean, sleeping: boolean }>}
   */
  poses() {
    const out = new Map();
    for (const [id, { body }] of this.objects) {
      const t = body.translation();
      const q = body.rotation();
      out.set(id, {
        pos: [t.x / MM, t.y / MM, t.z / MM],
        quat: { x: q.x, y: q.y, z: q.z, w: q.w },
        R: matrixFromQuat(q),
        out: this.outOfRange.has(id),
        sleeping: body.isSleeping(),
      });
    }
    return out;
  }

  /** 현재 자세를 배치 형식(pos mm, rot ZYX deg)으로 — "현재 상태를 배치로 저장"용 */
  layoutPose(id) {
    const p = this.poses().get(id);
    if (!p) return null;
    const round = (v, step) => Math.round(v / step) * step;
    return { pos: p.pos.map((v) => round(v, 0.1)), rot: rpyFromMatrix(p.R).map((v) => round(v, 0.01)) };
  }

  /** 움직이는(잠들지 않은) 물체 수 */
  get awakeCount() {
    let n = 0;
    for (const [id, { body }] of this.objects) if (!this.outOfRange.has(id) && !body.isSleeping()) n++;
    return n;
  }

  dispose() {
    this.world.free();
    this.objects.clear();
  }
}
