// Three.js 3D 뷰. 로봇 좌표계(Z-up, mm)를 루트 그룹 회전으로 Three.js(Y-up)에 맞춘다.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { linkSegments, origin, axisZ, DEG } from './kinematics.js';

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

  /** 장애물 메쉬 재구성 (숨김 장애물은 그리지 않음). size = [x, y, z] 전체 치수 */
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
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), new THREE.LineBasicMaterial({ color: this.palette.edge })));
      mesh.position.set(...ob.pos);
      const [rx, ry, rz] = ob.rot ?? [0, 0, 0];
      mesh.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'ZYX'); // R = Rz·Ry·Rx (collision.js와 동일)
      mesh.castShadow = true;
      mesh.userData.obstacle = ob;
      this.obstacleGroup.add(mesh);
      this.obstacleMeshes.set(ob.id, mesh);
    }
    // 메쉬를 새로 만들었으므로 선택된 장애물에 기즈모를 다시 붙인다
    const selected = this.obstacleMeshes.get(selectedId);
    if (selected) this.transform.attach(selected);
    else this.transform.detach();
    this.applyHighlights();
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
    for (const v of marks) {
      const end = v.label === 'A' || v.label === 'B';
      const color = v.label === 'A' ? '#34c77b' : this.palette.path;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r * (end ? 3 : 1.8), 16, 10), new THREE.MeshBasicMaterial({ color }));
      dot.userData.pathPart = color === this.palette.path;
      dot.position.set(...v.tcp);
      this.planGroup.add(dot);
      // 라벨 (A, 1, 2, …, B): 점 바로 위, 항상 보이게
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(v.label, end ? color : '#ffffff'), depthTest: false, transparent: true }));
      label.position.set(v.tcp[0], v.tcp[1], v.tcp[2] + r * 9);
      label.scale.setScalar(r * (end ? 12 : 9));
      label.renderOrder = 10;
      this.planGroup.add(label);
    }
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
      mesh.children[0].material.color.set(hit ? '#ff4d4d' : id === this.selectedObstacleId ? this.palette.selectEdge : this.palette.edge);
    }
    if (this.floorAlarm) this.floorAlarm.visible = obstacles.has('floor');
  }

  /** 관절값 변경 시 FK 결과(frames)로 각 메쉬 자세 갱신 */
  update(frames) {
    const segs = linkSegments(this.robot, frames);
    let s = 0;
    for (const part of this.parts) {
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
    this.tcpAxes.matrix.set(...frames[6]); // Matrix4.set은 row-major 인자
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
