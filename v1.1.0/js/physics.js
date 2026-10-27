// 물리 시뮬레이션 (PRD_v.1.1.0 FR-17~19): Rapier 월드 래퍼. DOM 비의존.
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

/** 로컬 +Y 축을 dir(단위벡터)로 돌리는 쿼터니언 (Rapier 캡슐의 축은 로컬 Y) */
function quatYTo([dx, dy, dz]) {
  // q = (Y × d, 1 + Y·d) 정규화. d = −Y이면 X축으로 180°
  const w = 1 + dy;
  if (w < 1e-9) return { x: 1, y: 0, z: 0, w: 0 };
  const x = dz, y = 0, z = -dx;
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/** 링크 캡슐(a, b: mm, r: mm) → 바디 자세 (중심 m, 회전) */
function segmentPose(seg) {
  const d = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1], seg.b[2] - seg.a[2]];
  const len = Math.hypot(...d);
  const center = { x: ((seg.a[0] + seg.b[0]) / 2) * MM, y: ((seg.a[1] + seg.b[1]) / 2) * MM, z: ((seg.a[2] + seg.b[2]) / 2) * MM };
  const rot = len > 1e-6 ? quatYTo(d.map((v) => v / len)) : { x: 0, y: 0, z: 0, w: 1 };
  return { center, rot, len };
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
    this.robotBodies = []; // 로봇 링크 캡슐 (운동학 바디, FR-19)
    this.poseCache = new Map(); // poses() 결과 재사용 (매 스텝 할당을 줄여 GC 지연 방지, NFR-9)
    this.attached = null; // 파지한 물체 { id, rel(플랜지 기준 4x4, mm) } (FR-22)
    this.time = 0;
  }

  /** 물체 질량 (kg). 없으면 null */
  mass(id) {
    const o = this.objects.get(id);
    return o ? o.body.mass() : null;
  }

  /**
   * 파지 (FR-22): 물체를 운동학 바디로 바꿔 그리퍼를 따라가게 한다. 손가락과의 접촉력으로 들지 않는다(마찰 파지 근사).
   * @param rel 플랜지 좌표계에서 본 물체 자세 (4x4 row-major, mm)
   */
  attach(id, rel) {
    const o = this.objects.get(id);
    if (!o || this.outOfRange.has(id)) return false;
    if (this.attached) this.detach();
    o.body.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.attached = { id, rel };
    return true;
  }

  /**
   * 물리 재개 시(4-1, m-1): 일시정지 중 움직인 로봇 바디를 밀어내지 않고 현재 자세로 바로 옮긴다
   * (한 스텝에 큰 거리를 이동하면 물체를 통과하거나 겹친 채 남기 때문)
   */
  placeRobot(segments) {
    if (segments.length !== this.robotBodies.length) return this.setRobot(segments);
    segments.forEach((seg, i) => {
      const { center, rot } = segmentPose(seg);
      const body = this.robotBodies[i];
      body.setTranslation(center, true);
      body.setRotation(rot, true);
      body.setNextKinematicTranslation(center);
      body.setNextKinematicRotation(rot);
    });
  }

  /** 파지한 물체의 다음 스텝 자세 = 플랜지 자세 T6 × rel (teleport: 바로 옮김, 재개 시) */
  moveAttached(T6, teleport = false) {
    if (!this.attached) return;
    const o = this.objects.get(this.attached.id);
    if (!o) return;
    const r = this.attached.rel;
    const T = new Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        T[i * 4 + j] = T6[i * 4] * r[j] + T6[i * 4 + 1] * r[4 + j] + T6[i * 4 + 2] * r[8 + j] + T6[i * 4 + 3] * r[12 + j];
      }
    }
    const tr = { x: T[3] * MM, y: T[7] * MM, z: T[11] * MM };
    const q = quatFromMatrix([T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]]);
    if (teleport) {
      o.body.setTranslation(tr, true);
      o.body.setRotation(q, true);
    }
    o.body.setNextKinematicTranslation(tr);
    o.body.setNextKinematicRotation(q);
  }

  /**
   * 놓기: 다시 동적 바디로 돌리고 그리퍼 속도를 넘겨준다 (던지듯 놓으면 날아감)
   * @param linvel mm/s
   */
  detach(linvel = [0, 0, 0]) {
    if (!this.attached) return null;
    const { id } = this.attached;
    this.attached = null;
    const o = this.objects.get(id);
    if (!o) return null;
    o.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    o.body.setLinvel({ x: linvel[0] * MM, y: linvel[1] * MM, z: linvel[2] * MM }, true);
    o.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return id;
  }

  /**
   * 로봇 링크를 운동학 바디(kinematic position-based)로 등록한다 (FR-19).
   * 로봇은 위치 제어라 물체에 밀리지 않고, 움직이면 물체를 밀어낸다. 캡슐은 안전 검사와 같은 모델(linkSegments).
   * 로봇 모델을 바꾸면 다시 호출한다.
   */
  setRobot(segments) {
    const { RAPIER, world } = this;
    this.clearRobot();
    for (const seg of segments) {
      const { center, rot, len } = segmentPose(seg);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z).setRotation(rot).setCcdEnabled(true),
      );
      const r = seg.r * MM;
      const desc = len > 1 ? RAPIER.ColliderDesc.capsule((len * MM) / 2, r) : RAPIER.ColliderDesc.ball(r);
      world.createCollider(desc.setFriction(0.8), body);
      this.robotBodies.push(body);
    }
  }

  /** 다음 스텝의 로봇 링크 자세 (안전 검사를 통과해 적용된 자세의 캡슐들) */
  moveRobot(segments) {
    if (segments.length !== this.robotBodies.length) return this.setRobot(segments);
    segments.forEach((seg, i) => {
      const { center, rot } = segmentPose(seg);
      const body = this.robotBodies[i];
      body.setNextKinematicTranslation(center);
      body.setNextKinematicRotation(rot);
    });
  }

  clearRobot() {
    for (const body of this.robotBodies) this.world.removeRigidBody(body);
    this.robotBodies = [];
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
    this.poseCache.clear();
    this.outOfRange.clear();
    this.attached = null;
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
   * 반환하는 Map과 배열은 다음 호출 때 제자리에서 갱신된다(재사용). 값을 보관하려면 복사해서 쓴다.
   * @returns {Map<string, { pos: number[], R: number[], quat: object, out: boolean, sleeping: boolean }>}
   */
  poses() {
    for (const [id, { body }] of this.objects) {
      let p = this.poseCache.get(id);
      if (!p) {
        p = { pos: [0, 0, 0], R: new Array(9), quat: { x: 0, y: 0, z: 0, w: 1 }, out: false, sleeping: false };
        this.poseCache.set(id, p);
      }
      const t = body.translation();
      const q = body.rotation();
      p.pos[0] = t.x / MM; p.pos[1] = t.y / MM; p.pos[2] = t.z / MM;
      p.quat.x = q.x; p.quat.y = q.y; p.quat.z = q.z; p.quat.w = q.w;
      const R = matrixFromQuat(q);
      for (let k = 0; k < 9; k++) p.R[k] = R[k];
      p.out = this.outOfRange.has(id);
      p.sleeping = body.isSleeping();
    }
    return this.poseCache;
  }

  /** 현재 자세를 배치 형식(pos mm, rot ZYX deg)으로 — "현재 상태를 배치로 저장"용 */
  layoutPose(id) {
    const p = this.poses().get(id);
    if (!p) return null;
    // (poses()는 재사용 배열 → 아래에서 새 배열로 만들어 반환)
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
