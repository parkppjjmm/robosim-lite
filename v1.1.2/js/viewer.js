// Three.js 3D 뷰. 로봇 좌표계(Z-up, mm)를 루트 그룹 회전으로 Three.js(Y-up)에 맞춘다.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { linkSegments, origin, axisZ, multiply, DEG } from './kinematics.js';
import { toolMatrix } from './gripper.js';

const Y_UP = new THREE.Vector3(0, 1, 0);
const ALARM_COLOR = new THREE.Color('#ff2a2a');
const SELECT_COLOR = new THREE.Color('#3d9be9');
const BLACK = new THREE.Color(0x000000);
const RAD = 180 / Math.PI;
const round = (v, step) => Math.round(v / step) * step;

// 테마별 3D 색상 (CSS 토큰과 톤을 맞춘다)
const PALETTES = {
  dark: {
    bg: '#14181d', gridMajor: '#4a535e', gridMinor: '#242a31', sky: '#dfe8f5', ground: '#30343a', shadow: 0.35,
    obstacle: '#8fa3ba', edge: '#c8d4e2', selectEdge: '#7cc0ff', path: '#e056fd',
  },
  light: {
    bg: '#dce2e9', gridMajor: '#8e99a6', gridMinor: '#c2cad3', sky: '#ffffff', ground: '#8f99a4', shadow: 0.2,
    obstacle: '#7f95ae', edge: '#3f5670', selectEdge: '#1570d6', path: '#a91ccc',
  },
};
const AXIS_COLORS = [['X', '#e5484d'], ['Y', '#30a46c'], ['Z', '#1c8cf0']];
const AXIS_VIEW_PX = 88;

// 로봇 좌표(x, y, z) ↔ Three 월드 좌표(x, z, -y)
const toWorld = ([x, y, z]) => new THREE.Vector3(x, z, -y);
const fromWorld = (v) => [v.x, -v.z, v.y];

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.palette = PALETTES.dark;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.palette.bg);

    this.camera = new THREE.PerspectiveCamera(45, 1, 5, 100000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.cameraListeners = new Set();
    this.controls.addEventListener('end', () => this.cameraListeners.forEach((fn) => fn(this.getCamera())));

    this.hemi = new THREE.HemisphereLight(this.palette.sky, this.palette.ground, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffffff', 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun, this.sun.target);

    this.root = new THREE.Group(); // 로봇 좌표계 (Z-up)
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);

    this.envGroup = new THREE.Group(); // 바닥/그리드 (Three 월드 좌표)
    this.scene.add(this.envGroup);

    this.robotGroup = null;
    this.parts = [];

    this.obstacleGroup = new THREE.Group(); // 장애물 (로봇 좌표계)
    this.root.add(this.obstacleGroup);
    this.obstacleMeshes = new Map();
    this.highlight = { links: new Set(), obstacles: new Set() };
    this.selectedObstacleId = null;

    // 장애물 3D 편집 기즈모. 로컬 좌표 기준이라 축 라벨이 로봇 좌표(X/Y/Z, Z-up)와 일치한다.
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSpace('local');
    this.transform.setSize(0.8);
    this.scene.add(this.transform);
    this.transformListeners = new Set();
    this.pickListeners = new Set();
    this.dragListeners = new Set();
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value; // 기즈모 드래그 중 카메라 회전 비활성화
      if (!e.value && this.transform.object) this.emitTransform(this.transform.object);
    });
    // 드래그 중: 확정 전 미리보기용으로 현재 형상을 알린다 (상태 저장/알람은 드래그를 놓을 때)
    this.transform.addEventListener('objectChange', () => {
      const mesh = this.transform.object;
      if (!this.transform.dragging || !mesh) return;
      const ob = mesh.userData.obstacle;
      this.dragListeners.forEach((fn) => fn(ob.id, this.transformPatch(mesh)));
    });
    this.setupPicking();

    this.waypointGroup = new THREE.Group(); // Waypoint TCP 마커 (로봇 좌표계)
    this.root.add(this.waypointGroup);
    this.planGroup = new THREE.Group(); // 계획 경로 TCP 궤적 미리보기 (로봇 좌표계)
    this.root.add(this.planGroup);
    this.cellGroup = new THREE.Group(); // 드로스 셀 설비·욕면 (v1.1.1, 로봇 좌표계)
    this.root.add(this.cellGroup);
    this.cell = null;
    this.cellMeshes = new Map(); // 설비 id → 메쉬 (충돌 하이라이트)
    this.drossMesh = null; // 드로스 입자 (InstancedMesh)
    this.extraRigs = new Map(); // 측면 로봇 (v1.1.1): id → { group, parts, tool, robot }

    this.initAxisView();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** 좌측 하단 좌표축 표시 (로봇 좌표계 X/Y/Z, 메인 카메라 방향을 따라 회전) */
  initAxisView() {
    this.axisScene = new THREE.Scene();
    this.axisCamera = new THREE.OrthographicCamera(-1.55, 1.55, 1.55, -1.55, 0.1, 10);
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2; // 로봇 좌표계 (Z-up)
    AXIS_COLORS.forEach(([name, color], i) => {
      const dir = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      const mat = new THREE.MeshBasicMaterial({ color });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.8, 10), mat);
      shaft.position.copy(dir).multiplyScalar(0.4);
      shaft.quaternion.setFromUnitVectors(Y_UP, dir);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 14), mat);
      tip.position.copy(dir).multiplyScalar(0.92);
      tip.quaternion.setFromUnitVectors(Y_UP, dir);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(name, color), depthTest: false }));
      label.position.copy(dir).multiplyScalar(1.3);
      label.scale.setScalar(0.5);
      group.add(shaft, tip, label);
    });
    this.axisScene.add(group);
  }

  /** 테마 전환: 배경/그리드/조명/장애물/경로 색 갱신 */
  setTheme(theme) {
    this.palette = PALETTES[theme] ?? PALETTES.dark;
    this.scene.background.set(this.palette.bg);
    this.hemi.color.set(this.palette.sky);
    this.hemi.groundColor.set(this.palette.ground);
    if (this.robot) this.buildEnvironment(this.robot);
    for (const mesh of this.obstacleMeshes.values()) mesh.material.color.set(this.palette.obstacle);
    this.applyHighlights();
    this.planGroup.traverse((o) => o.userData.pathPart && o.material.color.set(this.palette.path));
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildEnvironment(robot) {
    disposeChildren(this.envGroup);
    const size = Math.max(4000, Math.ceil((robot.reachMm * 3) / 1000) * 1000);
    const { gridMajor, gridMinor, shadow } = this.palette;
    // 100 mm 보조 그리드 + 1 m 주 그리드
    const minor = new THREE.GridHelper(size, size / 100, gridMinor, gridMinor);
    const major = new THREE.GridHelper(size, size / 1000, gridMajor, gridMajor);
    for (const g of [minor, major]) {
      g.material.transparent = true;
      g.material.opacity = g === major ? 0.9 : 0.75;
      g.material.depthWrite = false;
      this.envGroup.add(g);
    }
    major.position.y = 0.3;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.ShadowMaterial({ opacity: shadow }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.envGroup.add(ground);

    // 바닥 충돌 하이라이트
    this.floorAlarm = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: ALARM_COLOR, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.floorAlarm.rotation.x = -Math.PI / 2;
    this.floorAlarm.position.y = 0.5;
    this.floorAlarm.visible = this.highlight.obstacles.has('floor');
    this.envGroup.add(this.floorAlarm);

    const ext = robot.reachMm * 1.6;
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: ext * 6 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.position.set(ext * 1.2, ext * 2.5, ext * 0.8);
  }

  /** 로봇 형상 생성. 링크 길이는 강체라서 메쉬는 로드 시 1회만 만든다. */
  loadRobot(robot, frames) {
    if (this.robotGroup) {
      this.root.remove(this.robotGroup);
      disposeTree(this.robotGroup);
    }
    this.robot = robot;
    this.robotGroup = new THREE.Group();
    this.root.add(this.robotGroup);
    this.parts = [];
    this.gripper = null; // 로봇을 바꾸면 그리퍼도 새로 만든다 (setGripper)
    this.buildEnvironment(robot);

    const bodyMat = () => new THREE.MeshStandardMaterial({ color: robot.color, roughness: 0.45, metalness: 0.15 });
    const darkMat = () => new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.6, metalness: 0.3 });

    for (const seg of linkSegments(robot, frames)) {
      const len = new THREE.Vector3(...seg.b).distanceTo(new THREE.Vector3(...seg.a));
      const geom = len < 1 ? new THREE.SphereGeometry(seg.r, 20, 14) : new THREE.CapsuleGeometry(seg.r, len, 6, 20);
      const mat = seg.link === 0 || seg.link === 6 ? darkMat() : bodyMat();
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      this.robotGroup.add(mesh);
      this.parts.push({ kind: 'segment', link: seg.link, mesh });
    }

    // J2, J3 모터 하우징 (관절 축 방향 원기둥)
    const r = robot.linkRadiiMm;
    for (const [frameIndex, link, radius] of [[1, 2, r[1] * 1.15], [2, 3, r[2] * 1.15]]) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, radius * 2.4, 24), darkMat());
      mesh.castShadow = true;
      this.robotGroup.add(mesh);
      this.parts.push({ kind: 'joint', frameIndex, link, mesh });
    }

    // TCP 좌표축 표시
    this.tcpAxes = new THREE.AxesHelper(Math.max(80, robot.reachMm * 0.12));
    this.tcpAxes.matrixAutoUpdate = false;
    this.robotGroup.add(this.tcpAxes);

    this.update(frames);
    this.applyHighlights();
  }

  /** 장애물 메쉬 재구성 (숨김 장애물은 그리지 않음). size = [x, y, z] 전체 치수.
   *  물리 모드에서도 배치(layout) 자세로 만든 뒤, 매 프레임 setObjectPoses()로 물리 결과를 덮어쓴다. */
  setObstacles(obstacles, selectedId = this.selectedObstacleId) {
    this.selectedObstacleId = selectedId;
    for (const mesh of this.obstacleMeshes.values()) {
      this.obstacleGroup.remove(mesh);
      disposeTree(mesh);
    }
    this.obstacleMeshes.clear();
    for (const ob of obstacles) {
      if (ob.visible === false) continue;
      const [sx, sy, sz] = ob.size;
      let geom;
      if (ob.type === 'sphere') geom = new THREE.SphereGeometry(sx / 2, 32, 20);
      else if (ob.type === 'cylinder') geom = new THREE.CylinderGeometry(sx / 2, sx / 2, sz, 32).rotateX(Math.PI / 2); // 축 = 로컬 Z
      else geom = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({ color: this.palette.obstacle, transparent: true, opacity: 0.5, roughness: 0.7, depthWrite: false }),
      );
      this.applyObjectLook(mesh);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), new THREE.LineBasicMaterial({ color: this.palette.edge })));
      mesh.position.set(...ob.pos);
      const [rx, ry, rz] = ob.rot ?? [0, 0, 0];
      mesh.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'ZYX'); // R = Rz·Ry·Rx (collision.js와 동일)
      mesh.castShadow = true;
      mesh.userData.obstacle = ob;
      this.obstacleGroup.add(mesh);
      this.obstacleMeshes.set(ob.id, mesh);
    }
    // 메쉬를 새로 만들었으므로 선택된 장애물에 기즈모를 다시 붙인다 (물리 모드에서는 물리가 위치를 정하므로 기즈모 없음)
    const selected = this.obstacleMeshes.get(selectedId);
    if (selected && !this.physicsMode) this.transform.attach(selected);
    else this.transform.detach();
    this.applyHighlights();
  }

  /**
   * 시뮬레이션 모드 표시 전환 (PRD_v.1.1.0 FR-18·20).
   * 물리 모드: 물체를 불투명하게 그려 움직이는 물체임을 구분하고, 기즈모 편집을 끈다.
   */
  setPhysicsMode(on) {
    this.physicsMode = on;
    for (const mesh of this.obstacleMeshes.values()) this.applyObjectLook(mesh);
    if (on) this.transform.detach();
    else {
      const selected = this.obstacleMeshes.get(this.selectedObstacleId);
      if (selected) this.transform.attach(selected);
    }
  }

  applyObjectLook(mesh) {
    const m = mesh.material;
    m.opacity = this.physicsMode ? 0.92 : 0.5;
    m.depthWrite = !!this.physicsMode;
    m.needsUpdate = true;
  }

  /**
   * 물리 결과 반영: poses = Map(id → { pos: mm, quat: {x,y,z,w}, out, sleeping }) — 로봇 좌표계(Z-up) 그대로.
   * 움직이는(잠들지 않은) 물체는 테두리를 경로색으로 표시한다 (v1.1.0 3단계).
   */
  setObjectPoses(poses) {
    let changed = false;
    for (const [id, mesh] of this.obstacleMeshes) {
      const p = poses.get(id);
      if (!p) continue;
      mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
      mesh.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
      mesh.visible = !p.out;
      const moving = this.physicsMode && !p.sleeping && !p.out;
      if (mesh.userData.moving !== moving) {
        mesh.userData.moving = moving;
        changed = true;
      }
    }
    if (changed) this.applyHighlights();
  }

  /** 기즈모 모드: 'translate' | 'rotate' | 'scale' */
  setGizmoMode(mode) {
    this.transform.setMode(mode);
  }

  onObstacleTransform(fn) {
    this.transformListeners.add(fn);
  }

  onObstaclePick(fn) {
    this.pickListeners.add(fn);
  }

  /** 기즈모 드래그 중 미리보기 (id, patch) */
  onObstacleDrag(fn) {
    this.dragListeners.add(fn);
  }

  /** 기즈모 조작 결과 → 장애물 속성 (pos/rot/size, mm·deg). 메쉬 스케일은 치수에 반영한다. */
  emitTransform(mesh) {
    const patch = this.transformPatch(mesh);
    this.transformListeners.forEach((fn) => fn(mesh.userData.obstacle.id, patch));
  }

  transformPatch(mesh) {
    const ob = mesh.userData.obstacle;
    const pos = mesh.position.toArray().map((v) => round(v, 1));
    const rot = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((v) => round(v * RAD, 0.1));
    const sc = mesh.scale.toArray();
    const size = ob.size.slice();
    if (ob.type === 'sphere') {
      const f = sc.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
      size.fill(round(size[0] * f, 1));
    } else if (ob.type === 'cylinder') {
      const f = Math.abs(sc[0] - 1) >= Math.abs(sc[1] - 1) ? sc[0] : sc[1];
      size[0] = size[1] = round(size[0] * f, 1);
      size[2] = round(size[2] * sc[2], 1);
    } else {
      for (let i = 0; i < 3; i++) size[i] = round(size[i] * sc[i], 1);
    }
    return { pos, rot, size: size.map((v) => Math.max(1, v)) };
  }

  /** 클릭(드래그 아님)으로 장애물 선택 */
  setupPicking() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      if (this.transform.dragging || this.transform.axis) return; // 기즈모 조작은 선택이 아님
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects([...this.obstacleMeshes.values()], false)[0];
      if (hit) this.pickListeners.forEach((fn) => fn(hit.object.userData.obstacle.id));
    });
  }

  /** Waypoint 마커: [{ id, pos: [x,y,z], active }] 순서대로 점선 연결 */
  setWaypointMarkers(markers) {
    disposeChildren(this.waypointGroup);
    if (!markers.length || !this.robot) return;
    const r = Math.max(8, this.robot.reachMm * 0.012);
    const geom = new THREE.SphereGeometry(r, 16, 10);
    for (const m of markers) {
      const mesh = new THREE.Mesh(geom.clone(), new THREE.MeshBasicMaterial({ color: m.active ? '#ffd23f' : '#3d9be9' }));
      mesh.position.set(...m.pos);
      this.waypointGroup.add(mesh);
    }
    geom.dispose();
    if (markers.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(markers.map((m) => new THREE.Vector3(...m.pos))),
        new THREE.LineDashedMaterial({ color: '#3d9be9', dashSize: r * 2, gapSize: r * 1.5 }),
      );
      line.computeLineDistances();
      this.waypointGroup.add(line);
    }
  }

  /** 계획 경로 미리보기: TCP 위치 목록(mm)을 튜브로 표시, 시작(녹)/끝(분홍) 점. null이면 제거 */
  /**
   * @param points 실행 궤적의 TCP 위치 목록 (튜브)
   * @param vertices 경유점 [{ label: 'A' | '1' … | 'B', tcp }] → 점 + 라벨 표시
   */
  setPlanPreview(points, vertices) {
    disposeChildren(this.planGroup);
    if (!points || points.length < 2 || !this.robot) return;
    const r = Math.max(3, this.robot.reachMm * 0.004);
    const vecs = points.map((p) => new THREE.Vector3(...p));
    // 연속 중복점 제거 (튜브 법선 계산 오류 방지)
    const pts = vecs.filter((v, i) => i === 0 || v.distanceToSquared(vecs[i - 1]) > 1e-4);
    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.min(600, pts.length * 2), r, 8, false),
        new THREE.MeshBasicMaterial({ color: this.palette.path, transparent: true, opacity: 0.85 }),
      );
      tube.userData.pathPart = true;
      this.planGroup.add(tube);
    }
    const marks = vertices ?? [{ label: 'A', tcp: points[0] }, { label: 'B', tcp: points.at(-1) }];
    // 파지·놓기 지점은 색으로 구분 (FR-24): 집기 = 주황, 놓기 = 청록
    const KIND_COLOR = { pick: '#ff9f1c', place: '#2ec4b6' };
    const placed = []; // 같은 위치(예: 파지 접근점 = 상승 끝점, 3 mm 이내)의 라벨은 위로 쌓아 겹치지 않게
    for (const v of marks) {
      const level = placed.filter((p) => Math.hypot(p[0] - v.tcp[0], p[1] - v.tcp[1], p[2] - v.tcp[2]) < 3).length;
      placed.push(v.tcp);
      const end = v.label === 'A' || v.label === 'B' || !!KIND_COLOR[v.kind];
      const color = KIND_COLOR[v.kind] ?? (v.label === 'A' ? '#34c77b' : this.palette.path);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r * (end ? 3 : 1.8), 16, 10), new THREE.MeshBasicMaterial({ color }));
      dot.userData.pathPart = color === this.palette.path;
      dot.position.set(...v.tcp);
      this.planGroup.add(dot);
      // 라벨 (A, 1, 2, …, B): 점 바로 위, 항상 보이게
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(v.label, end ? color : '#ffffff'), depthTest: false, transparent: true }));
      label.position.set(v.tcp[0], v.tcp[1], v.tcp[2] + r * (9 + level * 10));
      label.scale.setScalar(r * (end ? 12 : 9));
      label.renderOrder = 10;
      this.planGroup.add(label);
    }
  }

  /**
   * 드로스 셀 장면 (PRD_v.1.1.1 FR-25): 아연 포트 벽, 욕면(용융 아연), 강판·스나우트, 드로스 박스. null이면 제거.
   * @param cell { fixtures: [{ id, part, pos, size }], bathZ, pot, snout, bin }
   */
  setCell(cell) {
    disposeChildren(this.cellGroup);
    this.cellMeshes.clear();
    this.cell = cell;
    if (!cell) return this.setDross(null);
    const mats = {
      pot: () => new THREE.MeshStandardMaterial({ color: '#4d535b', roughness: 0.75, metalness: 0.35 }),
      snout: () => new THREE.MeshStandardMaterial({ color: '#9aa2ab', roughness: 0.45, metalness: 0.5 }),
      bin: () => new THREE.MeshStandardMaterial({ color: '#7b2f38', roughness: 0.7, metalness: 0.2 }),
      pedestal: () => new THREE.MeshStandardMaterial({ color: '#c9a227', roughness: 0.6, metalness: 0.3 }),
    };
    for (const f of cell.fixtures) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...f.size), (mats[f.part] ?? mats.pot)());
      mesh.position.set(...f.pos);
      mesh.castShadow = mesh.receiveShadow = true;
      this.cellGroup.add(mesh);
      this.cellMeshes.set(f.id, mesh);
    }
    const { pot, bathZ, snout, bin } = cell;
    // 욕면: 은회색 금속 액체 + 100 mm 격자 (영상의 욕면 표시)
    const w = pot.x1 - pot.x0, h = pot.y1 - pot.y0;
    const bath = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ color: '#cdd3da', roughness: 0.28, metalness: 0.75, emissive: '#2a2622', emissiveIntensity: 0.25 }),
    );
    bath.position.set((pot.x0 + pot.x1) / 2, (pot.y0 + pot.y1) / 2, bathZ);
    bath.receiveShadow = true;
    this.cellGroup.add(bath);
    const grid = new THREE.GridHelper(Math.max(w, h), Math.round(Math.max(w, h) / 100), '#9aa3ad', '#b4bcc5');
    grid.rotation.x = Math.PI / 2;
    grid.position.set(bath.position.x, bath.position.y, bathZ + 0.5);
    grid.scale.set(w / Math.max(w, h), 1, h / Math.max(w, h));
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    grid.material.depthWrite = false;
    this.cellGroup.add(grid);
    // 강판(Strip): 스나우트 위로 올라가는 얇은 판 (표시용)
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(12, h * 0.8, 1400),
      new THREE.MeshStandardMaterial({ color: '#aeb6bf', roughness: 0.3, metalness: 0.8 }),
    );
    strip.position.set((snout.x0 + snout.x1) / 2, 0, snout.z1 + 700);
    strip.castShadow = true;
    this.cellGroup.add(strip);
    // 드로스 박스 윗면: 노란 X 보강대 (영상의 박스 표시) — 대형 박스 + 측면 박스
    const y = new THREE.LineBasicMaterial({ color: '#f2c94c' });
    for (const bb of [bin, ...(cell.sideBins ?? [])]) {
      const z = bb.h + 2;
      const corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]].map(([px, py]) => new THREE.Vector3(px, py, z));
      const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), y);
      const xs = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([corners[0], corners[2], corners[1], corners[3]]), y);
      this.cellGroup.add(rim, xs);
    }
    this.applyHighlights();
  }

  /**
   * 드로스 입자 표시 (FR-26): state = { n, buf: [x, y, z, r, …] } (r = 0이면 숨김). null이면 제거.
   * 색은 입자 번호로 정한다(영상처럼 짙은 회색·밝은 회색·황갈색이 섞임).
   */
  setDross(state) {
    if (!state) {
      if (this.drossMesh) {
        this.root.remove(this.drossMesh);
        disposeTree(this.drossMesh);
        this.drossMesh = null;
      }
      return;
    }
    const cap = Math.max(64, state.n);
    if (!this.drossMesh || this.drossMesh.userData.cap < cap) {
      this.setDross(null);
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.25 }),
        Math.max(cap * 2, 400),
      );
      mesh.userData.cap = mesh.count;
      const palette = ['#3a3c40', '#55585d', '#7e8287', '#a3a7ac', '#2b2c2f', '#b8a68a'].map((c) => new THREE.Color(c));
      for (let i = 0; i < mesh.count; i++) {
        const h = Math.imul(i + 1, 2654435761) >>> 0;
        mesh.setColorAt(i, palette[h % palette.length]);
      }
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.drossMesh = mesh;
      this.root.add(mesh);
    }
    const m = this.drossMesh;
    const M = this._drossM ?? (this._drossM = new THREE.Matrix4());
    const { n, buf } = state;
    for (let i = 0; i < n; i++) {
      const r = buf[i * 4 + 3];
      M.makeScale(r, r, r);
      M.setPosition(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
      m.setMatrixAt(i, M);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }

  /**
   * 추가 로봇(측면 로봇) 표시 (v1.1.1 FR-31). baseT = 베이스 자세(로봇 좌표계 4x4), spec = 툴(스키머·밀대), frames = FK 결과.
   * 같은 id로 다시 부르면 새로 만든다. 갱신은 updateExtraRobot.
   */
  setExtraRobot(id, { robot, baseT, spec, frames, label }) {
    this.removeExtraRobot(id);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.set(...baseT);
    const bodyMat = () => new THREE.MeshStandardMaterial({ color: robot.color, roughness: 0.45, metalness: 0.15 });
    const darkMat = () => new THREE.MeshStandardMaterial({ color: robot.cobot ? '#2f6f9f' : '#3a3f47', roughness: 0.6, metalness: 0.3 });
    const parts = [];
    for (const seg of linkSegments(robot, frames)) {
      const len = new THREE.Vector3(...seg.b).distanceTo(new THREE.Vector3(...seg.a));
      const geom = len < 1 ? new THREE.SphereGeometry(seg.r, 18, 12) : new THREE.CapsuleGeometry(seg.r, len, 6, 18);
      const mesh = new THREE.Mesh(geom, seg.link === 0 || seg.link === 6 ? darkMat() : bodyMat());
      mesh.castShadow = true;
      group.add(mesh);
      parts.push({ kind: 'segment', link: seg.link, mesh });
    }
    const r = robot.linkRadiiMm;
    for (const [frameIndex, link, radius] of [[1, 2, r[1] * 1.15], [2, 3, r[2] * 1.15]]) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, radius * 2.4, 22), darkMat());
      mesh.castShadow = true;
      group.add(mesh);
      parts.push({ kind: 'joint', frameIndex, link, mesh });
    }
    const tool = toolGroup(spec);
    if (tool) group.add(tool.group);
    if (label) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(label, '#ffd23f'), depthTest: false, transparent: true }));
      sp.position.set(0, 0, robot.dh[0].d + 650);
      sp.scale.setScalar(220);
      sp.renderOrder = 10;
      group.add(sp);
    }
    this.root.add(group);
    const rig = { group, parts, tool, robot };
    this.extraRigs.set(id, rig);
    this.updateExtraRobot(id, frames);
  }

  updateExtraRobot(id, frames) {
    const rig = this.extraRigs.get(id);
    if (!rig) return;
    const segs = linkSegments(rig.robot, frames);
    let s = 0;
    for (const part of rig.parts) {
      if (part.kind === 'segment') {
        const seg = segs[s++];
        const a = new THREE.Vector3(...seg.a), b = new THREE.Vector3(...seg.b);
        part.mesh.position.copy(a).add(b).multiplyScalar(0.5);
        const dir = b.sub(a);
        if (dir.lengthSq() > 1e-6) part.mesh.quaternion.setFromUnitVectors(Y_UP, dir.normalize());
      } else {
        const T = frames[part.frameIndex];
        part.mesh.position.set(...origin(T));
        part.mesh.quaternion.setFromUnitVectors(Y_UP, new THREE.Vector3(...axisZ(T)));
      }
    }
    if (rig.tool) {
      rig.tool.group.matrix.set(...frames[6]);
      rig.tool.group.matrixWorldNeedsUpdate = true;
    }
  }

  removeExtraRobot(id) {
    const rig = this.extraRigs.get(id);
    if (!rig) return;
    this.root.remove(rig.group);
    disposeTree(rig.group);
    this.extraRigs.delete(id);
  }

  /** 측면 로봇 알람 하이라이트 (로봇 전체) */
  setExtraHighlight(id, on) {
    const rig = this.extraRigs.get(id);
    if (!rig) return;
    rig.group.traverse((o) => o.material?.emissive?.copy(on ? ALARM_COLOR : BLACK));
  }

  /** 충돌 하이라이트: links = 링크 번호, obstacles = 장애물 id ('floor' 포함) */
  setHighlights({ links = [], obstacles = [] } = {}) {
    this.highlight = { links: new Set(links), obstacles: new Set(obstacles) };
    this.applyHighlights();
  }

  applyHighlights() {
    const { links, obstacles } = this.highlight;
    for (const part of this.parts) part.mesh.material.emissive.copy(links.has(part.link) ? ALARM_COLOR : BLACK);
    for (const [id, mesh] of this.obstacleMeshes) {
      const hit = obstacles.has(id);
      mesh.material.emissive.copy(hit ? ALARM_COLOR : id === this.selectedObstacleId ? SELECT_COLOR : BLACK);
      mesh.material.emissiveIntensity = hit ? 0.9 : 0.45;
      mesh.children[0].material.color.set(
        hit ? '#ff4d4d' : id === this.selectedObstacleId ? this.palette.selectEdge : mesh.userData.moving ? this.palette.path : this.palette.edge,
      );
    }
    if (this.floorAlarm) this.floorAlarm.visible = obstacles.has('floor');
    for (const [id, mesh] of this.cellMeshes) {
      mesh.material.emissive.copy(obstacles.has(id) ? ALARM_COLOR : BLACK);
      mesh.material.emissiveIntensity = 0.8;
    }
  }

  /**
   * 그리퍼 형상 (PRD_v.1.1.0 FR-21). spec = null이면 제거. 플랜지 좌표계 그룹 안에
   * 몸체(원기둥, z = 0 ~ bodyH)와 손가락 2개(박스, z = bodyH ~ length)를 만든다. 하이라이트는 링크 7(몸체)·8(손가락).
   */
  setGripper(spec, opening = spec?.maxOpenMm ?? 0) {
    if (this.gripper) {
      this.robotGroup.remove(this.gripper.group);
      disposeTree(this.gripper.group);
      this.parts = this.parts.filter((p) => p.kind !== 'gripper');
      this.gripper = null;
    }
    if (!spec || !this.robotGroup) {
      if (this.lastFrames) this.update(this.lastFrames);
      return;
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const mat = () => new THREE.MeshStandardMaterial({ color: '#59616c', roughness: 0.5, metalness: 0.4 });
    if (spec.kind === 'skimmer') return this.setSkimmer(spec, group, mat);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(spec.bodyDiaMm / 2, spec.bodyDiaMm / 2, spec.bodyHeightMm, 28).rotateX(Math.PI / 2), mat());
    body.position.z = spec.bodyHeightMm / 2;
    const fingerLen = Math.max(1, spec.lengthMm - spec.bodyHeightMm);
    const fingerGeom = new THREE.BoxGeometry(spec.fingerThickMm, spec.fingerWidthMm, fingerLen);
    const fingers = [1, -1].map((side) => {
      const f = new THREE.Mesh(fingerGeom.clone(), mat());
      f.position.set(0, 0, spec.bodyHeightMm + fingerLen / 2);
      f.userData.side = side;
      return f;
    });
    fingerGeom.dispose();
    for (const m of [body, ...fingers]) {
      m.castShadow = true;
      group.add(m);
    }
    this.robotGroup.add(group);
    this.parts.push({ kind: 'gripper', link: 7, mesh: body }, ...fingers.map((mesh) => ({ kind: 'gripper', link: 8, mesh })));
    this.gripper = { spec, group, fingers };
    this.setGripperOpening(opening);
    if (this.lastFrames) this.update(this.lastFrames);
    this.applyHighlights();
  }

  /** 스키머 툴 (v1.1.1 FR-27): 수직 봉 + 사각 스쿱(바닥판·뒤/좌우 턱, 앞쪽 열림). 하이라이트는 링크 7 */
  setSkimmer(spec, group, mat) {
    const L = spec.lengthMm, t = spec.wallMm, hl = spec.lipMm;
    const rodLen = L - hl;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(spec.rodDiaMm / 2, spec.rodDiaMm / 2, rodLen, 20).rotateX(Math.PI / 2), mat());
    rod.position.z = rodLen / 2;
    const scoopMat = () => new THREE.MeshStandardMaterial({ color: '#8b939c', roughness: 0.45, metalness: 0.6 });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(spec.plateXMm, spec.plateYMm, spec.plateThickMm), scoopMat());
    plate.position.z = L + spec.plateThickMm / 2;
    const back = new THREE.Mesh(new THREE.BoxGeometry(t, spec.plateYMm, hl), scoopMat());
    back.position.set(-spec.plateXMm / 2 + t / 2, 0, L - hl / 2);
    const sides = [1, -1].map((sgn) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(spec.plateXMm, t, hl), scoopMat());
      m.position.set(0, sgn * (spec.plateYMm / 2 - t / 2), L - hl / 2);
      return m;
    });
    const parts = [rod, plate, back, ...sides];
    for (const m of parts) {
      m.castShadow = true;
      group.add(m);
    }
    this.robotGroup.add(group);
    this.parts.push(...parts.map((mesh) => ({ kind: 'gripper', link: 7, mesh })));
    this.gripper = { spec, group, fingers: [] };
    if (this.lastFrames) this.update(this.lastFrames);
    this.applyHighlights();
  }

  /** 손가락 벌림 폭 (손가락 안쪽 면 사이, mm) */
  setGripperOpening(opening) {
    if (!this.gripper) return;
    const x = opening / 2 + this.gripper.spec.fingerThickMm / 2;
    for (const f of this.gripper.fingers) f.position.x = f.userData.side * x;
  }

  /** 관절값 변경 시 FK 결과(frames)로 각 메쉬 자세 갱신 */
  update(frames) {
    this.lastFrames = frames;
    const segs = linkSegments(this.robot, frames);
    let s = 0;
    for (const part of this.parts) {
      if (part.kind === 'gripper') continue; // 그리퍼는 플랜지 그룹 행렬로 함께 움직인다
      if (part.kind === 'segment') {
        const seg = segs[s++];
        const a = new THREE.Vector3(...seg.a);
        const b = new THREE.Vector3(...seg.b);
        part.mesh.position.copy(a).add(b).multiplyScalar(0.5);
        const dir = b.sub(a);
        if (dir.lengthSq() > 1e-6) part.mesh.quaternion.setFromUnitVectors(Y_UP, dir.normalize());
      } else {
        const T = frames[part.frameIndex];
        part.mesh.position.set(...origin(T));
        part.mesh.quaternion.setFromUnitVectors(Y_UP, new THREE.Vector3(...axisZ(T)));
      }
    }
    if (this.gripper) {
      this.gripper.group.matrix.set(...frames[6]);
      this.gripper.group.matrixWorldNeedsUpdate = true;
    }
    // TCP 좌표축: 그리퍼가 있으면 손가락 끝(플랜지 + 길이)
    const tcp = this.gripper ? multiply(frames[6], toolMatrix(this.gripper.spec.lengthMm)) : frames[6];
    this.tcpAxes.matrix.set(...tcp); // Matrix4.set은 row-major 인자
    this.tcpAxes.matrixWorldNeedsUpdate = true;
  }

  getCamera() {
    return { pos: fromWorld(this.camera.position), target: fromWorld(this.controls.target) };
  }

  setCamera({ pos, target }) {
    this.camera.position.copy(toWorld(pos));
    this.controls.target.copy(toWorld(target));
    this.controls.update();
  }

  onCameraChange(fn) {
    this.cameraListeners.add(fn);
  }

  render() {
    this.controls.update();
    const r = this.renderer;
    r.render(this.scene, this.camera);
    // 좌표축 표시: 좌측 하단에 메인 카메라와 같은 방향으로 겹쳐 그린다
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.axisCamera.position.copy(dir.multiplyScalar(4));
    this.axisCamera.up.copy(this.camera.up);
    this.axisCamera.lookAt(0, 0, 0);
    const pad = 8;
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(pad, pad, AXIS_VIEW_PX, AXIS_VIEW_PX);
    r.setViewport(pad, pad, AXIS_VIEW_PX, AXIS_VIEW_PX);
    r.clearDepth();
    r.render(this.axisScene, this.axisCamera);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.autoClear = true;
  }
}

/** 툴 형상 그룹 (측면 로봇용): 스키머(봉 + 스쿱) / 밀대(봉 + 날). 플랜지 좌표계, matrixAutoUpdate = false */
function toolGroup(spec) {
  if (!spec) return null;
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const rodMat = new THREE.MeshStandardMaterial({ color: '#59616c', roughness: 0.5, metalness: 0.4 });
  const steel = () => new THREE.MeshStandardMaterial({ color: '#8b939c', roughness: 0.45, metalness: 0.6 });
  const L = spec.lengthMm;
  const add = (geom, mat, [x, y, z]) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
  };
  if (spec.kind === 'skimmer') {
    const hl = spec.lipMm, t = spec.wallMm;
    add(new THREE.CylinderGeometry(spec.rodDiaMm / 2, spec.rodDiaMm / 2, L - hl, 16).rotateX(Math.PI / 2), rodMat, [0, 0, (L - hl) / 2]);
    add(new THREE.BoxGeometry(spec.plateXMm, spec.plateYMm, spec.plateThickMm), steel(), [0, 0, L + spec.plateThickMm / 2]);
    add(new THREE.BoxGeometry(t, spec.plateYMm, hl), steel(), [-spec.plateXMm / 2 + t / 2, 0, L - hl / 2]);
    for (const sg of [1, -1]) add(new THREE.BoxGeometry(spec.plateXMm, t, hl), steel(), [0, sg * (spec.plateYMm / 2 - t / 2), L - hl / 2]);
  } else if (spec.kind === 'rake') {
    add(new THREE.CylinderGeometry(spec.rodDiaMm / 2, spec.rodDiaMm / 2, L - spec.bladeHMm, 16).rotateX(Math.PI / 2), rodMat, [0, 0, (L - spec.bladeHMm) / 2]);
    add(new THREE.BoxGeometry(spec.bladeTMm, spec.bladeWMm, spec.bladeHMm), new THREE.MeshStandardMaterial({ color: '#d98c2b', roughness: 0.5, metalness: 0.4 }), [0, 0, L - spec.bladeHMm / 2]);
  }
  return { group };
}

/** 좌표축 라벨용 글자 텍스처 */
function textTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.strokeText(text, 32, 34);
  g.fillStyle = color;
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 하위 객체의 geometry/material(텍스처 포함) 해제 */
function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    o.material?.map?.dispose();
    o.material?.dispose();
  });
}

/** 그룹의 자식을 모두 해제하고 비운다 */
function disposeChildren(group) {
  disposeTree(group);
  group.clear();
}
