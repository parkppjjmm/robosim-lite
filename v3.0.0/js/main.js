// 앱 진입점: 데이터 로드, 상태 복원, UI 바인딩, 렌더/시뮬레이션 루프
import { initState, getState, setState, subscribe, onSaveStatus, findRobot, defaultCamera, exportState, importState, resetState } from './state.js';
import {
  forwardKinematics, clampJoints, homeJoints, LINK_NAMES, DEG, linkSegments,
  rotationOf, poseMatrix, mul3, expRotation, origin, multiply, rotationToRPY,
} from './kinematics.js';
import { Viewer } from './viewer.js';
import { createSafetyContext, evaluatePose, violationTypes, setAttached, blockedViolations } from './safety.js';
import { compileObstacles, capsuleObstacleDistance, rotationFromRPY, checkObstacleCollision } from './collision.js';
import { MotionController } from './motion.js';
import { singularityLabel } from './singularity.js';
import { raiseAlarm, resetAlarm, isAlarmActive, getActiveAlarm, onAlarmChange, mountAlarmBanner, mountAlarmLog } from './alarm.js';
import { mountObstaclePanel } from './obstacles-panel.js';
import { mountCartesianPanel } from './cartesian-panel.js';
import { mountWaypointPanel } from './waypoints-panel.js';
import { jointMove, linearMove, pathTrajectory, reverseTrajectory } from './trajectory.js';
import { planPickPlace, invertRigid, OBJECT_MOVED_TOLERANCE_MM } from './task.js';
import { mountPlanPanel, PLAN_REASON_LABEL } from './plan-panel.js';
import { ICONS, mountThemeToggle, mountSections, mountDrawers, mountShortcuts } from './ui.js';
import { robotThumbnail } from './thumbnail.js';
import { PhysicsWorld, rpyFromMatrix } from './physics.js';
import { loadRapier } from './physics-loader.js';
import { gripperSpec, toolMatrix, findGraspCandidate, GRIPPER_DEFAULTS, SKIMMER_SPEC, SKIMMER_SMALL_SPEC, RAKE_SPEC, skimmerBoxes } from './gripper.js';
import { mountGripperPanel } from './gripper-panel.js';
import { DrossField, drossFixtures, drossRobotOk, skimLanes, chooseLane, planSkimCycle, BATH_Z_MM, POT, SNOUT, BIN, SIDE_SLOTS, drossBins, mainLaneRange, sideBin, sideBinDistFor } from './dross.js';
import { CellRobot, CellCoordinator, sideRobotOk, slotFrame } from './cell-robot.js';
import { JointTelemetry, TelemetryLog, LINK_DENSITY, RATED_CURRENT_A, FRICTION, NOISE_PCT, BATH_DRAG_NS_M } from './telemetry.js';
import { buildXlsx } from './xlsx.js';
import { mountTelemetryPanel, drawTelemetryChart, METRICS } from './telemetry-panel.js';
import { mountDrossPanel } from './dross-panel.js';
import { parseEpisode, EpisodePlayer } from './replay.js';
import { mountReplayPanel } from './replay-panel.js';
import { mountLabPanel } from './lab-panel.js';
import { sanitizeLab, LAB_DEFAULTS } from './stroke-lab.js';
import { sanitizeTask } from './task-eval.js';

const $ = (sel) => document.querySelector(sel);

// [키, 한국어, 영문, 상태바 약칭]
const FEATURE_LABELS = [
  ['selfCollision', '자기 충돌 감지', 'Self Collision', 'SELF'],
  ['obstacleCollision', '장애물 충돌 감지', 'Obstacle Collision', 'OBST'],
  ['singularity', '특이점 감지', 'Singularity', 'SING'],
  ['autoPathPlanning', '자동 경로 계획', 'Auto Path Planning', 'PATH'],
];
const THRESHOLD_FIELDS = [
  ['selfMarginMm', 'Self 여유거리', 'mm'],
  ['obstacleMarginMm', '장애물 여유거리', 'mm'],
  ['wristDeg', '손목 특이점 |J5|', '°'],
  ['elbowDeg', '팔꿈치 특이점', '°'],
  ['shoulderMm', '어깨 특이점', 'mm'],
];
const SIM_DT = 1 / 60;
const SIZE_LABEL = { small: '소형', medium: '중형', large: '대형' };

let catalog;
let viewer;
let currentRobot;
let controller;
let obstaclePanel;
let renderAlarmLog;
let cartesianPanel;
let waypointPanel;
let lastFloorEnabled;
let drawers;
let renderTheme;
let renderSections;
let appliedTheme;
let restoring = false;
// ---- 물리 시뮬레이션 (PRD_v.1.1.0 2장, FR-17~20) ----
let physics = null; // PhysicsWorld (물리 모드일 때만)
let physicsRunning = false;
let activeSimMode = 'static'; // 실제로 적용된 모드 (settings.simMode는 사용자가 고른 모드)
let simLoading = false;
let simError = null;
let layoutChanged = false; // 물리 모드 중 배치가 편집됨 → 리셋하면 반영
let savingLayout = false; // "현재 상태를 배치로 저장" 중에는 layoutChanged를 세우지 않음
let physicsNoticeShown = false; // 장애물 감지 안내는 세션당 1회
let lastPoses = null;
let physicsStepMs = 0; // 최근 1초 최대: 물리 스텝 + 로봇 바디 갱신 + 안전 검사 갱신 (NFR-9)
let planObjectSnapshot = null; // 계획 시점의 물체 위치 (물리 모드, 계획 후 20 mm 이상 움직이면 stale)
const PLAN_STALE_MOVE_MM = 20;
// ---- 그리퍼 (PRD_v.1.1.0 FR-21, 22) ----
let gripperPanel;
// 실행 상태 (저장하지 않음): { spec, opening, target(mm), pendingGrasp(id), attached{ id, type, size, rel, ignore }, releasedId, lastObjPos, vel(mm/s) }
let grip = null;
let appliedGripperSettings = null;
let planSingularity = false; // 계획 결과를 만들 때의 특이점 감지 상태 (바뀌면 stale)
const IDLE = { status: 'idle', activeId: null, t: 0, duration: 0 };
let playback = IDLE; // Waypoint 시퀀스 재생 상태
let planPanel;
let planUI = { status: 'idle' }; // 경로 계획 패널 상태
let plan = null; // { path, trajectory } 현재 계획 결과
let planWorker = null;
let planRequestId = 0;
const PLAN_TIMEOUT_MS = 5000;
// ---- 드로스 제거 셀 (PRD_v.1.1.1 FR-25~30) ----
let drossPanel;
let drossField = null; // DrossField (셀 사용 + 물리 모드일 때)
let drossStats = null;
let appliedDross = null;
let skim = { status: 'idle', auto: false, label: '', error: null, cycles: 0, totalS: 0, lastS: 0, lastLane: -1 };
let simClock = 0; // 시뮬레이션 시간 (s): 60 Hz 스텝마다 증가. 대기 동작은 이 시계로 센다 (v1.1.1, m-6)
let appliedGravity = null;
let lastObstacles = null; // 물리 모드 배치 편집 비교용 (m-3)
// ---- 측면 로봇 (PRD_v.1.1.1 FR-31~34) ----
const coord = new CellCoordinator(); // 측면 로봇들 + 모드 2 포트 점유 잠금
let sideKey = ''; // 적용된 측면 로봇 구성 (바뀌면 다시 설치)
let sideEff = {}; // 적용된 구성 { slot: { robotId, mode, binDist } } — 설비(받침대·측면 박스) 계산에 사용
const sideMsg = {}; // 슬롯별 안내 (모드 1 불가 등)
// ---- 실시간 계측 · 데이터 기록 (PRD_v.1.1.2 FR-37~40) ----
const telem = new Map(); // 'main' | 'left' | 'right' → JointTelemetry
const tmLog = new TelemetryLog({ hz: 20 });
const tmUI = { show: { angle: false, velocity: false, current: false, torque: false }, robot: 'main', graph: false, windowS: 10 };
const tmHist = new Map(); // 로봇 → 그래프용 최근 30 s 이력 [{ t, q, qd, current, tau }] (20 Hz, 기록 여부와 무관)
const HIST_HZ = 20, HIST_S = 30;
let tmHistLast = -Infinity;
const toolLoadCache = new Map(); // 로봇 → { kg, count, imm } (최근 스텝)
let tmPanel;
let stepLabel = ''; // 단계 실행 중인 단계 이름 (계측 '상황' 라벨)
let tmFrame = 0;
// ---- 에피소드 재생 (PRD_v.3.0.0 FR-63 일부: 헤드리스 결과를 3D로) ----
let replay = null; // { ep, player, main, sides: { slot: { robot, mode, binDist } } }
let replayPanel;
const replayUI = { slot: 'main' };
// ---- 학습 (Trial & Error) (PRD_v.3.0.0 4.5·FR-67) ----
let labPanel;
const labRun = { worker: null, running: false, status: '', decisions: [], progress: null, result: null, task: null, startedAt: 0, policy: null };

async function main() {
  // file:// 실행 안내는 index.html의 일반 스크립트가 담당한다 (이 모듈은 file://에서 로드되지 않음)
  try {
    const res = await fetch(new URL('./robots.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = await res.json();
  } catch (err) {
    showFatal(`로봇 데이터(robots.json)를 불러오지 못했습니다: ${err.message}`);
    return;
  }

  const { notice } = initState(catalog);
  if (notice) showNotice(notice);
  lastFloorEnabled = getState().settings.floorEnabled;

  $('#catalog-note').textContent = catalog.note;
  viewer = new Viewer($('#viewport'));
  viewer.onCameraChange((camera) => setState({ camera }));

  controller = new MotionController({
    onApply: (evaluation) => {
      setState({ joints: evaluation.q });
      renderSafetyReadout(evaluation);
    },
    onBlocked: (result) => raiseAlarm(describeAlarm(result.hit, result.blocked)),
  });

  buildMakerBanners();
  buildFeatureToggles();
  buildThresholdFields();
  $('#btn-home').addEventListener('click', () => jog(homeJoints(currentRobot)));

  mountAlarmBanner($('#alarm-slot'));
  renderAlarmLog = mountAlarmLog($('#btn-alarm-log'), $('#alarm-log'));
  onAlarmChange((alarm) => {
    controller.locked = !!alarm;
    if (alarm) {
      controller.stop();
      coord.stop(); // 측면 로봇도 그 자리에서 멈춤 (Reset 후 저절로 움직이지 않음)
      freezeGripper(); // 그리퍼 개폐도 그 자리에서 멈춤 → Reset 후 저절로 움직이지 않음 (4-1, M-4)
      $('#safety-chips').replaceChildren(); // 알람 배너가 우선: 근접 경고 칩은 숨긴다
    }
    if (tmLog.recording) tmLog.event(simClock, 'system', alarm ? '알람' : '알람 해제', alarm?.messages?.join(' / ') ?? '');
    viewer.setHighlights(alarm ?? {});
    for (const slot of Object.keys(SIDE_SLOTS)) viewer.setExtraHighlight(slot, !!alarm?.obstacles?.includes(`robot:${slot}`) || !!alarm?.sideRobot?.includes(slot));
    syncJointInputs(getState().joints, true);
  });

  obstaclePanel = mountObstaclePanel($('#obstacle-panel'), {
    getRobot: () => currentRobot,
    onSelect: (id) => {
      viewer.setObstacles(getState().obstacles, id);
      if (lastPoses) viewer.setObjectPoses(lastPoses);
      $('#gizmo-tools').hidden = !id || activeSimMode === 'physics';
    },
    onSimMode: requestSimMode,
    onPhysicsToggle: togglePhysicsRun,
    onPhysicsReset: resetPhysics,
    onSaveLayout: savePhysicsAsLayout,
  });
  viewer.onObstaclePick((id) => obstaclePanel.select(id));
  $('#sim-badge').addEventListener('click', () => {
    if (physics) return togglePhysicsRun();
    // 고정 모드: 모드 스위치가 있는 물체 · 시뮬레이션 섹션을 보여 준다
    $('[data-sec=obstacles]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  viewer.onObstacleTransform((id, patch) => {
    setState((s) => ({ obstacles: s.obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
    viewer.setHighlights(getActiveAlarm() ?? {}); // 드래그 미리보기 하이라이트 정리 (알람이 났으면 알람 하이라이트)
  });
  viewer.onObstacleDrag(previewObstacleDrag);
  document.querySelectorAll('[data-gizmo]').forEach((btn) =>
    btn.addEventListener('click', () => {
      viewer.setGizmoMode(btn.dataset.gizmo);
      document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('active', b === btn));
    }),
  );

  cartesianPanel = mountCartesianPanel($('#cartesian-panel'), { onJog: cartesianJog });
  gripperPanel = mountGripperPanel($('#gripper-panel'), {
    onToggle: (enabled) => setGripperSettings({ enabled }),
    onCommand: gripperCommand,
    onSpecChange: setGripperOverride,
    onSpecReset: resetGripperOverride,
  });
  drossPanel = mountDrossPanel($('#dross-panel'), {
    onToggle: setDrossEnabled,
    onField: setDrossField,
    onRunCycle: () => startSkim(false),
    onAuto: () => startSkim(true),
    onStop: stopSkim,
    onRespawn: () => {
      if (!physics) return showNotice('물리 모드에서 다시 배치할 수 있습니다.');
      resetPhysics();
    },
    onView: viewCell,
    onUseLargeRobot: useLargeRobot,
    onSideRobot: (slot, robotId) => setSideConfig(slot, { robotId }),
    onSideMode: (slot, mode) => setSideConfig(slot, { mode }),
  });
  replayPanel = mountReplayPanel($('#replay-panel'), $('#replay-bar'), $('#replay-info'), {
    onFile: openReplay,
    onPlay: toggleReplay,
    onRestart: () => {
      if (!replay) return;
      replay.player.t = 0;
      replay.player.playing = true;
    },
    onSpeed: (x) => replay && (replay.player.speed = x),
    onSeek: (f) => replay && (replay.player.t = f * replay.player.duration),
    onExit: exitReplay,
    onRobot: (slot) => (replayUI.slot = slot),
  });
  replayPanel.render({ active: false });
  labPanel = mountLabPanel($('#lab-panel'), {
    onStart: startLab,
    onStop: () => labRun.worker?.postMessage({ cmd: 'stop' }),
    onExport: exportLab,
    onImport: importLab,
    onReset: () => labPanel.load({ lab: LAB_DEFAULTS, task: { targetRatePct: 80, timeLimitS: 600 } }),
    onReplay: (which) => {
      const r = labRun.result;
      const ep = which === 'rule' ? r?.rule?.episode : r?.episode;
      if (ep) showEpisode(parseEpisode(ep), which === 'rule' ? '규칙 경로 (비교)' : '학습 결과 (최선 채택)');
    },
    onSaveLog: saveLabResult,
    onPolicy: loadLabPolicy,
  });
  labPanel.setDefaultWorkers(Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 2)));
  renderLabUI();
  tmPanel = mountTelemetryPanel($('#telemetry-panel'), $('#telemetry-overlay'), {
    onToggle: (k) => {
      tmUI.show[k] = !tmUI.show[k];
      renderTelemetryUI();
    },
    onRobot: (id) => {
      tmUI.robot = id;
      renderTelemetryUI();
    },
    onGraph: () => {
      tmUI.graph = !tmUI.graph;
      renderTelemetryUI();
    },
    onWindow: (s) => {
      tmUI.windowS = s;
      renderTelemetryUI();
    },
    onHz: (hz) => {
      tmLog.hz = hz;
      renderTelemetryUI();
    },
    onRecord: () => {
      if (tmLog.recording) tmLog.stop(simClock);
      else tmLog.start(simClock);
      renderTelemetryUI();
    },
    onExport: exportTelemetry,
    onClear: () => {
      tmLog.clear();
      renderTelemetryUI();
    },
  });
  waypointPanel = mountWaypointPanel($('#waypoint-panel'), {
    getRobot: () => currentRobot,
    getJoints: () => controller.current.q,
    // "현재 자세 저장" 시 도착 동작 제안: 그리퍼가 닫혀 있거나 파지 중이면 '닫기' (FR-23)
    getDefaultAction: () => (grip && (grip.attached || grip.target < grip.spec.maxOpenMm - 1e-6) ? { type: 'close' } : { type: 'none' }),
    onMoveTo: moveToWaypoint,
    onPlay: playSequence,
    onPause: pauseSequence,
    onResume: resumeSequence,
    onStop: stopSteps,
  });

  planPanel = mountPlanPanel($('#plan-panel'), {
    getRobot: () => currentRobot,
    getTcp: () => {
      const tcp = tcpPose(controller.current.q); // 그리퍼가 있으면 손가락 끝
      return [...tcp.pos, ...tcp.rpy];
    },
    getObjects: () => getState().obstacles.filter((o) => o.visible !== false).map((o) => ({ id: o.id, name: o.name })),
    onPlan: requestPlan,
    onCancel: () => cancelPlan(), // 클릭 이벤트가 silent 인자로 넘어가지 않도록
    onRun: runPlan,
    onPause: pausePlan,
    onRewind: rewindPlan,
    onSaveWaypoints: savePlanAsWaypoints,
  });

  onSaveStatus((status) => {
    const el = $('#status-save');
    el.textContent = { pending: '저장 중…', saved: '저장됨 ✓', error: '저장 실패 ✕' }[status];
    el.dataset.status = status;
  });

  renderTheme = mountThemeToggle($('#btn-theme'), (theme) => {
    appliedTheme = theme;
    viewer.setTheme(theme);
  });
  renderSections = mountSections($('#panel-right'));
  mountDataActions();
  drawers = mountDrawers();
  $('[data-drawer=left]').innerHTML = ICONS.models;
  $('[data-drawer=right]').innerHTML = ICONS.controls;
  mountShortcuts({
    onPlayPause: togglePlayPause,
    onStop: stopAll,
    onReset: () => isAlarmActive() && resetAlarm(),
    onGripper: () => grip && gripperCommand('toggle'),
  });

  subscribe(onStateChange);
  viewer.setObstacles(getState().obstacles);
  lastObstacles = getState().obstacles;
  appliedGravity = getState().settings.gravity;
  restoring = true; // 저장된 상태 복원: 위반이어도 새 알람 로그를 남기지 않는다
  applyRobot(getState());
  restoring = false;
  renderSimUI();
  renderTelemetryUI();
  // 물리 모드로 저장돼 있으면 고정 모드 화면을 먼저 보여 준 뒤 물리엔진을 불러와 배치에서 시작한다
  if (getState().settings.simMode === 'physics') applySimMode('physics');
  viewer.setCamera(getState().camera);
  renderMakerSelection();
  renderModelCards();
  renderFeatureToggles();
  renderThresholdFields();

  startLoop();

  // 테스트/디버깅용 핸들 (URL에 ?debug가 있을 때만)
  if (new URLSearchParams(location.search).has('debug')) {
    window.__robosim = { viewer, controller, getState, setState, get physics() { return physics; }, get dross() { return drossField; }, get skim() { return skim; }, telem, tmLog, buildXlsx };
  }
}

function onStateChange(state, keys) {
  const has = (k) => keys.includes(k);
  if (has('selectedRobotId')) applyRobot(state);
  else if (has('joints')) updatePose(state.joints);

  if (has('selectedMaker') || has('selectedRobotId')) {
    renderMakerSelection();
    renderModelCards();
  }
  if (has('features')) {
    renderFeatureToggles();
    renderSimUI(); // 물리 상태 문구(감지 ON: 정지 / OFF: 밀어냄) 갱신
  }
  if (has('thresholds')) {
    renderThresholdFields();
    if (!has('selectedRobotId')) applySideRobots(); // 측면 로봇의 검사 여유거리·레인도 다시 계산
  }
  if (has('obstacles') || has('settings')) obstaclePanel.render();
  if (has('obstacles')) {
    planPanel.renderInputs(); // Pick & Place 물체 목록
    if (physics && !savingLayout) syncPhysicsObjects(state.obstacles); // 숨김·삭제·크기 변경은 물리에도 바로 반영 (m-3)
    lastObstacles = state.obstacles;
    viewer.setObstacles(state.obstacles);
    if (lastPoses) viewer.setObjectPoses(lastPoses); // 물리 모드: 메쉬를 다시 만들어도 현재 물리 자세 유지
    if (!has('selectedRobotId')) warnBaseOverlap(state.obstacles);
  }
  if (has('cell') && !has('selectedRobotId')) applyCell();
  if (has('settings') && physics && state.settings.gravity !== appliedGravity) {
    appliedGravity = state.settings.gravity;
    physics.setGravity(state.settings.gravity); // 중력 변경은 바로 반영 (m-10)
  }
  if (has('settings') && state.settings.simMode !== activeSimMode && !simLoading) applySimMode(state.settings.simMode);
  if (has('settings') && !has('selectedRobotId') && state.settings.gripper !== appliedGripperSettings) applyGripper();
  if (has('alarmLog')) renderAlarmLog();
  if (has('waypoints') && !has('selectedRobotId')) {
    waypointPanel.renderList();
    planPanel.renderInputs();
    renderWaypointMarkers();
  }
  if (has('features')) onPlanFeatureChange(state.features.autoPathPlanning);
  if (has('settings')) {
    cartesianPanel.render();
    renderGripperUI();
    waypointPanel.renderPlayback(playback);
    renderSections();
    planPanel.renderInputs();
    if (state.settings.theme !== appliedTheme) renderTheme();
  }
  if (has('camera') && keys.length > 1) viewer.setCamera(state.camera); // 로봇 변경 등 외부 변경

  const floorChanged = state.settings.floorEnabled !== lastFloorEnabled;
  const singularityChanged = plan && has('features') && state.features.singularity !== planSingularity;
  lastFloorEnabled = state.settings.floorEnabled;
  if (!has('selectedRobotId') && (has('features') || has('thresholds') || has('obstacles') || floorChanged)) {
    rebuildSafety();
    // 계획 이후 충돌 환경이 바뀌면 결과가 더 이상 유효하지 않을 수 있다 (실행은 여전히 안전 검사를 거침)
    if (plan && (has('thresholds') || has('obstacles') || floorChanged || singularityChanged)) setPlanUI({ stale: true });
  }
}

// ---------- 안전 감지 ----------

/**
 * 기즈모 드래그 중 미리보기: 장애물 충돌 감지가 켜져 있으면 지금 놓았을 때 걸릴 링크와 장애물을 하이라이트한다.
 * 상태 저장과 알람은 드래그를 놓을 때(onObstacleTransform) 처리한다.
 */
function previewObstacleDrag(id, patch) {
  const s = getState();
  if (!s.features.obstacleCollision || isAlarmActive()) return;
  const ctx = createSafetyContext(currentRobot, {
    features: { obstacleCollision: true },
    thresholds: s.thresholds,
    obstacles: envObstacles(s.obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o))),
    floor: s.settings.floorEnabled,
    tool: grip && { spec: grip.spec, opening: grip.opening },
  });
  const hits = evaluatePose(ctx, controller.current.q).obstacle.hits.filter((h) => h.obstacleId === id);
  viewer.setHighlights({ links: hits.map((h) => h.link), obstacles: hits.length ? [id] : [] });
}

/** 베이스(고정부)는 충돌 검사 대상이 아니므로, 장애물이 베이스와 겹치면 안내만 한다 */
function warnBaseOverlap(obstacles) {
  const base = linkSegments(currentRobot, controller.current.frames).find((seg) => seg.link === 0);
  const hit = compileObstacles(obstacles.filter((o) => o.visible !== false)).find((ob) => capsuleObstacleDistance(base, ob) < 0);
  if (hit) showNotice(`장애물 '${hit.name}'이(가) 로봇 베이스와 겹칩니다. 베이스는 충돌 검사에서 제외되므로 위치를 확인하세요.`);
}

/** 로봇/환경 변경 시 검사 컨텍스트 재생성 후 현재 자세 재평가. 정지 상태에서도 위반이면 알람. */
function rebuildSafety() {
  const s = getState();
  const ctx = createSafetyContext(currentRobot, {
    features: s.features,
    thresholds: s.thresholds,
    obstacles: envObstacles(s.obstacles), // 드로스 셀의 고정 설비(포트 벽·스나우트·드로스 박스) 포함
    floor: s.settings.floorEnabled,
    tool: grip && { spec: grip.spec, opening: grip.opening },
    attached: grip?.attached ?? null,
    // 저장된 모드가 물리면 물리엔진을 불러오는 중에도 물리 규칙(손가락 접촉 허용)으로 검사 — 복원 직후 오알람 방지
    physicsMode: !!physics || s.settings.simMode === 'physics',
  });
  ctx.releasedId = grip?.releasedId ?? null;
  if (physics && lastPoses) applyPosesToSafety(ctx, lastPoses); // 물리 모드: 배치가 아니라 현재 물체 위치로 검사
  const evaluation = controller.setContext(ctx, clampJoints(currentRobot, s.joints));
  renderSafetyReadout(evaluation);
  if (evaluation.violations.length && !isAlarmActive()) {
    controller.stop();
    const alarm = describeAlarm(evaluation, evaluation.violations);
    if (restoring) alarm.messages.unshift('복원된 자세가 이미 위반 상태입니다');
    raiseAlarm(alarm, { log: !restoring, sound: !restoring });
  }
}

/**
 * 평가 결과 → 알람 내용 (유형, 메시지, 하이라이트 대상).
 * violations에 들어 있는 대상(key)만 보고한다 → 이미 위반 중이던 대상과 새로 막힌 대상을 구분.
 */
function describeAlarm(evaluation, violations) {
  const types = violationTypes(violations);
  const keys = new Set(violations.map((v) => v.key));
  const messages = [];
  const links = new Set();
  const obstacles = new Set();
  const { self, obstacle, singularity, q } = evaluation;

  if (types.includes('SELF') && self) {
    const seen = new Set();
    for (const [a, b] of self.pairs) {
      const key = `${a}-${b}`;
      if (seen.has(key) || !keys.has(`S:${key}`)) continue;
      seen.add(key);
      links.add(a).add(b);
      messages.push(`${linkName(a)} ↔ ${linkName(b)}`);
    }
  }
  if (types.includes('OBSTACLE') && obstacle) {
    const names = new Map(envObstacles(getState().obstacles).map((o) => [o.id, o.name]));
    names.set('floor', '바닥');
    for (const r of coord.robots.values()) names.set(`robot:${r.slot}`, `${r.F.S.label} 측면 로봇 (${r.robot.name})`);
    const seen = new Set();
    for (const { link, obstacleId } of obstacle.hits) {
      const key = `${link}-${obstacleId}`;
      if (seen.has(key) || !keys.has(`O:${link}:${obstacleId}`)) continue;
      seen.add(key);
      links.add(link);
      obstacles.add(obstacleId);
      messages.push(`${linkName(link)} ↔ ${names.get(obstacleId) ?? obstacleId}`);
    }
  }
  if (types.includes('SINGULARITY')) {
    const m = singularity.metrics;
    for (const kind of singularity.kinds) {
      if (!keys.has(`G:${kind}`)) continue;
      const value =
        kind === 'wrist' ? `J5 → ${q[4].toFixed(1)}°`
        : kind === 'elbow' ? `팔 펴짐 → ${m.elbowDeg.toFixed(1)}°`
        : `손목중심-J1축 → ${m.shoulderMm.toFixed(0)} mm`;
      messages.push(`${singularityLabel(kind)} 특이점 진입 감지 (${value})`);
      if (kind === 'wrist') links.add(5).add(6);
      if (kind === 'elbow') links.add(2).add(4);
      if (kind === 'shoulder') links.add(1);
    }
  }
  return { types, messages, links: [...links], obstacles: [...obstacles] };
}

/** 링크 이름: 스키머를 달았으면 툴(7)은 '스키머' (v1.1.1) */
function linkName(link) {
  if (link === 7 && grip?.spec.kind === 'skimmer') return '스키머 (봉·스쿱)';
  return LINK_NAMES[link];
}

function renderSafetyReadout(evaluation) {
  const { singularity } = evaluation;
  $('#status-w').textContent = `조작성 w ${singularity.manipulability.toFixed(4)}`;
  const chips = $('#safety-chips');
  chips.replaceChildren();
  if (getState().features.singularity && singularity.warnKinds.length && !isAlarmActive()) {
    const m = singularity.metrics;
    for (const kind of singularity.warnKinds) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-warn';
      const v = kind === 'wrist' ? `|J5| ${m.wristDeg.toFixed(1)}°` : kind === 'elbow' ? `${m.elbowDeg.toFixed(1)}°` : `${m.shoulderMm.toFixed(0)} mm`;
      chip.textContent = `특이점 근접: ${singularityLabel(kind)} (${v})`;
      chips.appendChild(chip);
    }
  }
}

// ---------- 메이커 / 모델 ----------

function buildMakerBanners() {
  const nav = $('#maker-banners');
  for (const maker of catalog.makers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'maker';
    btn.dataset.maker = maker.id;
    btn.style.setProperty('--maker-color', maker.color);
    const count = catalog.robots.filter((r) => r.maker === maker.id).length;
    btn.innerHTML = `<span class="maker-name">${maker.name}</span><span class="maker-sub">모델 ${count}종</span>`;
    btn.setAttribute('aria-label', `${maker.name} (모델 ${count}종)`);
    btn.addEventListener('click', () => setState({ selectedMaker: maker.id }));
    nav.appendChild(btn);
  }
}

function renderMakerSelection() {
  const { selectedMaker } = getState();
  document.querySelectorAll('.maker').forEach((btn) => {
    const active = btn.dataset.maker === selectedMaker;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const maker = catalog.makers.find((m) => m.id === selectedMaker);
  const caption = $('#maker-caption');
  caption.textContent = maker?.name ?? '';
  caption.style.setProperty('--maker-color', maker?.color ?? '');
}

function renderModelCards() {
  const { selectedMaker, selectedRobotId } = getState();
  const list = $('#model-list');
  list.replaceChildren();
  const reaches = catalog.robots.map((r) => r.reachMm);
  const range = { minReach: Math.min(...reaches), maxReach: Math.max(...reaches) };
  const makerColor = catalog.makers.find((m) => m.id === selectedMaker)?.color;
  for (const robot of catalog.robots.filter((r) => r.maker === selectedMaker)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'model-card' + (robot.id === selectedRobotId ? ' active' : '');
    card.style.setProperty('--maker-color', makerColor);
    card.setAttribute('aria-pressed', String(robot.id === selectedRobotId));
    card.setAttribute('aria-label', `${robot.name}, 가반하중 ${robot.payloadKg} kg, 도달거리 ${robot.reachMm} mm, 근사 모델`);
    card.innerHTML = `
      <div class="thumb-box">${robotThumbnail(robot, range)}<span class="size-tag">${SIZE_LABEL[robot.sizeClass]}</span></div>
      <div class="model-info">
        <div class="model-head">
          <strong>${robot.name}</strong>
          <span class="badge" title="실제 사양을 근사한 DH 모델입니다">근사 모델</span>
        </div>
        <dl class="specs">
          <dt>가반하중</dt><dd>${robot.payloadKg} kg</dd>
          <dt>도달거리</dt><dd>${robot.reachMm.toLocaleString()} mm</dd>
          <dt>축 수</dt><dd>${robot.axes}축</dd>
        </dl>
      </div>`;
    card.addEventListener('click', () => {
      if (robot.id === getState().selectedRobotId) return;
      selectRobot(robot);
      drawers?.close(); // 좁은 화면: 모델을 고르면 드로어를 닫고 3D 뷰를 보여 준다
    });
    list.appendChild(card);
  }
}

/** 로봇 변경: 관절은 홈 자세, 이전 경로 결과 초기화, 장애물/설정은 유지 (PRD FR-3) */
function selectRobot(robot) {
  if (replay) return showNotice('에피소드 재생 중입니다. 재생을 종료한 뒤 로봇을 바꾸세요.');
  // 알람은 Reset으로만 해제한다 (PRD FR-11) → 알람 중에는 로봇 변경도 거부
  if (isAlarmActive()) return showNotice('알람 상태에서는 로봇을 변경할 수 없습니다. Reset 후 변경하세요.');
  stopSkim();
  const cellCam = getState().cell.dross.enabled && drossRobotOk(robot);
  setState({
    selectedRobotId: robot.id,
    selectedMaker: robot.maker,
    joints: homeJoints(robot),
    lastPlan: null,
    camera: cellCam ? CELL_CAMERA : defaultCamera(robot),
  });
}

function applyRobot(state) {
  currentRobot = findRobot(state.selectedRobotId);
  stopSteps(); // 진행 중인 단계 실행(Waypoint 동작·Pick & Place)도 끝낸다 (4-1, M-2)
  const joints = clampJoints(currentRobot, state.joints);
  viewer.loadRobot(currentRobot, forwardKinematics(currentRobot, joints).frames);
  buildJointControls();
  updatePose(joints);
  const maker = catalog.makers.find((m) => m.id === currentRobot.maker);
  const label = $('#viewport-label');
  label.style.setProperty('--maker-color', maker?.color ?? '');
  label.innerHTML =
    `<i></i><strong>${maker?.name ?? currentRobot.maker} ${currentRobot.name}</strong>` +
    `<small>${currentRobot.payloadKg} kg · ${currentRobot.reachMm.toLocaleString()} mm</small><span class="badge">근사 모델</span>`;
  const sidesChanged = syncSideRobots(); // 측면 로봇도 셀 활성 여부를 따른다
  const cellChanged = syncCellScene() || sidesChanged; // 드로스 셀은 대형 로봇에서만 활성 (로봇이 바뀌면 설비·툴·물리 월드를 다시 맞춘다)
  applyGripper({ robotChanged: true }); // 그리퍼 치수는 로봇 크기별 → 다시 만들고 안전 검사·물리 바디도 갱신
  if (cellChanged && physics) {
    createWorld(physics.RAPIER);
    viewer.setObstacles(state.obstacles);
    rebuildSafety();
  }
  appliedDross = state.cell.dross;
  renderDrossUI();
  waypointPanel?.renderList();
  // 계획: 다른 로봇의 결과는 버리고, 같은 로봇의 저장된 결과(lastPlan)는 복원
  cancelPlan(true);
  if (state.lastPlan?.robotId === currentRobot.id) setPlan(state.lastPlan.path, state.lastPlan.blends, state.lastPlan.stats, { persist: false });
  else clearPlan();
  planPanel?.renderInputs();
}

// ---------- 기능 토글 / 임계값 ----------

function buildFeatureToggles() {
  const box = $('#feature-toggles');
  for (const [key, label, en] of FEATURE_LABELS) {
    const row = document.createElement('label');
    row.className = 'toggle feature-toggle';
    row.innerHTML =
      `<span class="ft-icon">${ICONS[key]}</span><span class="ft-text">${label}<small>${en}</small></span>` +
      `<input type="checkbox" role="switch" data-feature="${key}" aria-label="${label} (${en})" />`;
    row.querySelector('input').addEventListener('change', (e) => {
      setState((s) => ({ features: { ...s.features, [key]: e.target.checked } }));
    });
    box.appendChild(row);
  }
}

function renderFeatureToggles() {
  const { features } = getState();
  document.querySelectorAll('[data-feature]').forEach((input) => {
    input.checked = features[input.dataset.feature];
  });
  // 상태바: 켜진 기능만 아이콘으로 표시
  const on = FEATURE_LABELS.filter(([key]) => features[key]);
  $('#status-features').innerHTML = on.length
    ? on.map(([key, label, en, short]) => `<span class="fi" title="${label} (${en}) 켜짐">${ICONS[key]}${short}</span>`).join('')
    : '<span class="fi-none">안전 감지 꺼짐</span>';
}

function buildThresholdFields() {
  const box = $('#threshold-fields');
  for (const [key, label, unit] of THRESHOLD_FIELDS) {
    const row = document.createElement('label');
    row.className = 'field';
    row.innerHTML = `<span>${label} <small>(${unit})</small></span><input type="number" min="0" step="1" data-threshold="${key}" />`;
    const input = row.querySelector('input');
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v) || v < 0) return renderThresholdFields();
      setState((s) => ({ thresholds: { ...s.thresholds, [key]: v } }));
    });
    box.appendChild(row);
  }
  const mute = document.createElement('label');
  mute.className = 'toggle';
  mute.innerHTML = '<input type="checkbox" role="switch" id="mute-toggle" /><span>알람음 음소거 (Mute)</span>';
  mute.querySelector('input').addEventListener('change', (e) =>
    setState((s) => ({ settings: { ...s.settings, muted: e.target.checked } })),
  );
  box.appendChild(mute);
}

function renderThresholdFields() {
  const { thresholds, settings } = getState();
  document.querySelectorAll('[data-threshold]').forEach((input) => {
    input.value = thresholds[input.dataset.threshold];
  });
  $('#mute-toggle').checked = settings.muted;
}

// ---------- 관절 조그 ----------

function buildJointControls() {
  const box = $('#joint-controls');
  box.replaceChildren();
  currentRobot.jointLimitsDeg.forEach(([lo, hi], i) => {
    const row = document.createElement('div');
    row.className = 'joint';
    row.innerHTML = `
      <label for="j${i}-range">J${i + 1}</label>
      <input type="range" id="j${i}-range" min="${lo}" max="${hi}" step="0.1" />
      <input type="number" id="j${i}-num" min="${lo}" max="${hi}" step="0.1" aria-label="J${i + 1} 각도(°)" />
      <span class="limits"><span>${lo}°</span><span>${hi}°</span></span>`;
    const range = row.querySelector('input[type=range]');
    range.style.setProperty('--z', String(((Math.min(hi, Math.max(lo, 0)) - lo) / (hi - lo)) * 100));
    const num = row.querySelector('input[type=number]');
    range.addEventListener('input', () => jogJoint(i, Number(range.value)));
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (num.value === '' || !Number.isFinite(v)) return syncJointInputs(getState().joints, true);
      if (v < lo || v > hi) flashLimit(row);
      jogJoint(i, v);
    });
    box.appendChild(row);
  });
}

function jogJoint(i, value) {
  // 관절 조그 진행 중이면 그 목표에 이어서 바꾼다 (여러 관절 연속 입력)
  const target = (controller.kind === 'jog' ? controller.source.target : controller.current.q).slice();
  target[i] = value;
  jog(target);
}

/** 조그 명령: 관절별 최대속도로 목표까지 이동 (매 tick 안전 검사) */
function jog(target) {
  if (replay) return showNotice('에피소드 재생 중에는 조작할 수 없습니다. 재생을 종료하세요.');
  if (!controller.jogTo(clampJoints(currentRobot, target))) rejectWhileAlarm();
}

function rejectWhileAlarm() {
  showNotice('알람 상태입니다. Reset 후 조작할 수 있습니다.');
  syncJointInputs(getState().joints, true);
}

// ---------- 직교 조그 / Waypoint ----------

const speedRate = () => getState().settings.speedPct / 100;

/**
 * 직교 조그: 현재(또는 진행 중인 직교 이동의 목표) TCP 포즈에서 한 스텝 이동한 목표를 만들고 직선 보간으로 이동.
 * 월드 기준: 베이스 축 방향 이동 / 베이스 축 회전 (TCP 점 기준). 툴 기준: 플랜지 축 방향 이동 / 플랜지 축 회전.
 */
function cartesianJog(axis, sign) {
  if (isAlarmActive()) return rejectWhileAlarm();
  const { cartFrame, cartStepMm, cartStepDeg } = getState().settings;
  const pending = controller.kind === 'cartesian' ? controller.source.trajectory : null;
  const baseQ = pending ? pending.points[pending.points.length - 1] : controller.current.q;
  const T = tcpMatrix(forwardKinematics(currentRobot, baseQ).frames); // 그리퍼가 있으면 손가락 끝 기준으로 이동·회전
  const R = rotationOf(T);
  const p = origin(T);
  const unit = [0, 0, 0];
  unit[axis % 3] = sign;
  let target;
  if (axis < 3) {
    // 툴 기준이면 툴 축 방향을 베이스 좌표로 변환
    const d = cartFrame === 'tool' ? [0, 1, 2].map((r) => R[r * 3] * unit[0] + R[r * 3 + 1] * unit[1] + R[r * 3 + 2] * unit[2]) : unit;
    target = poseMatrix(R, p.map((v, i) => v + d[i] * cartStepMm));
  } else {
    const rot = expRotation(unit.map((v) => v * cartStepDeg * DEG));
    target = poseMatrix(cartFrame === 'tool' ? mul3(R, rot) : mul3(rot, R), p);
  }
  const res = linearMove(currentRobot, controller.current.q, target, { toolLengthMm: grip?.spec.lengthMm ?? 0 });
  if (!res.ok) return showNotice(`직교 조그 불가: ${res.message}`);
  controller.play(res.trajectory, { kind: 'cartesian' });
}

/** Waypoint로 이동 (관절 보간) */
function moveToWaypoint(wp) {
  const tr = jointMove(currentRobot, controller.current.q, wp.joints);
  if (!controller.play(tr, { kind: 'waypoint', rate: speedRate })) rejectWhileAlarm();
}

/**
 * 현재 로봇의 Waypoint를 순서대로 재생 (현재 자세 → P1 → P2 → …).
 * 각 Waypoint에 도착하면 도착 동작(열기·닫기·대기)을 실행하고, 끝난 뒤 다음으로 간다 (FR-23).
 */
function playSequence() {
  const wps = getState().waypoints.filter((w) => w.robotId === currentRobot.id);
  if (!wps.length) return showNotice('저장된 Waypoint가 없습니다.');
  if (isAlarmActive()) return rejectWhileAlarm();
  const linear = getState().settings.playMode === 'linear';
  const steps = [];
  let q = controller.current.q;
  for (const wp of wps) {
    if (linear) {
      const toolLengthMm = grip?.spec.lengthMm ?? 0; // TCP(손가락 끝)가 직선으로 움직이도록
      const res = linearMove(currentRobot, q, tcpMatrix(forwardKinematics(currentRobot, wp.joints).frames), { qEnd: wp.joints, toolLengthMm });
      if (!res.ok) return showNotice(`직선 보간 불가 — "${wp.name}" 구간: ${res.message}. 관절 보간을 사용해 보세요.`);
      steps.push({ kind: 'move', trajectory: res.trajectory, wpId: wp.id });
    } else {
      steps.push({ kind: 'move', trajectory: jointMove(currentRobot, q, wp.joints), wpId: wp.id });
    }
    const a = wp.action ?? { type: 'none' };
    if (a.type !== 'none') steps.push({ kind: 'action', type: a.type, sec: a.sec, wpId: wp.id });
    q = wp.joints;
  }
  // 진행 표시용 예상 시간 (동작 = 대기 시간 또는 개폐 시간, 속도 100% 기준)
  const estimate = (st) => (st.kind === 'move' ? st.trajectory.duration : st.type === 'wait' ? st.sec : grip?.spec.actuationS ?? 0);
  const starts = [];
  const duration = steps.reduce((t, st) => (starts.push(t), t + estimate(st)), 0);
  setPlayback({ status: 'playing', activeId: steps[0].wpId, t: 0, duration, phase: 'move' });
  runSteps(steps, {
    kind: 'sequence',
    onStep: (i, st) => setPlayback({ ...playback, activeId: st.wpId, t: starts[i], phase: st.kind === 'move' ? 'move' : 'action', actionType: st.type }),
    onProgress: (i, t) => {
      if (Math.abs(starts[i] + t - playback.t) > 0.1) setPlayback({ ...playback, t: starts[i] + t });
    },
  }).then((result) => {
    setPlayback(IDLE);
    if (result === 'done') showNotice('Waypoint 재생 완료');
    if (result === 'blocked') showNotice(isAlarmActive() ? '재생 중 위반이 감지되어 정지했습니다.' : '알람 상태입니다. Reset 후 재생하세요.');
  });
}

// ---------- 단계 실행 (PRD_v.1.1.0 FR-23·24): 이동 → 도착 동작(열기·닫기·대기) → … ----------

let stepRun = null; // 실행 중인 단계 시퀀스 { cancelled, paused } (Waypoint 재생, Pick & Place)

/**
 * 이동·동작 단계를 순서대로 실행한다. 이동은 MotionController(적용 전 안전 검사)로, 동작은 끝날 때까지 기다린다.
 * 정지(Esc·정지 버튼)·알람이면 남은 단계를 실행하지 않는다.
 * @param steps [{ kind: 'move', trajectory } | { kind: 'action', type: 'open'|'close'|'wait', sec } | { kind: 'grip', cmd, objectId, objectPos }]
 * @returns {Promise<'done'|'stopped'|'blocked'|'failed'>}
 */
async function runSteps(steps, { kind, onStep, onProgress } = {}) {
  if (stepRun) stepRun.cancelled = true; // 이전 실행은 끝낸다 (두 실행이 번갈아 로봇을 움직이지 않도록, 4-1 M-2)
  const run = { cancelled: false, paused: false };
  stepRun = run;
  let result = 'done';
  for (let i = 0; i < steps.length && result === 'done'; i++) {
    if (run.cancelled) result = 'stopped';
    else if (isAlarmActive()) result = 'blocked';
    else {
      const st = steps[i];
      stepLabel = st.label ?? (st.kind === 'action' ? (st.type ?? st.cmd) : '');
      onStep?.(i, st);
      result = st.kind === 'move' ? await playStep(st.trajectory, kind, (t) => onProgress?.(i, t)) : await runAction(st, run);
    }
  }
  if (stepRun === run) {
    stepRun = null;
    stepLabel = '';
  }
  return result;
}

function playStep(tr, kind, onProgress) {
  return new Promise((resolve) => {
    const started = controller.play(tr, { kind, rate: speedRate, onProgress, onEnd: (reason) => resolve(reason) });
    if (!started) resolve('blocked');
  });
}

/**
 * 조건이 참이 될 때까지(그리고 seconds가 지날 때까지) 기다린다. 일시정지 중에는 시간이 흐르지 않는다.
 * 시간은 시뮬레이션 시계(simClock)로 센다 — 로봇 이동·물리와 같은 기준 (v1.1.1, m-6: 느린 PC·탭 전환에서도 같은 결과)
 */
function waitUntil(run, done, seconds = 0) {
  return new Promise((resolve) => {
    let remain = seconds;
    let last = simClock;
    const step = () => {
      if (run.cancelled) return resolve('stopped');
      if (isAlarmActive()) return resolve('blocked');
      if (!run.paused) remain -= simClock - last;
      last = simClock;
      if (!run.paused && remain <= 0 && done()) return resolve('done');
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** 도착 동작 / Pick & Place 그리퍼 단계 */
async function runAction(st, run) {
  const type = st.cmd ?? st.type;
  if (type === 'wait') return waitUntil(run, () => true, st.sec ?? 1);
  if (type === 'until') return waitUntil(run, st.until); // 조건 대기 (드로스 셀: 측면 로봇이 포트에서 나올 때까지)
  if (!grip) {
    showNotice('그리퍼가 꺼져 있어 열기/닫기 동작을 건너뜁니다.');
    return 'done';
  }
  if (type === 'close' && st.objectId) {
    // FR-24: 파지 직전 물체 위치 재확인 — 계획 때와 허용 오차 이상 다르면 정지
    const p = lastPoses?.get(st.objectId);
    const moved = !p || p.out ? Infinity : Math.hypot(...p.pos.map((v, i) => v - st.objectPos[i]));
    if (moved > OBJECT_MOVED_TOLERANCE_MM) {
      showNotice(`물체 위치 변경 — 다시 계획 필요 (계획 때보다 ${Number.isFinite(moved) ? `${moved.toFixed(0)} mm` : '범위 밖으로'} 이동)`, 10000);
      setPlanUI({ stale: true });
      return 'failed';
    }
  }
  const r = gripperCommand(type);
  if (r?.ok === false) return 'failed';
  const res = await waitUntil(run, () => !!grip && grip.opening === grip.target && !grip.pendingGrasp);
  if (res !== 'done') return res;
  if (type === 'close' && st.objectId && grip?.attached?.id !== st.objectId) {
    showNotice('파지 실패: 물체를 집지 못했습니다 — 다시 계획 필요', 10000);
    return 'failed';
  }
  return 'done';
}

/** 진행 중인 단계 시퀀스·모션·그리퍼 개폐 정지 (Esc, 정지 버튼, 로봇 변경) */
function stopSteps() {
  skim.auto = false; // 드로스 자동 연속 실행도 끝낸다
  if (stepRun) stepRun.cancelled = true;
  controller.stop();
  freezeGripper();
}

/** 그리퍼 개폐를 현재 폭에서 멈춘다 (4-1, M-4: Esc·알람이 그리퍼에도 적용) */
function freezeGripper() {
  if (!grip || (grip.opening === grip.target && !grip.pendingGrasp)) return;
  grip.target = grip.opening;
  grip.pendingGrasp = null;
  if (controller.ctx?.tool) controller.ctx.tool.opening = grip.opening;
  renderGripperUI();
}

/** 로봇 이동 또는 단계 실행(대기·그리퍼 동작 포함) 중 (4-1, M-2) */
const robotBusy = () => controller.active || !!stepRun || skim.status === 'planning' || coord.busy || !!replay;

/**
 * 물리 실행/일시정지 (배지·패널 버튼). 재개할 때 일시정지 중 움직인 로봇·파지 물체를 바로 옮기고,
 * 물체와 겹쳐 있으면 안내한다 (4-1, m-1 결정 (a))
 */
function togglePhysicsRun() {
  if (!physics) return;
  physicsRunning = !physicsRunning;
  if (physicsRunning) {
    physics.placeRobot(physicsSegments());
    if (grip?.attached) physics.moveAttached(controller.current.frames[6], true);
    const ctx = controller.ctx;
    const segs = physicsSegments().filter((s) => s.link !== 8); // 손가락은 물체와 닿아도 됨
    const hit = ctx && checkObstacleCollision(segs, ctx.compiled, 0, { floor: false, skip: ctx.obstacleSkip }).hits[0];
    if (hit) {
      const name = envObstacles(getState().obstacles).find((o) => o.id === hit.obstacleId)?.name ?? hit.obstacleId;
      showNotice(`물리 재개: 로봇이 물체 '${name}'와 겹쳐 있습니다(일시정지 중 이동). 물체 위치를 확인하세요.`, 10000);
    }
  }
  renderSimUI();
}


// ---------- 자동 경로 계획 (2-C): A·B만 지정 → 중간 경유점 자동 생성 ----------

let planJob = null; // 진행 중인 Worker 요청 { id, onProgress, resolve }

function getPlanWorker() {
  if (!planWorker) {
    planWorker = new Worker(new URL('./planner.worker.js', import.meta.url), { type: 'module' });
    planWorker.onmessage = onPlanMessage;
    planWorker.onerror = (e) => {
      console.error('[planner] worker error', e);
      planWorker.terminate();
      planWorker = null;
      const job = planJob;
      planJob = null;
      // 모듈을 불러오지 못하면 브라우저가 메시지 없는 오류를 준다 → 가장 흔한 원인(예전 파일 캐시)과 해결법 안내
      const detail = e.message
        ? e.message
        : '경로 계획 모듈을 불러오지 못했습니다. 브라우저에 예전 버전 파일이 캐시되어 있을 수 있습니다. ' +
          'start.bat 창을 닫고 다시 실행하거나, 브라우저 캐시(Ctrl+Shift+Delete → 캐시된 이미지 및 파일)를 지운 뒤 새로고침하세요.';
      job?.resolve({ ok: false, reason: 'error', message: `경로 계획 Worker 오류 — ${detail}` });
    };
  }
  return planWorker;
}

function onPlanMessage(e) {
  const msg = e.data;
  if (!planJob || msg.requestId !== planJob.id) return; // 이전(취소된) 요청의 응답은 무시
  if (msg.type === 'progress') return planJob.onProgress?.(msg);
  const job = planJob;
  planJob = null;
  job.resolve(msg);
}

/**
 * Worker에 경로 계획 요청 (한 번에 하나, 새 요청은 이전 요청을 취소). 결과 메시지로 resolve된다.
 * 충돌·자기충돌은 항상, 특이점은 계획 옵션(planAvoidSingularity)에 따라 회피한다.
 */
function runPlanner({ start, goal }, onProgress, overrides = {}) {
  cancelPlanJob();
  planRequestId += 1;
  const s = getState();
  const id = planRequestId;
  return new Promise((resolve) => {
    planJob = { id, onProgress, resolve };
    getPlanWorker().postMessage({
      type: 'plan',
      requestId: id,
      robot: currentRobot,
      obstacles: obstaclesSnapshot(),
      thresholds: s.thresholds,
      floor: s.settings.floorEnabled,
      avoidSingularity: s.settings.planAvoidSingularity,
      // 그리퍼·파지 물체도 충돌 모델에 포함, TCP 지정 목표는 손가락 끝 기준 (FR-21, 22)
      tool: grip && { spec: grip.spec, opening: grip.opening },
      attached: grip?.attached ?? null,
      physicsMode: !!physics,
      reference: controller.current.q.slice(), // TCP 지정 시 현재 자세에 가까운 IK 해 우선
      start,
      goal,
      timeoutMs: PLAN_TIMEOUT_MS,
      ...overrides, // Pick & Place: 구간별 장애물(집을 물체 제외)·파지 물체
    });
  });
}

/** 진행 중인 Worker 요청을 조용히 취소 (기다리던 쪽에는 superseded 결과를 돌려준다) */
function cancelPlanJob() {
  if (!planJob) return;
  planWorker?.postMessage({ type: 'cancel', requestId: planJob.id });
  const job = planJob;
  planJob = null;
  job.resolve({ ok: false, reason: 'cancelled', message: '경로 계획을 취소했습니다.', superseded: true });
}

/** 패널의 A/B 지정 → 플래너 입력 (현재 자세·Waypoint는 관절값, TCP는 그대로) */
function toPlanSpec(spec, label) {
  if (spec.type === 'current') return { spec: { type: 'joints', joints: controller.current.q.slice() } };
  if (spec.type === 'waypoint') {
    const wp = getState().waypoints.find((w) => w.id === spec.id && w.robotId === currentRobot.id);
    return wp ? { spec: { type: 'joints', joints: wp.joints.slice() } } : { error: `${label} Waypoint를 찾을 수 없습니다.` };
  }
  return { spec };
}

async function requestPlan(req) {
  if (!getState().features.autoPathPlanning) return;
  if (req.task === 'pick') return requestPickPlace(req);
  const { start, goal } = req;
  const a = toPlanSpec(start, 'A(시작)'), b = toPlanSpec(goal, 'B(목표)');
  if (a.error || b.error) return setPlanUI({ error: a.error ?? b.error });
  if (controller.kind?.startsWith('plan')) controller.stop();
  clearPlan();
  setPlanUI({ status: 'planning', progress: 0, nodes: 0, error: null, stale: false });
  const snapshot = physics && lastPoses ? new Map([...lastPoses].map(([id, p]) => [id, p.pos.slice()])) : null; // 복사 (poses는 재사용 배열)
  const res = await runPlanner({ start: a.spec, goal: b.spec }, (p) => setPlanUI({ progress: p.ratio, nodes: p.nodes }));
  if (res.ok) planObjectSnapshot = snapshot;
  if (res.superseded) return;
  if (res.ok) {
    setPlan(res.path, res.blends, res.stats, { persist: true });
    showNotice(`경로 생성 완료: 중간 경유점 ${Math.max(0, res.path.length - 2)}개 (${res.stats.timeMs} ms)`);
  } else {
    setPlanUI({ status: 'idle', error: `${PLAN_REASON_LABEL[res.reason] ?? res.reason}: ${res.message}` });
  }
}

/** 진행 중인 계획 요청 취소. silent면 UI 상태를 바꾸지 않는다 (새 요청/로봇 변경 시). */
function cancelPlan(silent = false) {
  if (!planJob) return;
  cancelPlanJob();
  if (!silent) setPlanUI({ status: plan ? 'ready' : 'idle', error: '경로 계획을 취소했습니다.' });
}

/** 계획 결과 적용: 시간 파라미터화, 3D 미리보기(경유점 라벨 A·1·2…·B), (persist면) lastPlan 저장 */
function setPlan(path, blends, stats, { persist }) {
  const trajectory = pathTrajectory(currentRobot, path, blends);
  planSingularity = getState().features.singularity;
  plan = { path, trajectory };
  const vertices = renderPlanPreview();
  setPlanUI({ status: 'ready', stats, vertices, duration: trajectory.duration, error: null, stale: false });
  if (persist) setState({ lastPlan: { robotId: currentRobot.id, path, blends, stats, createdAt: new Date().toISOString() } });
}

/** 계획 경로 3D 미리보기 (TCP 궤적·경유점 라벨). 그리퍼가 바뀌면 TCP가 달라지므로 다시 그린다. */
function renderPlanPreview() {
  const tcpOf = (q) => tcpPose(q).pos;
  const { path, trajectory } = plan;
  const vertices = plan.vertexMeta
    ? plan.vertexMeta.map((v) => ({ label: v.label, kind: v.kind, tcp: tcpOf(v.q) })) // Pick & Place: 집기·놓기 표시
    : path.map((q, i) => ({ label: i === 0 ? 'A' : i === path.length - 1 ? 'B' : String(i), tcp: tcpOf(q) }));
  viewer.setPlanPreview(trajectory.points.map(tcpOf), vertices);
  if (planUI.vertices) setPlanUI({ vertices });
  return vertices;
}

function clearPlan() {
  plan = null;
  planObjectSnapshot = null;
  viewer.setPlanPreview(null);
  setPlanUI({ status: 'idle', stats: null, vertices: null, error: null, stale: false });
}

function setPlanUI(patch) {
  planUI = { ...planUI, ...patch };
  planPanel?.render(planUI);
}

function onPlanFeatureChange(enabled) {
  if (enabled) return planPanel.render(planUI);
  cancelPlan();
  if (controller.kind?.startsWith('plan')) controller.stop();
  planPanel.render(planUI);
}

/** 궤적 재생 후 완료 여부로 resolve ('done'이면 true) */
function playAndWait(tr, kind) {
  return new Promise((resolve) => {
    const started = controller.play(tr, { kind, rate: speedRate, onEnd: (reason) => resolve(reason === 'done') });
    if (!started) {
      rejectWhileAlarm();
      resolve(false);
    }
  });
}

/**
 * 로봇을 A(계획 경로 시작)로 보낸다.
 * - 계획 경로 위에 있으면 경로를 거꾸로 되밟는다 (실행 완료·도중 정지 후).
 * - 경로 밖이면 현재 자세 → A 경로를 새로 계획해서(충돌·특이점 회피) 이동한다.
 * @returns {Promise<boolean>} A에 도착했으면 true
 */
async function moveToPlanStart() {
  if (!plan) return false;
  if (isAlarmActive()) {
    rejectWhileAlarm();
    return false;
  }
  if (atPlanStart()) return true;
  const q = controller.current.q;
  let best = 0, bestDist = Infinity;
  plan.trajectory.points.forEach((p, i) => {
    const d = Math.max(...p.map((v, k) => Math.abs(v - q[k])));
    if (d < bestDist) { bestDist = d; best = i; }
  });
  let tr;
  if (bestDist < 2 && !plan.task) {
    tr = reverseTrajectory(currentRobot, plan.trajectory, best, q); // 경로 위 → 되밟기 (Pick & Place는 물체가 옮겨졌으므로 새로 계획)
  } else {
    setPlanUI({ status: 'approach', progress: 0, error: null });
    const res = await runPlanner({ start: { type: 'joints', joints: q.slice() }, goal: { type: 'joints', joints: plan.path[0] } }, (p) =>
      setPlanUI({ progress: p.ratio }),
    );
    if (res.superseded) return false;
    if (res.ok) {
      tr = pathTrajectory(currentRobot, res.path, res.blends);
    } else if (res.reason === 'start-collision') {
      // 현재 자세가 계획 여유거리 안이면 계획할 수 없으므로 직접 이동 (실행 중 안전 검사는 계속 동작)
      tr = jointMove(currentRobot, q, plan.path[0]);
      showNotice('현재 자세가 장애물에 가까워 A로 직접 이동합니다.');
    } else {
      setPlanUI({ status: 'ready', error: `A로 이동할 경로를 찾지 못했습니다 — ${PLAN_REASON_LABEL[res.reason] ?? res.reason}: ${res.message}` });
      return false;
    }
  }
  setPlanUI({ status: 'running', error: null });
  const arrived = await playAndWait(tr, 'plan-approach');
  setPlanUI({ status: plan ? 'ready' : 'idle' });
  return arrived && atPlanStart();
}

async function runPlan() {
  if (!plan) return;
  if (isAlarmActive()) return rejectWhileAlarm();
  if (planUI.status === 'paused' && (stepRun || controller.kind?.startsWith('plan'))) {
    controller.resume();
    if (stepRun) stepRun.paused = false;
    return setPlanUI({ status: 'running' });
  }
  if (!atPlanStart()) {
    showNotice('A(시작)로 먼저 이동한 뒤 경로를 실행합니다.');
    if (!(await moveToPlanStart())) return;
  }
  if (plan.task) return runTask();
  setPlanUI({ status: 'running' });
  const done = await playAndWait(plan.trajectory, 'plan');
  setPlanUI({ status: plan ? 'ready' : 'idle' });
  if (done) showNotice('경로 실행 완료 (B 도착)');
  else if (isAlarmActive()) showNotice('경로 실행 중 위반이 감지되어 정지했습니다.');
}

function rewindPlan() {
  moveToPlanStart().then((ok) => ok && showNotice('A(시작)에 도착했습니다.'));
}

/** 자동 생성 경유점을 Waypoint 목록에 추가 (이름: 경로N-A, 경로N-1, …, 경로N-B) */
function savePlanAsWaypoints() {
  if (!plan) return;
  const n = new Set(getState().waypoints.filter((w) => w.name.startsWith('경로')).map((w) => w.name.split('-')[0])).size + 1;
  const stamp = Date.now().toString(36);
  const last = plan.path.length - 1;
  // Pick & Place: 파지점 = 닫기, 놓기점 = 열기 동작을 함께 저장 (FR-24)
  const ACTION_OF = plan.task ? { start: { type: 'open' }, pick: { type: 'close' }, place: { type: 'open' } } : {};
  const SUFFIX = { pick: '(집기)', place: '(놓기)' };
  const added = plan.path.map((q, i) => {
    const kind = plan.vertexMeta?.[i]?.kind;
    return {
      id: `wp-${stamp}-${i}`,
      name: `경로${n}-${i === 0 ? 'A' : i === last ? 'B' : i}${SUFFIX[kind] ?? ''}`,
      robotId: currentRobot.id,
      joints: q.map((v) => Math.round(v * 1000) / 1000),
      action: ACTION_OF[kind] ?? { type: 'none' },
    };
  });
  setState((s) => ({ waypoints: [...s.waypoints, ...added] }));
  showNotice(`경유점 ${added.length}개(A, 중간 ${added.length - 2}개, B)를 Waypoint 목록에 추가했습니다.` + (plan.task ? ' 집기·놓기 지점에는 닫기·열기 동작이 들어 있습니다.' : ''));
}

/**
 * Pick & Place 계획 (FR-24): 집을 물체와 놓을 위치 → task.js가 구간별로 플래너(Worker)를 불러 접근·파지·운반·놓기·후퇴를 만든다.
 * 그리퍼가 켜져 있고 물리 모드일 때만. 계획 시점의 물체 위치를 정적 장애물로 쓴다(스냅샷).
 */
async function requestPickPlace({ objectId, place, graspDir, approachMm }) {
  const err = (m) => setPlanUI({ status: plan ? 'ready' : 'idle', error: `Pick & Place: ${m}` });
  if (!grip) return err('그리퍼를 켜세요 (그리퍼 패널).');
  if (grip.spec.kind === 'skimmer') return err('드로스 셀의 스키머 툴로는 할 수 없습니다. 드로스 셀을 끄면 그리퍼로 돌아갑니다.');
  if (!physics) return err('물리 모드에서 사용할 수 있습니다 (물체 · 시뮬레이션 패널에서 물리 모드로 바꾸세요).');
  if (grip.attached) return err('이미 물체를 잡고 있습니다. 먼저 그리퍼를 열어 놓으세요.');
  const s = getState();
  const layout = s.obstacles.find((o) => o.id === objectId);
  const p = lastPoses?.get(objectId);
  if (!layout || layout.visible === false || !p || p.out) return err('집을 물체를 찾을 수 없습니다.');
  let placeT;
  if (place.type === 'waypoint') {
    const wp = s.waypoints.find((w) => w.id === place.id && w.robotId === currentRobot.id);
    if (!wp) return err('놓을 위치 Waypoint를 찾을 수 없습니다.');
    placeT = tcpMatrix(forwardKinematics(currentRobot, wp.joints).frames);
  } else {
    placeT = poseMatrix(rotationFromRPY(place.rpy), place.pos);
  }
  if (controller.kind?.startsWith('plan')) controller.stop();
  clearPlan();
  setPlanUI({ status: 'planning', progress: 0, nodes: 0, error: null, stale: false });
  const snapshot = new Map([...lastPoses].map(([id, q]) => [id, q.pos.slice()]));
  const t0 = performance.now();
  let superseded = false;
  const res = await planPickPlace(
    {
      robot: currentRobot,
      q0: controller.current.q.slice(),
      spec: grip.spec,
      object: { id: objectId, name: layout.name, type: layout.type, size: layout.size.slice(), pos: p.pos.slice(), R: p.R.slice() },
      massKg: physics.mass(objectId), // 질량 한계는 계획 단계에서 확인 (m-5)
      placeT,
      graspDir,
      approachMm,
      obstacles: obstaclesSnapshot(),
      thresholds: s.thresholds,
      floor: s.settings.floorEnabled,
      avoidSingularity: s.settings.planAvoidSingularity,
    },
    {
      plan: async (req) => {
        const r = await runPlanner({ start: req.start, goal: req.goal }, (pg) => setPlanUI({ progress: pg.ratio, nodes: pg.nodes }), {
          obstacles: req.obstacles, tool: req.tool, attached: req.attached, physicsMode: req.physicsMode,
        });
        if (r.superseded) superseded = true;
        return r;
      },
    },
  );
  if (superseded) return;
  if (!res.ok) return setPlanUI({ status: 'idle', error: `Pick & Place 실패 — ${res.message}` });
  planObjectSnapshot = snapshot;
  planSingularity = s.features.singularity;
  plan = { task: true, objectId, path: res.vertices.map((v) => v.q), vertexMeta: res.vertices, steps: res.steps, trajectory: res.trajectory };
  const vertices = renderPlanPreview();
  const stats = { task: true, objectName: layout.name, timeMs: Math.round(performance.now() - t0), placeRaisedMm: res.placeRaisedMm };
  setPlanUI({ status: 'ready', stats, vertices, duration: res.trajectory.duration, error: null, stale: false });
  showNotice(`Pick & Place 경로 생성 완료: ${layout.name} (${stats.timeMs} ms)`);
}

/** Pick & Place 실행: 이동 구간은 안전 게이트, 파지 직전 물체 위치 재확인, 파지 성공 확인 */
async function runTask() {
  setPlanUI({ status: 'running', error: null });
  const result = await runSteps(plan.steps, { kind: 'plan', onStep: (i, st) => showNotice(`Pick & Place ${i + 1}/${plan.steps.length}: ${st.label}`, 4000) });
  setPlanUI({ status: plan ? 'ready' : 'idle' });
  if (result === 'done') showNotice('Pick & Place 완료');
  else if (result === 'blocked') showNotice('Pick & Place 실행 중 위반이 감지되어 정지했습니다.');
}

// ---------- 그리퍼 (PRD_v.1.1.0 FR-21, FR-22) ----------

/**
 * 물리엔진에 보낼 로봇 형상: 파지한 물체(9)는 물리 바디가 따로 있으므로 뺀다.
 * 스키머는 안전 검사용 보수 캡슐 대신 실제 스쿱 형상(박스 4개)을 써서 드로스를 떠 담는다 (v1.1.1).
 */
function physicsSegments() {
  const segs = controller.current.segments.filter((s) => s.link !== 9 && s.part !== 'plate');
  if (grip?.spec.kind === 'skimmer') segs.push(...skimmerBoxes(grip.spec, controller.current.frames[6]));
  return segs;
}

/** TCP 자세 (4x4): 그리퍼가 있으면 손가락 끝(플랜지 + 길이), 없으면 플랜지 */
const tcpMatrix = (frames) => (grip ? multiply(frames[6], toolMatrix(grip.spec.lengthMm)) : frames[6]);

function tcpPose(q) {
  const T = tcpMatrix(forwardKinematics(currentRobot, q).frames);
  return { pos: origin(T), rpy: rotationToRPY(T) };
}

/**
 * 그리퍼 설정(사용 여부·치수)을 적용: 로봇 변경·사용 스위치·치수 변경 시.
 * 파지 중이면 먼저 놓고, 손가락은 열린 상태로 시작한다. 안전 검사·물리 바디·TCP 표시를 다시 만든다.
 * @param robotChanged 로봇 변경에서 호출 (계획 결과는 applyRobot이 따로 정리)
 */
function applyGripper({ robotChanged = false } = {}) {
  const g = getState().settings.gripper;
  appliedGripperSettings = g;
  if (grip?.attached) releaseObject({ silent: true });
  // 드로스 셀이 활성이면 스키머 툴, 아니면 그리퍼 설정을 따른다
  const spec = cellActive() ? { ...SKIMMER_SPEC } : g.enabled ? gripperSpec(currentRobot, g.overrides) : null;
  grip = spec
    ? { spec, opening: spec.maxOpenMm, target: spec.maxOpenMm, pendingGrasp: null, attached: null, releasedId: null, lastObjPos: null, vel: [0, 0, 0] }
    : null;
  viewer.setGripper(spec, spec?.maxOpenMm);
  telem.set('main', new JointTelemetry(currentRobot, spec, { seed: 1 })); // 로봇·툴이 바뀌면 질량·정격을 다시 계산
  rebuildSafety();
  physics?.setRobot(physicsSegments());
  updatePose(controller.current.q);
  renderWaypointMarkers();
  if (!robotChanged && plan) {
    renderPlanPreview();
    setPlanUI({ stale: true }); // 충돌 모델(그리퍼)이 바뀌었으므로 다시 생성 권장
  }
  renderGripperUI();
}

function renderGripperUI() {
  if (!gripperPanel || !currentRobot) return;
  const g = getState().settings.gripper;
  const spec = grip?.spec ?? gripperSpec(currentRobot, g.overrides);
  let state = 'open';
  if (grip) {
    if (grip.attached) state = 'holding';
    else if (grip.opening < grip.target - 1e-6) state = 'opening';
    else if (grip.opening > grip.target + 1e-6) state = 'closing';
    else if (grip.opening < spec.maxOpenMm - 1e-6) state = 'closed';
  }
  const holding = grip?.attached && getState().obstacles.find((o) => o.id === grip.attached.id);
  gripperPanel.render({
    robot: currentRobot,
    toolNote: grip?.spec.kind === 'skimmer' ? '드로스 셀 사용 중: 스키머 툴(봉 700 mm + 스쿱 360×360 mm)이 달려 있습니다. 셀을 끄면 그리퍼 설정이 다시 적용됩니다.' : '',
    enabled: g.enabled,
    spec,
    overridden: Object.keys(g.overrides[currentRobot.id] ?? {}),
    state,
    opening: grip?.opening ?? spec.maxOpenMm,
    holdingName: holding?.name ?? '',
  });
}

/** 그리퍼 설정 변경은 로봇이 멈춰 있고 알람이 없을 때만 (충돌 모델이 바뀌므로) */
function gripperSettingsBlocked() {
  if (cellActive()) {
    showNotice('드로스 셀 사용 중에는 스키머 툴이 달려 있습니다. 셀을 끈 뒤 그리퍼를 설정하세요.');
  } else if (robotBusy()) {
    showNotice('로봇이 움직이는 중에는 그리퍼 설정을 바꿀 수 없습니다. 정지한 뒤 바꾸세요.');
  } else if (isAlarmActive()) {
    showNotice('알람 상태에서는 그리퍼 설정을 바꿀 수 없습니다. Reset 후 바꾸세요.');
  } else return false;
  renderGripperUI();
  return true;
}

function setGripperSettings(patch) {
  if (gripperSettingsBlocked()) return;
  setState((s) => ({ settings: { ...s.settings, gripper: { ...s.settings.gripper, ...patch } } })); // → onStateChange → applyGripper
}

function setGripperOverride(key, value) {
  const g = getState().settings.gripper;
  const id = currentRobot.id;
  const mine = { ...(g.overrides[id] ?? {}) };
  if (value === GRIPPER_DEFAULTS[currentRobot.sizeClass]?.[key]) delete mine[key];
  else mine[key] = value;
  const overrides = { ...g.overrides };
  if (Object.keys(mine).length) overrides[id] = mine;
  else delete overrides[id];
  setGripperSettings({ overrides });
}

function resetGripperOverride() {
  const overrides = { ...getState().settings.gripper.overrides };
  delete overrides[currentRobot.id];
  setGripperSettings({ overrides });
}

/** 파지 후보 계산용 물체 목록: 물리 모드의 현재 자세 + 배치의 형상 */
function graspObjects() {
  const out = [];
  for (const o of getState().obstacles) {
    const p = lastPoses?.get(o.id);
    if (!p || p.out) continue;
    out.push({ id: o.id, type: o.type, size: o.size, pos: p.pos, R: p.R });
  }
  return out;
}

/**
 * 열기/닫기 명령 (버튼, 단축키 G). 'toggle'이면 지금 닫혀 있거나 파지 중이면 열고, 아니면 닫는다.
 * 닫기: 물리 모드에서 손가락 사이에 물체가 있으면 그 폭까지 닫은 뒤 파지(질량 한계 확인).
 * @returns {{ ok: boolean } | undefined} 질량 초과면 ok: false (단계 실행이 멈춘다)
 */
function gripperCommand(cmd) {
  if (!grip) return showNotice('그리퍼가 꺼져 있습니다. 그리퍼 패널에서 켜세요.');
  if (grip.spec.kind === 'skimmer') {
    showNotice('스키머 툴은 열기/닫기 동작이 없습니다 (건너뜀).');
    return { ok: true };
  }
  if (isAlarmActive()) return rejectWhileAlarm();
  if (cmd === 'toggle') cmd = grip.attached || grip.target < grip.spec.maxOpenMm - 1e-6 ? 'open' : 'close';
  grip.pendingGrasp = null;
  if (cmd === 'open') {
    if (grip.attached) releaseObject();
    grip.target = grip.spec.maxOpenMm;
  } else if (!grip.attached) {
    grip.target = 0;
    if (!physics) {
      showNotice('고정 모드에서는 손가락만 움직입니다. 물리 모드에서 파지할 수 있습니다.');
    } else {
      const cand = findGraspCandidate(grip.spec, controller.current.frames[6], grip.opening, graspObjects());
      if (cand) {
        const mass = physics.mass(cand.id);
        if (mass > grip.spec.maxPayloadKg) {
          grip.target = grip.opening;
          showNotice(`파지 실패: 질량 초과 (${mass.toFixed(1)} kg > ${grip.spec.maxPayloadKg} kg)`, 10000);
          renderGripperUI();
          return { ok: false };
        } else {
          grip.target = Math.min(grip.opening, cand.widthMm);
          grip.pendingGrasp = cand.id;
        }
      }
    }
  }
  renderGripperUI();
  return { ok: true };
}

/**
 * 손가락 개폐 1스텝 (60 Hz). 개폐 속도 = 최대 벌림 폭 / 개폐 시간.
 * 바뀐 폭으로 현재 자세를 다시 평가해서 새 위반이 생기거나 기존 위반이 깊어지면(이동 검사와 같은 규칙)
 * 그 폭에서 멈추고 알람 ("그리퍼 동작 중 충돌"). 위반에서 벗어나는 방향(열기)은 허용된다.
 */
function tickGripper(dt) {
  if (!grip || isAlarmActive() || !controller.ctx || grip.opening === grip.target) return;
  const { spec } = grip;
  const step = (spec.maxOpenMm / spec.actuationS) * dt;
  const d = grip.target - grip.opening;
  const next = Math.abs(d) <= step ? grip.target : grip.opening + Math.sign(d) * step;
  const ctx = controller.ctx;
  ctx.tool.opening = next;
  const e = evaluatePose(ctx, controller.current.q);
  const fresh = blockedViolations(e, controller.current);
  if (fresh.length) {
    ctx.tool.opening = grip.opening;
    grip.target = grip.opening;
    grip.pendingGrasp = null;
    controller.stop();
    const alarm = describeAlarm(e, fresh);
    alarm.messages.unshift('그리퍼 동작 중 충돌');
    raiseAlarm(alarm);
    renderGripperUI();
    return;
  }
  controller.current = e;
  grip.opening = next;
  viewer.setGripperOpening(next);
  if (next === grip.target) {
    if (grip.pendingGrasp) graspObject(grip.pendingGrasp);
    else if (physics && next === 0) showNotice('빈 손 닫힘 (손가락 사이에 집을 물체가 없습니다)');
  }
  renderGripperUI();
}

/** 파지: 물체를 플랜지 기준 상대 자세(rel)로 붙인다. 안전 검사에서는 로봇의 일부(링크 9)가 된다. */
function graspObject(id) {
  grip.pendingGrasp = null;
  const ob = getState().obstacles.find((o) => o.id === id);
  const p = lastPoses?.get(id);
  const T6 = controller.current.frames[6];
  // 닫는 동안 물체가 손가락 사이에서 빠져나갔으면 끝까지 닫는다
  if (!physics || !ob || !p || p.out || !findGraspCandidate(grip.spec, T6, grip.opening + 2, [{ id, type: ob.type, size: ob.size, pos: p.pos, R: p.R }])) {
    grip.target = 0;
    return showNotice('파지 실패: 물체가 손가락 사이에서 벗어났습니다');
  }
  const rel = multiply(invertRigid(T6), poseMatrix(p.R, p.pos));
  const attached = { id, type: ob.type, size: ob.size.slice(), rel, ignore: [] };
  physics.attach(id, rel);
  const ctx = controller.ctx;
  setAttached(ctx, attached);
  ctx.releasedId = null;
  // 집는 순간 이미 맞닿아 있던 받침(물체·바닥)은 들어 올려 떨어질 때까지 파지 물체의 검사에서 제외
  const e = evaluatePose(ctx, controller.current.q);
  attached.ignore = [...new Set((e.obstacle?.hits ?? []).filter((h) => h.link === 9).map((h) => h.obstacleId))];
  controller.current = evaluatePose(ctx, controller.current.q);
  Object.assign(grip, { attached, releasedId: null, lastObjPos: null, vel: [0, 0, 0] });
  showNotice(`파지: ${ob.name} (${physics.mass(id).toFixed(2)} kg)`);
}

/** 놓기: 동적 바디로 되돌리고 그리퍼(물체) 속도를 넘겨준다 */
function releaseObject({ silent = false } = {}) {
  if (!grip?.attached) return;
  const { id } = grip.attached;
  physics?.detach(grip.vel);
  grip.attached = null;
  grip.releasedId = physics ? id : null;
  if (controller.ctx) {
    setAttached(controller.ctx, null);
    controller.ctx.releasedId = grip.releasedId;
    controller.current = evaluatePose(controller.ctx, controller.current.q);
  }
  if (!silent) showNotice(`놓기: ${getState().obstacles.find((o) => o.id === id)?.name ?? id}`);
  renderGripperUI();
}

/** 물리 모드 종료·리셋으로 물체가 사라졌을 때: 파지 상태만 지운다 (물리 바디 조작 없음) */
function dropGripState() {
  if (!grip) return;
  Object.assign(grip, { attached: null, pendingGrasp: null, releasedId: null, lastObjPos: null, vel: [0, 0, 0] });
  if (grip.target < grip.opening) grip.target = grip.opening;
}

/**
 * 물리 스텝마다: 파지한 물체를 플랜지에 붙여 움직이고(속도 기록), 집을 때·놓을 때의 검사 제외 대상이
 * 여유거리 밖으로 떨어졌으면 다시 검사에 넣는다.
 */
function tickGripperPhysics() {
  if (!grip || !controller.ctx) return;
  const ctx = controller.ctx;
  const margin = getState().thresholds.obstacleMarginMm;
  const segs = controller.current.segments;
  if (grip.attached) {
    const T6 = controller.current.frames[6];
    physics.moveAttached(T6);
    const pos = origin(multiply(T6, grip.attached.rel));
    if (grip.lastObjPos) grip.vel = pos.map((v, i) => (v - grip.lastObjPos[i]) / SIM_DT);
    grip.lastObjPos = pos;
    if (grip.attached.ignore.length) {
      const seg = segs.find((s) => s.link === 9);
      grip.attached.ignore = grip.attached.ignore.filter((id) => {
        if (id === 'floor') return Math.min(seg.a[2], seg.b[2]) - seg.r < margin;
        const ob = ctx.compiled.find((o) => o.id === id);
        return !!ob && capsuleObstacleDistance(seg, ob) < margin;
      });
    }
  }
  if (grip.releasedId) {
    const ob = ctx.compiled.find((o) => o.id === grip.releasedId);
    const body = segs.find((s) => s.link === 7);
    if (!ob || !body || capsuleObstacleDistance(body, ob) >= margin) grip.releasedId = ctx.releasedId = null;
  }
}

// ---------- 물리 시뮬레이션 (PRD_v.1.1.0 2장, FR-17~20) ----------

/**
 * 사용자가 모드 스위치를 눌렀을 때. 모드는 시뮬레이션 전체 단위이며(규칙 0), 로봇이 멈춰 있을 때만 바꾼다.
 */
function requestSimMode(mode) {
  if (mode === getState().settings.simMode || simLoading) return;
  if (robotBusy()) return showNotice('로봇이 움직이는 중에는 시뮬레이션 모드를 바꿀 수 없습니다. 정지한 뒤 바꾸세요.');
  if (isAlarmActive()) return showNotice('알람 상태에서는 시뮬레이션 모드를 바꿀 수 없습니다. Reset 후 바꾸세요.');
  setState((s) => ({ settings: { ...s.settings, simMode: mode } })); // → onStateChange → applySimMode
}

/** 모드 적용. 물리: 물리엔진을 (필요하면) 불러와 배치에서 시작 / 고정: 물리 종료, 물체를 배치로 복원 */
async function applySimMode(mode) {
  if (mode === 'physics') {
    simLoading = true;
    simError = null;
    renderSimUI();
    let RAPIER;
    try {
      RAPIER = await loadRapier();
    } catch (err) {
      console.error('[physics] Rapier 로딩 실패', err);
      simLoading = false;
      simError = `물리엔진을 불러오지 못해 고정 모드로 동작합니다 (${err.message ?? err}). 인터넷 연결을 확인하세요.`;
      activeSimMode = 'static';
      setState((s) => ({ settings: { ...s.settings, simMode: 'static' } }));
      rebuildSafety(); // 고정 모드 규칙으로 다시 검사
      renderSimUI();
      return;
    }
    simLoading = false;
    activeSimMode = 'physics';
    createWorld(RAPIER);
    physicsRunning = true;
    layoutChanged = false;
    viewer.setPhysicsMode(true);
    $('#gizmo-tools').hidden = true;
    rebuildSafety();
    renderSimUI();
    // 물리 모드로 바꿔도 안전 감지 토글은 그대로 둔다 (결정 2) — 장애물 감지가 켜져 있으면 안내만
    if (getState().features.obstacleCollision && !physicsNoticeShown) {
      physicsNoticeShown = true;
      showNotice('물리 모드에서도 장애물 충돌 감지가 켜져 있어, 로봇이 그리퍼 손가락 외의 부분으로 물체에 닿으면 정지합니다. 물체를 밀어서 움직이려면 기능 설정에서 장애물 충돌 감지를 끄세요.', 12000);
    }
  } else {
    stopSkim();
    physics?.dispose();
    physics = null;
    drossField = null;
    drossStats = null;
    viewer.setDross(null);
    lastPoses = null;
    physicsRunning = false;
    dropGripState(); // 파지 중이던 물체는 배치 위치로 돌아간다
    renderDrossUI();
    layoutChanged = false;
    activeSimMode = 'static';
    viewer.setPhysicsMode(false);
    viewer.setObstacles(getState().obstacles); // 배치 위치로 복원
    rebuildSafety();
    renderSimUI();
  }
}

/** 리셋: 물체를 배치 위치로 되돌려 다시 시작 (로봇 정지 중에만) */
function resetPhysics() {
  if (!physics) return;
  if (robotBusy()) return showNotice('로봇이 움직이는 중에는 리셋할 수 없습니다.');
  // 같은 월드를 다시 쓰면 바디 순서·내부 캐시가 달라져 결과가 바뀐다 → 새 월드로 시작 (4-1, M-1 / NFR-10)
  createWorld(physics.RAPIER);
  viewer.setObstacles(getState().obstacles);
  viewer.setObjectPoses(lastPoses);
  rebuildSafety();
  renderSimUI();
  showNotice(drossField ? '물체와 드로스를 처음 배치로 되돌렸습니다.' : '물체를 배치 위치로 되돌렸습니다.');
}

/**
 * 새 물리 월드: 설비(드로스 셀) → 물체(배치) → 로봇 → 드로스 순서로 만든다 (같은 순서 = 같은 결과, NFR-10).
 * 모드 전환·리셋·셀 켜기/끄기에서 같이 쓴다.
 */
function createWorld(RAPIER) {
  physics?.dispose();
  physics = new PhysicsWorld(RAPIER, { gravity: getState().settings.gravity });
  appliedGravity = getState().settings.gravity;
  physics.setFixtures(cellFixtures());
  physics.load(getState().obstacles);
  dropGripState();
  physics.setRobot(physicsSegments());
  for (const r of coord.robots.values()) physics.setExtraRobot(r.slot, r.physicsShapes());
  drossField = cellActive() ? new DrossField(physics, getState().cell.dross) : null;
  drossField?.init();
  drossStats = drossField?.stats(drossBins(sideEff)) ?? null;
  viewer.setDross(drossField ? physics.particleState() : null);
  lastPoses = physics.poses();
  layoutChanged = false;
  renderDrossUI();
}

/**
 * 물리 모드 중 배치 편집 반영 (v1.1.1, m-3): 숨김·삭제·추가·크기·물성 변경은 물리 월드에 바로 반영해
 * 화면·안전 검사·물리 셋을 일치시킨다. 위치·회전 편집은 "시작 위치" 변경이므로 리셋할 때 반영한다.
 */
function syncPhysicsObjects(obstacles) {
  const res = physics.syncObjects(obstacles);
  const heldId = grip?.attached?.id;
  if (heldId && (res.removed.includes(heldId) || res.replaced.includes(heldId))) {
    grip.attached = null;
    if (controller.ctx) setAttached(controller.ctx, null);
    showNotice('파지 중이던 물체가 숨김·삭제·변경되어 파지를 해제했습니다.');
  }
  lastPoses = physics.poses();
  const prev = new Map((lastObstacles ?? []).map((o) => [o.id, o]));
  const moved = obstacles.some((o) => {
    const p = prev.get(o.id);
    return p && (p.pos.some((v, i) => v !== o.pos[i]) || (p.rot ?? [0, 0, 0]).some((v, i) => v !== (o.rot ?? [0, 0, 0])[i]));
  });
  if (moved && !layoutChanged) layoutChanged = true;
  renderSimUI();
}

/** 현재 물체 위치를 새 배치로 저장 (범위 이탈 물체는 원래 배치 유지) */
function savePhysicsAsLayout() {
  if (!physics) return;
  let kept = 0;
  const heldId = grip?.attached?.id;
  const next = getState().obstacles.map((o) => {
    // 범위 이탈 물체, 들고 있는 물체(공중 위치가 배치가 되지 않도록, m-7)는 기존 배치를 유지
    if (physics.outOfRange.has(o.id) || o.id === heldId) {
      kept++;
      return o;
    }
    const pose = physics.layoutPose(o.id);
    return pose ? { ...o, ...pose } : o;
  });
  savingLayout = true;
  setState({ obstacles: next });
  savingLayout = false;
  layoutChanged = false;
  renderSimUI();
  const heldName = heldId && getState().obstacles.find((o) => o.id === heldId)?.name;
  showNotice(`현재 물체 위치를 배치로 저장했습니다.${kept ? ` (범위 이탈·파지 중 ${kept}개는 기존 배치 유지${heldName ? ` — 파지 중: ${heldName}` : ''})` : ''}`);
}

/**
 * 외부 물체 충돌 (PRD_v.1.1.0 4.3): 물리 스텝으로 물체가 움직인 뒤 현재 로봇 자세를 다시 평가한다.
 * 장애물 충돌 감지가 켜져 있고, 이전 tick에 없던 물체가 여유거리 안으로 들어오면 정지·알람.
 * 평가 결과는 다음 이동 검사(sweepCheck)의 기준 자세로도 쓴다 (물체 위치가 바뀐 뒤의 기준).
 */
function checkExternalContact() {
  const prev = controller.current;
  const e = evaluatePose(controller.ctx, prev.q);
  controller.current = e;
  if (isAlarmActive() || !getState().features.obstacleCollision) return;
  const fresh = e.violations.filter((v) => v.type === 'OBSTACLE' && !prev.violations.some((p) => p.key === v.key));
  if (!fresh.length) return;
  controller.stop();
  const alarm = describeAlarm(e, fresh);
  alarm.messages.unshift('외부 물체 충돌 (움직이는 물체가 로봇에 접근)');
  raiseAlarm(alarm);
}

/** 계획 이후 물체가 PLAN_STALE_MOVE_MM 이상 움직이면 "다시 생성 권장" (PRD_v.1.1.0 4.4) */
function checkPlanStaleByObjects() {
  // 실행 중에는 검사하지 않는다 (Pick & Place는 실행하면서 물체를 옮긴다 — 끝난 뒤 다시 생성 권장으로 표시됨)
  if (!plan || !planObjectSnapshot || !lastPoses || planUI.stale || planUI.status === 'running') return;
  for (const [id, pos] of planObjectSnapshot) {
    const p = lastPoses.get(id);
    if (!p || Math.hypot(p.pos[0] - pos[0], p.pos[1] - pos[1], p.pos[2] - pos[2]) > PLAN_STALE_MOVE_MM) {
      setPlanUI({ stale: true });
      return;
    }
  }
}

/** 안전 검사 컨텍스트의 물체 위치·회전을 물리 결과로 갱신 (컴파일 결과 재사용, 위치·회전만 교체) */
function applyPosesToSafety(ctx, poses) {
  for (const ob of ctx.compiled) {
    const p = poses.get(ob.id);
    if (p) {
      ob.pos = p.pos;
      ob.R = p.R;
    }
  }
}

/** 경로 계획용 물체 목록: 고정 모드는 배치, 물리 모드는 지금 위치(스냅샷). 범위 이탈 물체는 제외 */
function obstaclesSnapshot() {
  const layout = getState().obstacles;
  if (!physics || !lastPoses) return envObstacles(layout);
  return envObstacles(layout.map((o) => {
    const p = lastPoses.get(o.id);
    if (!p) return o;
    if (p.out) return { ...o, visible: false };
    return { ...o, pos: p.pos.slice(), rot: rpyFromMatrix(p.R) };
  }));
}

// ---------- 드로스 제거 셀 (PRD_v.1.1.1 FR-25~30) ----------

// 셀 전체가 보이는 카메라 (드로스 박스 쪽 위에서 포트를 비스듬히 내려다봄 — 영상의 위에서 본 구도)
const CELL_CAMERA = { pos: [1700, -4300, 6000], target: [1700, -350, 450] };

/** 셀이 실제로 적용되는가: 사용 스위치 ON + 대형 로봇 */
const cellActive = () => !!currentRobot && getState().cell.dross.enabled && drossRobotOk(currentRobot);
/** 고정 설비 (셀이 활성일 때만) */
const cellFixtures = () => (cellActive() ? drossFixtures(sideEff) : []);
/** 안전 검사·경로 계획용 환경 = 고정 설비 + 사용자 물체 */
const envObstacles = (obstacles) => {
  const f = cellFixtures();
  return f.length ? [...f, ...obstacles] : obstacles;
};

/** 셀 3D 장면(설비·욕면)을 현재 상태에 맞춘다. 활성 여부가 바뀌었으면 true */
function syncCellScene() {
  const active = cellActive();
  const changed = active !== !!viewer.cell;
  if (changed || (active && viewer.cellKey !== sideKey)) drawCell();
  return changed;
}

function drawCell() {
  const active = cellActive();
  viewer.setCell(active ? {
    fixtures: drossFixtures(sideEff), bathZ: BATH_Z_MM, pot: POT, snout: SNOUT, bin: BIN,
    sideBins: Object.entries(sideEff).filter(([, c]) => c.robotId).map(([slot, c]) => sideBin(slot, c.binDist)),
  } : null);
  viewer.cellKey = sideKey;
}

/**
 * 측면 로봇 설치/해제 (FR-31): 설정(슬롯별 로봇·모드)이 바뀌거나 셀 활성 여부가 바뀌면
 * 측면 로봇을 다시 만들고, 받침대·측면 박스(설비) → 화면 → 안전 검사 → 물리 월드를 다시 맞춘다.
 */
function syncSideRobots() {
  const d = getState().cell.dross;
  const want = {};
  if (cellActive()) {
    for (const slot of Object.keys(SIDE_SLOTS)) {
      sideMsg[slot] = null;
      const c = d.sides?.[slot];
      const robot = c?.robotId && findRobot(c.robotId);
      if (!robot || !sideRobotOk(robot)) continue;
      const binDist = c.mode === 1 ? sideBinDistFor(robot.id) : undefined;
      sideMsg[slot] = c.mode === 1 && binDist == null ? `${robot.name}: 도달 범위가 짧아 모드 1(측면 박스 덤프)을 할 수 없습니다. 모드 2(보조 밀기)를 쓰세요.` : null;
      if (sideMsg[slot]) continue;
      want[slot] = { robotId: robot.id, mode: c.mode, binDist };
    }
  }
  const key = JSON.stringify([want, getState().thresholds.obstacleMarginMm]);
  if (key === sideKey) return false;
  coord.stop();
  coord.main.wantsPot = false;
  for (const slot of coord.robots.keys()) {
    viewer.removeExtraRobot(slot);
    physics?.removeExtraRobot(slot);
    telem.delete(slot);
  }
  if (!Object.keys(want).length && tmUI.robot !== 'main') tmUI.robot = 'main';
  coord.robots.clear();
  sideEff = want;
  sideKey = key;
  const obstacles = envObstacles(getState().obstacles);
  for (const [slot, c] of Object.entries(want)) {
    const robot = findRobot(c.robotId);
    const cr = new CellRobot(slot, robot, c.mode, { thresholds: getState().thresholds, obstaclesWorld: obstacles, binDist: c.binDist });
    if (!cr.lanes.length) sideMsg[slot] = `${robot.name}: 이 자리에서 닿는 레인이 없습니다 (도달 범위 부족).`;
    coord.robots.set(slot, cr);
    telem.set(slot, new JointTelemetry(robot, cr.spec, { seed: slot === 'left' ? 2 : 3 }));
    viewer.setExtraRobot(slot, { robot, baseT: cr.F.baseT, spec: cr.spec, frames: cr.current.frames, label: slot === 'left' ? 'L' : 'R' });
  }
  if (cellActive()) drawCell();
  renderTelemetryUI(); // 계측 '표시할 로봇' 목록에 측면 로봇 반영
  return true;
}

/** 측면 로봇 설정 변경 (패널) */
function setSideConfig(slot, patch) {
  if (robotBusy()) {
    showNotice('로봇이 움직이는 중에는 측면 로봇을 바꿀 수 없습니다. 정지한 뒤 바꾸세요.');
    return renderDrossUI();
  }
  if (isAlarmActive()) {
    showNotice('알람 상태에서는 측면 로봇을 바꿀 수 없습니다. Reset 후 진행하세요.');
    return renderDrossUI();
  }
  setState((st) => {
    const sides = { ...st.cell.dross.sides, [slot]: { ...st.cell.dross.sides[slot], ...patch } };
    return { cell: { ...st.cell, dross: { ...st.cell.dross, sides } } };
  });
}

/** 측면 로봇 설치 결과를 안전 검사·물리 월드에 반영 */
function applySideRobots() {
  if (!syncSideRobots()) return;
  rebuildSafety();
  if (physics) {
    createWorld(physics.RAPIER); // 받침대·측면 박스가 바뀌었으므로 새 월드 (드로스도 처음 배치)
    viewer.setObstacles(getState().obstacles);
    rebuildSafety();
  }
  const names = [...coord.robots.values()].map((r) => `${r.F.S.label} ${r.robot.name}(모드 ${r.mode})`);
  showNotice(names.length ? `측면 로봇 설치: ${names.join(', ')}` : '측면 로봇 없음');
}

/** 셀 설정 변경 반영 (onStateChange) */
function applyCell() {
  const d = getState().cell.dross;
  const prev = appliedDross;
  appliedDross = d;
  if (syncCellScene()) {
    stopSkim();
    syncSideRobots();
    drawCell();
    applyGripper(); // 툴 교체 (그리퍼 ↔ 스키머) + 안전 검사 다시 만들기
    if (physics) {
      createWorld(physics.RAPIER); // 설비·드로스가 바뀌었으므로 새 월드
      viewer.setObstacles(getState().obstacles);
      rebuildSafety();
    }
  } else if (JSON.stringify(d.sides) !== JSON.stringify(prev?.sides)) {
    applySideRobots();
  } else if (drossField && prev) {
    drossField.cfg = { ...drossField.cfg, ratePerMin: d.ratePerMin, immersionMm: d.immersionMm, sweepMmS: d.sweepMmS };
    if (d.count !== prev.count || d.seed !== prev.seed) showNotice("초기 드로스 개수·시드는 '다시 배치'를 누르면 반영됩니다.");
  }
  renderDrossUI();
}

function setDrossEnabled(enabled) {
  if (robotBusy()) {
    showNotice('로봇이 움직이는 중에는 드로스 셀을 켜고 끌 수 없습니다.');
    return renderDrossUI();
  }
  if (isAlarmActive()) {
    showNotice('알람 상태에서는 드로스 셀을 켜고 끌 수 없습니다. Reset 후 진행하세요.');
    return renderDrossUI();
  }
  setState((s) => ({ cell: { ...s.cell, dross: { ...s.cell.dross, enabled } } }));
  if (!enabled) return;
  if (!drossRobotOk(currentRobot)) return showNotice('드로스 셀은 대형 로봇(도달거리 2.4 m 이상)에서 동작합니다. 패널의 "대형 로봇으로 바꾸기"를 누르세요.', 10000);
  viewCell();
  if (getState().settings.simMode !== 'physics') {
    requestSimMode('physics');
    showNotice('드로스를 시뮬레이션하려고 물리 모드로 바꿉니다.');
  }
}

function setDrossField(key, value) {
  setState((s) => ({ cell: { ...s.cell, dross: { ...s.cell.dross, [key]: value } } }));
}

function viewCell() {
  viewer.setCamera(CELL_CAMERA);
  setState({ camera: CELL_CAMERA });
}

/** 같은 메이커의 대형 로봇(없으면 첫 대형 로봇)으로 바꾼다 */
function useLargeRobot() {
  const large = catalog.robots.filter(drossRobotOk);
  const robot = large.find((r) => r.maker === currentRobot.maker) ?? large[0];
  if (robot && robot.id !== currentRobot.id) selectRobot(robot);
}

function setSkim(patch) {
  skim = { ...skim, ...patch };
  renderDrossUI();
}

function renderDrossUI() {
  if (!drossPanel || !currentRobot) return;
  const d = getState().cell.dross;
  drossPanel.render({
    hasSides: coord.robots.size > 0,
    enabled: d.enabled,
    cfg: d,
    robotOk: drossRobotOk(currentRobot),
    robotName: currentRobot.name,
    physics: !!physics && !!drossField,
    status: skim.status === 'running' && stepRun?.paused ? 'paused' : skim.status,
    auto: skim.auto,
    label: skim.label,
    error: skim.error,
    stats: drossStats,
    cycles: skim.cycles,
    lastS: skim.lastS,
    avgS: skim.cycles ? skim.totalS / skim.cycles : 0,
    busy: robotBusy(),
    sides: {
      candidates: catalog.robots.filter(sideRobotOk).map((r) => ({ id: r.id, name: r.name, maker: r.maker, cobot: !!r.cobot, reachMm: r.reachMm })),
      ...Object.fromEntries(Object.keys(SIDE_SLOTS).map((slot) => {
        const c = d.sides?.[slot] ?? { robotId: null, mode: 1 };
        const r = coord.robots.get(slot);
        return [slot, {
          robotId: c.robotId, mode: c.mode,
          error: sideMsg[slot] ?? r?.error ?? null,
          label: r?.label ?? '', cycles: r?.cycles ?? 0, lanes: r?.lanes.length,
          binCount: r && r.mode === 1 ? drossStats?.bins?.[slot] ?? 0 : null,
        }];
      })),
    },
  });
}

/** 실행할 수 없는 이유 (없으면 null) */
function skimBlocked() {
  if (!cellActive()) return '드로스 셀을 켜고 대형 로봇을 선택하세요.';
  if (!physics || !drossField) return '물리 모드에서 실행할 수 있습니다 (물체 · 시뮬레이션 패널).';
  if (isAlarmActive()) return '알람 상태입니다. Reset 후 실행하세요.';
  if (robotBusy() || skim.status !== 'idle') return '로봇이 움직이는 중입니다. 정지한 뒤 실행하세요.';
  if (!physicsRunning) return '물리 시뮬레이션이 일시정지 상태입니다. 실행(▶)한 뒤 시작하세요.';
  return null;
}

/** 스키밍 실행: auto면 정지(Esc·정지 버튼)·알람·실패까지 사이클을 반복한다 (FR-28) */
async function startSkim(auto) {
  const why = skimBlocked();
  if (why) return showNotice(why);
  if (plan) clearPlan(); // 3D 경로 미리보기를 스키밍 경로로 쓴다
  setSkim({ auto, error: null });
  if (coord.robots.size) coord.start(auto ? Infinity : 1); // 측면 로봇: 자동 = 계속, 1사이클 = 1회씩
  let result;
  do {
    result = await skimOnce();
    // 자동 연속: 드로스가 새로 생기거나(발생률) 측면 로봇이 밀어 줄 수 있으면 기다렸다가 다시 본다
    if (result === 'empty' && skim.auto && (getState().cell.dross.ratePerMin > 0 || coord.robots.size)) {
      // 자동 연속 + 드로스 발생 중: 쌓일 때까지 기다렸다가 다시 본다
      setSkim({ status: 'running', label: '작업 영역이 깨끗합니다 — 드로스가 쌓이길 기다리는 중' });
      const run = { cancelled: false, paused: false };
      stepRun = run;
      result = await waitUntil(run, () => true, 5);
      if (stepRun === run) stepRun = null;
    }
  } while (result === 'done' && skim.auto);
  coord.main.wantsPot = false;
  if (result !== 'done' && result !== 'empty') coord.stop();
  setSkim({ status: 'idle', auto: false, label: '' });
  if (result === 'empty') showNotice('작업 영역에 떠낼 드로스가 없습니다.');
  if (result === 'blocked') showNotice('스키밍 중 위반이 감지되어 정지했습니다.');
}

/** 스키밍 1사이클: 레인 선택 → 계획 → 미리보기 → 단계 실행 */
async function skimOnce() {
  const s = getState();
  const spec = grip.spec;
  // 모드 1 측면 로봇이 있는 쪽은 구역 경계 안쪽 레인만 (FR-33)
  const lanes = skimLanes(spec, s.thresholds.obstacleMarginMm, mainLaneRange(spec, sideEff));
  const pick = chooseLane(lanes, physics.particleState(), spec, skim.lastLane);
  if (!pick || pick.count < 1) return 'empty';
  const lock = [...coord.robots.values()].some((r) => r.mode >= 2);
  if (lock) coord.main.wantsPot = true; // 모드 2·3 측면 로봇은 이제 새 밀기를 시작하지 않는다
  coord.main.etaS = 0;
  // 쓸기 방향 (v3.0.0 [A]): 스나우트 쪽이면 같은 레인을 반대로(앞벽 쪽에서 스나우트 쪽으로). 측면 로봇이 있으면 로봇 쪽만
  const ld = s.cell.dross.laneDir ?? 'robot';
  const toSnout = !coord.robots.size && (ld === 'snout' || (ld === 'alternate' && skim.dirFlip));
  const lane = toSnout ? { ...pick.lane, start: [pick.lane.xe, pick.lane.y], end: [pick.lane.xs, pick.lane.y] } : pick.lane;
  setSkim({ status: 'planning', label: `레인 ${pick.lane.index + 1}/${lanes.length} (드로스 ${pick.count}개)${toSnout ? ' · 스나우트 쪽으로' : ''}` });
  const obstacles = obstaclesSnapshot();
  let superseded = false;
  const res = await planSkimCycle(
    {
      robot: currentRobot,
      q0: controller.current.q.slice(),
      spec,
      lane,
      immersionMm: s.cell.dross.immersionMm,
      sweepMmS: s.cell.dross.sweepMmS,
      obstacles,
      thresholds: s.thresholds,
      floor: s.settings.floorEnabled,
      avoidSingularity: s.settings.planAvoidSingularity,
      cell: { corridor: coord.robots.size > 0 }, // 측면 로봇이 있으면 박스 쪽 통로로만 오간다
    },
    {
      plan: async (req) => {
        const r = await runPlanner({ start: req.start, goal: req.goal }, null, { obstacles: req.obstacles, tool: req.tool, attached: null, physicsMode: true });
        if (r.superseded) superseded = true;
        return r;
      },
    },
  );
  if (superseded || skim.status !== 'planning') return 'stopped'; // 계획 중 정지
  if (!res.ok) {
    coord.main.wantsPot = false;
    setSkim({ status: 'idle', error: `스키밍 계획 실패 — ${res.message}` });
    return 'failed';
  }
  // 모드 2: 측면 로봇이 포트 안에 있으면 레인 접근 전에 기다리고, 스쿱을 들어 올린 뒤에는 포트를 비워 준다
  const steps = res.steps.slice();
  // 포트를 비워 주는 시점: 스쿱 상승 뒤 (스나우트 쪽 쓸기는 담은 채 돌리기까지 포트 위에 있으므로 그 뒤)
  const turnIdx = steps.findIndex((st) => st.label === '담은 채 돌리기');
  let liftIdx = turnIdx >= 0 ? turnIdx : steps.findIndex((st) => st.label === '스쿱 상승');
  if (lock) {
    steps.unshift({ kind: 'action', type: 'until', label: '측면 로봇이 포트에서 나오길 대기', until: () => !coord.sideInPot() });
    liftIdx++;
  }
  // 3D 미리보기: 실행할 TCP 궤적 + 스윕(주황)·덤프(청록) 지점
  const pts = res.steps.filter((st) => st.kind === 'move').flatMap((st) => st.trajectory.points).map((q) => tcpPose(q).pos);
  viewer.setPlanPreview(pts, res.vertices.map((v) => ({ label: v.label, kind: v.kind, tcp: tcpPose(v.q).pos })));
  setSkim({ status: 'running', laneIndex: pick.lane.index });
  const t0 = simClock;
  const n = steps.length;
  const result = await runSteps(steps, {
    kind: 'skim',
    onStep: (i, st) => {
      if (i > liftIdx) {
        coord.main.wantsPot = false;
        // 모드 3 측면 로봇용: 다음 사이클까지 남은 시간 (이 단계부터 끝까지)
        coord.main.etaS = steps.slice(i).reduce((t, x) => t + (x.kind === 'move' ? x.trajectory.duration : x.sec ?? 0), 0);
      } else coord.main.etaS = 0;
      setSkim({ label: `레인 ${pick.lane.index + 1} · ${i + 1}/${n} ${st.label}` });
    },
  });
  coord.main.wantsPot = false;
  if (result === 'done') {
    const dt = simClock - t0;
    setSkim({ cycles: skim.cycles + 1, lastS: dt, totalS: skim.totalS + dt, lastLane: pick.lane.index, dirFlip: !skim.dirFlip });
  }
  viewer.setPlanPreview(null);
  return result;
}

/** 정지: 자동 연속 해제, 계획 중이면 취소, 실행 중이면 단계 실행 정지 */
function stopSkim() {
  coord.stop();
  coord.main.wantsPot = false;
  if (skim.status === 'idle' && !skim.auto) return renderDrossUI();
  const planning = skim.status === 'planning';
  skim.auto = false;
  if (planning) {
    cancelPlanJob();
    setSkim({ status: 'idle', label: '' });
  }
  if (stepRun) stopSteps();
  renderDrossUI();
}

function renderSimUI() {
  const mode = simLoading ? 'physics' : activeSimMode;
  obstaclePanel?.renderSim({
    mode,
    loading: simLoading,
    error: simError,
    running: physicsRunning,
    layoutChanged,
    awake: physics?.awakeCount ?? 0,
    total: physics?.objects.size ?? 0,
    outOfRange: physics?.outOfRange ?? new Set(),
    pushMode: !getState().features.obstacleCollision,
  });
  // 상단 바 모드 배지 + 3D 뷰 테두리: 물리 모드를 한눈에 구분 (v1.1.0 3단계). 물리 모드에서 배지를 누르면 실행/일시정지
  const badge = $('#sim-badge');
  const phys = activeSimMode === 'physics';
  const paused = phys && !physicsRunning;
  if (badge) {
    badge.textContent = simLoading ? 'PHYS …' : phys ? (paused ? 'PHYS ⏸' : 'PHYS ▶') : 'STATIC';
    badge.className = 'sim-badge' + (phys || simLoading ? ' physics' : '') + (paused ? ' paused' : '');
    badge.title = phys
      ? `시뮬레이션 모드: 물리 (Physics) — ${paused ? '일시정지 중, 누르면 실행' : '실행 중, 누르면 일시정지'}`
      : '시뮬레이션 모드: 고정 (Static) — 누르면 모드 스위치로 이동';
    badge.setAttribute('aria-label', badge.title);
  }
  $('#viewport').classList.toggle('physics', phys);
  $('#viewport').classList.toggle('paused', paused);
}

// ---------- 에피소드 재생 (PRD_v.3.0.0 FR-63 일부): 헤드리스 결과(.rsim.json.gz)를 3D로 다시 보기 ----------
// 재생 중에는 앱의 시뮬레이션(로봇 제어·측면 로봇·물리)을 멈추고 기록된 관절값·드로스 위치만 그린다. 저장 상태는 바꾸지 않는다.

async function readEpisodeFile(file) {
  let text;
  if (/\.gz$/i.test(file.name)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 gzip 풀기(DecompressionStream)를 지원하지 않습니다. 최신 Chrome·Edge를 쓰세요.');
    text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else text = await file.text();
  return parseEpisode(JSON.parse(text));
}

function replayMeta(ep) {
  const s = ep.summary ?? {};
  const name = (id) => findRobot(id)?.name ?? id;
  const side = (slot) => (ep.cell[slot]?.robotId ? `${name(ep.cell[slot].robotId)} · 모드 ${ep.cell[slot].mode}` : '없음');
  const by = s.byRobot ? Object.entries(s.byRobot).map(([k, v]) => `${{ main: '대형', left: '왼쪽', right: '오른쪽' }[k] ?? k} ${v.n}`).join(' · ') : '—';
  return [
    ['대형 로봇', name(ep.cell.main)],
    ['왼쪽 / 오른쪽', `${side('left')} / ${side('right')}`],
    ['드로스', `${ep.task?.dross?.count ?? '—'}개 · 시드 ${ep.task?.dross?.seed ?? '—'}`],
    ['길이', `${ep.frames.at(-1).t.toFixed(0)} s (기록 ${ep.dt} s 간격)`],
    ['최종 회수율', s.rateCount != null ? `${s.rateCount}% (질량 ${s.rateMass}%) — 목표 ${s.targetRatePct}% ${s.reached ? `도달 ${s.reachS} s` : '미도달'}` : '—'],
    ['로봇별 회수', by],
    ['흘림', s.spilled ?? '—'],
  ];
}

async function openReplay(file) {
  if (isAlarmActive()) return showNotice('알람 상태입니다. Reset 후 재생하세요.');
  let ep;
  try {
    ep = await readEpisodeFile(file);
  } catch (err) {
    return replayPanel.render({ active: false, status: `불러오기 실패: ${err.message}` });
  }
  showEpisode(ep, file.name);
}

/** 읽은 에피소드를 3D로 재생 (파일 또는 학습 결과) */
function showEpisode(ep, name) {
  if (isAlarmActive()) return showNotice('알람 상태입니다. Reset 후 재생하세요.');
  const main = findRobot(ep.cell.main);
  const sides = {};
  const missing = [];
  if (!main) missing.push(ep.cell.main);
  for (const slot of Object.keys(SIDE_SLOTS)) {
    const c = ep.cell[slot];
    if (!c?.robotId) continue;
    const robot = findRobot(c.robotId);
    if (!robot) missing.push(c.robotId);
    else sides[slot] = { robot, robotId: c.robotId, mode: c.mode, binDist: c.binDist ?? undefined };
  }
  if (missing.length) return replayPanel.render({ active: false, status: `불러오기 실패: 로봇 모델을 찾을 수 없습니다 (${missing.join(', ')})` });
  if (replay) clearReplayRobots();
  stopAll();
  coord.stop();
  for (const slot of coord.robots.keys()) viewer.removeExtraRobot(slot);
  replay = { ep, player: new EpisodePlayer(ep), main, sides };
  // 장면: 기록된 셀(설비·박스) + 대형 로봇(스키머) + 측면 로봇
  viewer.setCell({
    fixtures: drossFixtures(sides), bathZ: BATH_Z_MM, pot: POT, snout: SNOUT, bin: BIN,
    sideBins: Object.entries(sides).map(([slot, c]) => sideBin(slot, c.binDist)),
  });
  viewer.cellKey = null; // 재생이 끝나면 앱 셀을 다시 그린다
  const f0 = ep.frames[0].q;
  viewer.loadRobot(main, forwardKinematics(main, f0.main).frames);
  viewer.setGripper(SKIMMER_SPEC);
  for (const [slot, c] of Object.entries(sides)) {
    viewer.setExtraRobot(`rp-${slot}`, {
      robot: c.robot, baseT: slotFrame(slot).baseT, spec: c.mode === 1 ? SKIMMER_SMALL_SPEC : RAKE_SPEC,
      frames: forwardKinematics(c.robot, f0[slot] ?? homeJoints(c.robot)).frames, label: slot === 'left' ? 'L' : 'R',
    });
  }
  $('#viewport-label').innerHTML = `<i></i><strong>재생 · ${main.name}</strong><small>${name}</small><span class="badge">헤드리스 결과</span>`;
  viewer.setCamera(CELL_CAMERA);
  replayUI.slot = 'main';
  replay.player.playing = true;
  $('[data-sec=replay]')?.scrollIntoView({ block: 'nearest' });
  replayPanel.render({ active: true, status: `재생 중: ${name}`, meta: replayMeta(ep), speed: replay.player.speed, slots: ['main', ...Object.keys(sides)], slot: 'main' });
  renderReplayFrame();
}

function renderReplayFrame() {
  const p = replay.player;
  const s = p.stateAt(p.t);
  viewer.update(forwardKinematics(replay.main, s.q.main).frames);
  for (const [slot, c] of Object.entries(replay.sides)) if (s.q[slot]) viewer.updateExtraRobot(`rp-${slot}`, forwardKinematics(c.robot, s.q[slot]).frames);
  viewer.setDross(s.particles);
  replayPanel.renderFrame({
    t: s.t, duration: p.duration, playing: p.playing, rate: s.rate, rateKg: s.rateKg, label: s.label,
    target: replay.ep.task?.targetRatePct ?? 80, q: s.q, slot: replayUI.slot, history: replay.ep.history,
  });
}

function toggleReplay() {
  if (!replay) return;
  const p = replay.player;
  if (!p.playing && p.t >= p.duration) p.t = 0;
  p.playing = !p.playing;
}

function clearReplayRobots() {
  for (const slot of Object.keys(replay.sides)) viewer.removeExtraRobot(`rp-${slot}`);
}

/** 재생 종료: 앱 장면(현재 로봇·셀·측면 로봇)을 다시 만든다 */
function exitReplay() {
  if (!replay) return;
  clearReplayRobots();
  replay = null;
  sideKey = ''; // 측면 로봇 다시 설치
  viewer.setDross(null);
  applyRobot(getState());
  if (!cellActive()) viewer.setCell(null);
  if (drossField && physics) viewer.setDross(physics.particleState());
  replayPanel.render({ active: false, status: '재생을 마쳤습니다. 원래 장면으로 돌아왔습니다(물리 모드였다면 드로스는 다시 배치됩니다).' });
}

// ---------- 학습 (Trial & Error) (PRD_v.3.0.0 4.5·FR-67): 스트로크 후보를 시도해 점수가 가장 높은 것만 실행 ----------
// 10분 과제 시뮬레이션과 탐색은 lab.worker.js(Worker)에서, 후보 평가는 lab-eval.worker.js 여러 개에서 병렬로 돈다(화면 멈춤 없음).

/** 학습 과제 = 패널(목표·시간) + 지금 앱의 드로스 셀 설정(대형 로봇·측면 로봇·드로스 개수·시드·깊이·속도) */
function buildLabTask(cfgTask = {}) {
  const d = getState().cell.dross;
  const main = currentRobot && drossRobotOk(currentRobot) ? currentRobot.id : 'kuka-kr210-r2700';
  return sanitizeTask({
    targetRatePct: cfgTask.targetRatePct, timeLimitS: cfgTask.timeLimitS, aiRobot: { slot: 'main' },
    cell: { main, left: d.sides?.left ?? { robotId: null, mode: 1 }, right: d.sides?.right ?? { robotId: null, mode: 1 } },
    dross: { count: d.count, seed: d.seed, ratePerMin: 0, immersionMm: d.immersionMm, sweepMmS: d.sweepMmS },
  }, catalog.robots);
}

function labCellText() {
  const { task, errors } = buildLabTask();
  if (errors.length) return `과제 설정 오류: ${errors.join(' / ')}`;
  const n = (id) => findRobot(id)?.name ?? id;
  const side = (c) => (c.robotId ? `${n(c.robotId)} 모드 ${c.mode}` : '없음');
  return `대형(학습 대상): ${n(task.cell.main)} · 왼쪽: ${side(task.cell.left)} · 오른쪽: ${side(task.cell.right)} · 드로스 ${task.dross.count}개(시드 ${task.dross.seed}) — '드로스 제거 셀' 패널 설정을 씁니다.`;
}

function renderLabUI() {
  if (!labPanel) return;
  const r = labRun.result;
  const S = r?.summary, R = r?.rule?.summary;
  const summary = S ? [
    ['학습 회수율', `${S.rateCount}% (질량 ${S.rateMass}%) — 목표 ${S.targetRatePct}% ${S.reached ? `도달 ${S.reachS} s` : '미도달'}`],
    ...(R ? [['규칙 경로 회수율', `${R.rateCount}% (질량 ${R.rateMass}%) ${R.reached ? `도달 ${R.reachS} s` : '미도달'}`]] : []),
    ['대형 스트로크 / 헛질', `${S.decisions} / ${S.emptyStrokes}`],
    ...(S.policy ? [['방식', '학습된 PPO 정책 (시도 없이 관측 → 스트로크)']] : [['시도(후보 평가)', `${S.trials}개 · 규칙 레인이 최선으로 뽑힌 결정 ${S.ruleChosen}`]]),
    ['흘림', `${S.spilled}${R ? ` (규칙 ${R.spilled})` : ''}`],
  ] : [];
  labPanel.render({
    status: labRun.status, running: labRun.running, cellText: labCellText(), target: labRun.task?.targetRatePct ?? 80,
    progress: labRun.progress, decisions: labRun.decisions, summary, hasResult: !!r?.episode, hasRule: !!r?.rule,
  });
}

function startLab(cfg) {
  if (labRun.running) return;
  if (replay) return showNotice('에피소드 재생 중입니다. 재생을 종료한 뒤 학습을 시작하세요.');
  const { task, errors } = buildLabTask(cfg.task);
  if (errors.length) {
    labRun.status = `시작할 수 없습니다: ${errors.join(' / ')}`;
    return renderLabUI();
  }
  const lab = sanitizeLab(cfg.lab);
  if (lab.method === 'policy' && !labRun.policy) {
    labRun.status = "방법 '학습된 정책 실행'은 [정책 불러오기]로 policy-best.json을 먼저 불러와야 합니다.";
    return renderLabUI();
  }
  Object.assign(labRun, { running: true, status: '준비 중…', decisions: [], progress: { rate: 0, t: 0, timeLimitS: task.timeLimitS, elapsedS: 0 }, result: null, task, startedAt: performance.now() });
  const w = new Worker(new URL('./lab.worker.js', import.meta.url), { type: 'module' });
  labRun.worker = w;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'status') {
      labRun.status = m.text;
      // 비교용 규칙 경로 실행 단계 → 학습 진행률 막대는 100%로 두고 '비교 중' 표시
      if (m.text.startsWith('비교용') && labRun.progress) labRun.progress = { ...labRun.progress, t: task.timeLimitS, phase: 'compare' };
    } else if (m.type === 'progress') {
      const p = m.p;
      if (labRun.progress?.phase === 'compare') return renderLabUI(); // 비교 실행의 진행은 학습 막대에 섞지 않음
      labRun.progress = { rate: p.rate, t: p.t, timeLimitS: task.timeLimitS, elapsedS: p.elapsedS };
      if (p.kind === 'decision') labRun.decisions.push(p.decision);
      if (p.kind === 'policy') {
        // 결정 표: 2차 PPO(규칙 레인 기준 조정)면 그대로/반대 방향과 조정량, 보정·규칙 대체 표시
        const pd = p.decision, inf = pd.info ?? {};
        const sg = (v) => (v > 0 ? `+${v}` : `${v}`);
        let what = inf.mode === 'residual' ? `${inf.reversed ? '반대(스나우트 쪽)' : '규칙 레인'} · 조정 X${sg(inf.dx)} Y${sg(inf.dy)} 방향${sg(inf.dh)}° 길이${sg(inf.dl)}` : '정책';
        if (pd.fallback) what += ' · 규칙 대체';
        else if (pd.repaired > 0) what += ' · 보정';
        labRun.decisions.push({ n: pd.n, t: pd.t, rate: pd.rate, best: { score: what, rule: false, values: pd.values }, ruleScore: null });
      }
      labRun.status = `학습 중 · 시뮬레이션 ${p.t.toFixed(0)} / ${task.timeLimitS} s · 회수율 ${p.rate.toFixed(1)}% · 결정 ${labRun.decisions.length} · 경과 ${p.elapsedS.toFixed(0)} s`;
    } else if (m.type === 'done') {
      labRun.result = { summary: m.summary, log: m.log, episode: m.episode, rule: m.rule };
      labRun.status = `${m.stopped ? '중지됨' : '완료'} — ${m.elapsedS.toFixed(0)} s. 아래 버튼으로 3D 재생·저장할 수 있습니다.`;
      finishLab();
    } else if (m.type === 'error') {
      labRun.status = `오류: ${m.message}`;
      finishLab();
    }
    renderLabUI();
  };
  w.onerror = (e) => {
    labRun.status = `Worker 오류: ${e.message ?? e}`;
    finishLab();
    renderLabUI();
  };
  w.postMessage({ cmd: 'start', task, lab, policy: lab.method === 'policy' ? labRun.policy : null, robots: catalog.robots, workers: Math.max(1, Math.min(32, cfg.workers || 4)), compare: !!cfg.compare });
  renderLabUI();
}

function finishLab() {
  labRun.running = false;
  labRun.worker?.terminate();
  labRun.worker = null;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const stampName = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

/** 설정 내보내기 → node tools/train.mjs --lab <파일> */
function exportLab(cfg) {
  const { task } = buildLabTask(cfg.task);
  const out = { schema: 'robosim-lab/1', lab: sanitizeLab(cfg.lab), task, workers: cfg.workers };
  downloadBlob(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }), `robosim-lab-${stampName()}.json`);
  showNotice('학습 설정을 내보냈습니다. 헤드리스: v3.0.0 폴더에서 node tools/train.mjs --lab <파일>', 10000);
}

/** PPO 정책(policy-best.json 등, robosim-policy/1) 불러오기 → 방법 '학습된 정책 실행' */
async function loadLabPolicy(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj.schema !== 'robosim-policy/1') throw new Error(`정책 형식이 아닙니다 (schema = ${obj.schema ?? '없음'})`);
    labRun.policy = obj;
    const e = obj.eval;
    labRun.status = `정책을 불러왔습니다: ${file.name}${e ? ` (학습 평가 회수율 ${e.rate.toFixed(1)}%, ${obj.phase === 'bc' ? '모방 직후' : `PPO 반복 ${obj.iter}`})` : ''}. 방법을 '학습된 정책 실행'으로 두고 ▶ 학습 시작을 누르세요.`;
    const sel = $('#lab-panel [data-lab=method]');
    if (sel) sel.value = 'policy';
  } catch (err) {
    labRun.status = `정책 불러오기 실패: ${err.message}`;
  }
  renderLabUI();
}

async function importLab(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj.schema !== 'robosim-lab/1') throw new Error(`형식이 다릅니다 (schema = ${obj.schema ?? '없음'})`);
    labPanel.load({ lab: sanitizeLab(obj.lab), task: obj.task, workers: obj.workers });
    labRun.status = `설정을 불러왔습니다: ${file.name} (대형·측면 로봇·드로스는 지금 앱 설정을 씁니다)`;
  } catch (err) {
    labRun.status = `설정 불러오기 실패: ${err.message}`;
  }
  renderLabUI();
}

/** 결과 저장: 로그(JSON) + 학습 에피소드(.rsim.json.gz, 3D 재생 파일) */
async function saveLabResult() {
  const r = labRun.result;
  if (!r) return;
  const stamp = stampName();
  downloadBlob(new Blob([JSON.stringify(r.log, null, 1)], { type: 'application/json' }), `robosim-lab-log-${stamp}.json`);
  const gz = async (obj) => new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  if (typeof CompressionStream !== 'undefined') {
    downloadBlob(await gz(r.episode), `robosim-lab-${stamp}.rsim.json.gz`);
    if (r.rule) downloadBlob(await gz(r.rule.episode), `robosim-rule-${stamp}.rsim.json.gz`);
  }
  showNotice('학습 로그와 3D 재생 파일을 저장했습니다.');
}

// ---------- 데이터 관리 (PRD FR-16) ----------

function mountDataActions() {
  const fileInput = $('#import-file');
  const blockedByAlarm = () => {
    if (!isAlarmActive()) return false;
    showNotice('알람 상태에서는 데이터를 가져오거나 초기화할 수 없습니다. Reset 후 진행하세요.');
    return true;
  };
  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([exportState()], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `robosim-lite-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showNotice(`내보내기 완료: ${a.download}`);
  });
  $('#btn-import').addEventListener('click', () => {
    if (!blockedByAlarm()) fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // 같은 파일을 다시 고를 수 있도록
    if (!file || blockedByAlarm()) return;
    if (!confirm(`"${file.name}"의 내용으로 현재 상태를 모두 바꿀까요?`)) return;
    try {
      importState(await file.text());
      showNotice(`가져오기 완료: ${file.name}`);
    } catch (err) {
      showNotice(`가져오기 실패: ${err.message}`);
    }
  });
  $('#btn-reset-data').addEventListener('click', () => {
    if (blockedByAlarm()) return;
    if (!confirm('저장된 모든 데이터(장애물, Waypoint, 설정, 알람 로그 등)를 삭제하고 기본값으로 되돌릴까요?')) return;
    resetState();
    showNotice('데이터를 초기화했습니다.');
  });
}

// ---------- 재생 제어 / 단축키 ----------

function pauseSequence() {
  controller.pause();
  if (stepRun) stepRun.paused = true;
  setPlayback({ ...playback, status: 'paused' });
}

function resumeSequence() {
  if (isAlarmActive()) return rejectWhileAlarm();
  controller.resume();
  if (stepRun) stepRun.paused = false;
  setPlayback({ ...playback, status: 'playing' });
}

function pausePlan() {
  controller.pause();
  if (stepRun) stepRun.paused = true;
  setPlanUI({ status: 'paused' });
}

const atPlanStart = () =>
  !!plan && Math.max(...controller.current.q.map((v, i) => Math.abs(v - plan.path[0][i]))) <= 0.05;

/** Space: 진행 중인 재생을 일시정지/계속. 정지 상태면 계획 경로 시작 자세에서는 경로 실행, 아니면 Waypoint 재생. */
function togglePlayPause() {
  if (replay) return toggleReplay();
  if (isAlarmActive()) return rejectWhileAlarm();
  if (playback.status === 'playing') return pauseSequence();
  if (playback.status === 'paused') return resumeSequence();
  if (skim.status === 'running') return toggleSkimPause();
  if (planUI.status === 'running') return pausePlan();
  if (planUI.status === 'paused') return runPlan();
  if (planUI.status === 'planning' || planUI.status === 'approach') return;
  if (controller.active) return; // 조그 이동 중
  if (planUI.status === 'ready' && getState().features.autoPathPlanning && atPlanStart()) return runPlan();
  playSequence();
}

/** 드로스 스키밍 일시정지/계속 (Space) */
function toggleSkimPause() {
  if (!stepRun) return;
  if (stepRun.paused) {
    if (isAlarmActive()) return rejectWhileAlarm();
    controller.resume();
    stepRun.paused = false;
  } else {
    controller.pause();
    stepRun.paused = true;
  }
  renderDrossUI();
}

/** Esc: 모든 모션 정지, 진행 중인 경로 계획 취소, 열린 드로어/알람 로그 닫기 */
function stopAll() {
  if (replay) replay.player.playing = false;
  stopSkim();
  stopSteps();
  cancelPlan();
  drawers.close();
  if (!$('#alarm-log').hidden) $('#btn-alarm-log').click();
}

function setPlayback(pb) {
  const activeChanged = pb.activeId !== playback.activeId;
  playback = pb;
  waypointPanel.renderPlayback(pb);
  if (activeChanged) renderWaypointMarkers();
}

function renderWaypointMarkers() {
  if (!currentRobot || !viewer) return;
  const markers = getState()
    .waypoints.filter((w) => w.robotId === currentRobot.id)
    .map((w) => ({ id: w.id, pos: tcpPose(w.joints).pos, active: w.id === playback.activeId }));
  viewer.setWaypointMarkers(markers);
}

function flashLimit(row) {
  row.classList.remove('limit-hit');
  void row.offsetWidth; // 애니메이션 재시작
  row.classList.add('limit-hit');
  showNotice('관절 한계를 벗어난 값은 한계값으로 제한됩니다.');
}

function updatePose(joints) {
  const fk = forwardKinematics(currentRobot, joints);
  if (!replay) viewer.update(fk.frames); // 재생 중에는 화면 로봇 = 기록된 로봇
  syncJointInputs(joints, false);
  const T = tcpMatrix(fk.frames); // 그리퍼가 있으면 손가락 끝
  const [x, y, z] = origin(T);
  const [rx, ry, rz] = rotationToRPY(T);
  $('#tcp-readout').innerHTML = [
    ['X', x, 'mm'], ['Y', y, 'mm'], ['Z', z, 'mm'],
    ['Rx', rx, '°'], ['Ry', ry, '°'], ['Rz', rz, '°'],
  ].map(([k, v, u]) => `<dt>${k}</dt><dd>${fmt(v)} <small>${u}</small></dd>`).join('');
}

/**
 * 슬라이더/숫자 입력을 실제 관절값과 동기화.
 * 조그 중 사용자가 잡고 있는 입력은 덮어쓰지 않는다 (force = true면 무조건 동기화).
 */
function syncJointInputs(joints, force) {
  joints.forEach((q, i) => {
    const range = $(`#j${i}-range`);
    const num = $(`#j${i}-num`);
    if (!range) return;
    const busy = controller.active && !force;
    if (force || !(busy && document.activeElement === range)) range.value = q;
    if (force || document.activeElement !== num) num.value = fmt(q);
    // 한계 근접 표시: 범위 양 끝 5% 이내 = 주황, 0.5° 이내 = 빨강
    const [lo, hi] = currentRobot.jointLimitsDeg[i];
    const margin = Math.min(q - lo, hi - q);
    const row = range.parentElement;
    row.classList.toggle('at', margin <= 0.5);
    row.classList.toggle('near', margin > 0.5 && margin <= (hi - lo) * 0.05);
    range.style.setProperty('--p', String(((q - lo) / (hi - lo)) * 100));
  });
}

/** 소수 1자리 표시, -0.0 방지 */
function fmt(v) {
  return (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
}

// ---------- 루프 / 상태바 ----------

/**
 * 측면 로봇 1스텝 (시뮬레이션 60 Hz): 측면 로봇 이동(자기 정적 검사 + 다른 로봇과 간섭 시 대기) →
 * 대형 로봇 안전 컨텍스트에 측면 로봇 현재 형상을 넣는다(대형 로봇의 적용 전 검사가 측면 로봇도 피함).
 */
function tickSideRobots() {
  if (!coord.robots.size) {
    if (controller.ctx) controller.ctx.others = null;
    return;
  }
  coord.tick(SIM_DT, {
    mainSegments: controller.current.segments,
    mainName: `대형 로봇 ${currentRobot.name}`,
    particles: () => (physics ? physics.particleState() : { n: 0, buf: new Float64Array(0) }),
    obstaclesWorld: obstaclesSnapshot,
    paused: isAlarmActive() || !!stepRun?.paused || !physics,
    onBlocked: (r, res) => {
      coord.stop();
      const msg = res.reason === 'hold-timeout'
        ? `${r.F.S.label} 측면 로봇(${r.robot.name}): ${res.other?.name ?? '다른 로봇'}과(와) 간섭으로 ${20}초 넘게 대기 — 정지`
        : `${r.F.S.label} 측면 로봇(${r.robot.name}) 이동 중 위반: ${(res.blocked ?? []).map((v) => v.key).join(', ')}`;
      raiseAlarm({ types: ['OBSTACLE'], messages: [msg], links: [], obstacles: [], sideRobot: [r.slot] });
    },
    onPlanFail: (r) => showNotice(`${r.F.S.label} 측면 로봇 계획 실패 — ${r.error}`, 8000),
  });
  if (controller.ctx) {
    controller.ctx.others = [...coord.robots.values()].map((r) => ({ id: r.slot, name: `${r.F.S.label} 측면 로봇`, segments: r.worldSegments() }));
  }
}

// ---------- 실시간 계측 · 데이터 기록 (PRD_v.1.1.2 FR-37~40) ----------

/**
 * 툴 끝 부하와 욕 잠김 (월드 TCP 기준): 파지 물체 질량 + 스쿱 위 드로스(욕면 밖일 때만 — 잠겨 있으면 부력이 받침),
 * 잠김 = 포트 안에서 TCP가 욕면 아래로 들어간 정도(0~1)
 */
function toolLoad(key, tcpW, spec) {
  let kg = 0, count = 0, imm = 0;
  if (key === 'main' && grip?.attached && physics) kg += physics.mass(grip.attached.id) ?? 0;
  if (spec && (spec.kind === 'skimmer' || spec.kind === 'rake') && cellActive()) {
    const inPot = tcpW[0] > POT.x0 && tcpW[0] < POT.x1 && tcpW[1] > POT.y0 && tcpW[1] < POT.y1;
    const depth = spec.kind === 'skimmer' ? 60 : 70;
    if (inPot) imm = Math.min(1, Math.max(0, (BATH_Z_MM - tcpW[2]) / depth));
    if (physics && drossField) {
      const R = spec.kind === 'skimmer' ? Math.max(spec.plateXMm, spec.plateYMm) / 2 : spec.bladeWMm / 2;
      const up = spec.kind === 'skimmer' ? spec.lipMm + 60 : 60;
      const { n, buf } = physics.particleState();
      let m = 0;
      for (let i = 0; i < n; i++) {
        const r = buf[i * 4 + 3];
        if (!r) continue;
        const dz = buf[i * 4 + 2] - tcpW[2];
        if (dz < -10 || dz > up) continue;
        if (Math.hypot(buf[i * 4] - tcpW[0], buf[i * 4 + 1] - tcpW[1]) > R) continue;
        count++;
        m += physics.particles[i].massKg;
      }
      if (imm === 0) kg += m;
    }
  }
  const out = { kg, count, imm };
  toolLoadCache.set(key, out);
  return out;
}

/** 60 Hz 스텝마다: 대형·측면 로봇의 각도·속도·토크·전류 갱신, 샘플 주기면 기록 */
function tickTelemetry() {
  const mt = telem.get('main');
  if (mt && controller.current) {
    const fr = controller.current.frames;
    const tcp = origin(tcpMatrix(fr));
    const ld = toolLoad('main', tcp, grip?.spec);
    mt.update(controller.current.q, fr, SIM_DT, { tcp, extraKg: ld.kg, immersed: ld.imm });
  }
  for (const r of coord.robots.values()) {
    const t = telem.get(r.slot);
    if (!t) continue;
    const fr = r.current.frames;
    const tcpL = origin(multiply(fr[6], toolMatrix(r.spec.lengthMm)));
    const ld = toolLoad(r.slot, r.F.toWorld(tcpL), r.spec);
    t.update(r.current.q, fr, SIM_DT, { tcp: tcpL, extraKg: ld.kg, immersed: ld.imm });
  }
  if (tmLog.due(simClock)) sampleTelemetry();
  // 그래프 이력 (20 Hz, 최근 30 s)
  if (simClock - tmHistLast >= 1 / HIST_HZ - 1e-9) {
    tmHistLast = simClock;
    for (const [k, t] of telem) {
      if (!t.out) continue;
      let h = tmHist.get(k);
      if (!h) tmHist.set(k, (h = []));
      h.push({ t: simClock, q: t.out.q, qd: t.out.qd, current: t.out.current, tau: t.out.tau });
      if (h.length > HIST_HZ * HIST_S + 5) h.splice(0, h.length - HIST_HZ * HIST_S);
    }
    for (const k of tmHist.keys()) if (!telem.has(k)) tmHist.delete(k);
  }
}

/** 기록 1회: 로봇마다 1행 (시간·상황 라벨 포함) */
function sampleTelemetry() {
  const alarm = isAlarmActive();
  const total = drossStats?.bin ?? '';
  const bath = drossStats ? drossStats.work : '';
  const toolName = (spec) => (spec ? spec.kind ?? 'gripper' : 'none');
  const mt = telem.get('main');
  if (mt?.out) {
    const ld = toolLoadCache.get('main') ?? {};
    const activity = alarm ? 'alarm' : skim.status === 'running' ? 'skim' : skim.status === 'planning' ? 'planning' : controller.kind ?? (stepRun ? 'wait' : 'idle');
    tmLog.push(simClock, {
      robot: 'main', model: currentRobot.name, activity, phase: stepRun ? stepLabel : '',
      cycle: skim.status === 'running' ? skim.cycles + 1 : '', lane: skim.status === 'running' && skim.laneIndex != null ? skim.laneIndex + 1 : '',
      alarm, tel: mt.out, tool: toolName(grip?.spec), loadKg: mt.toolKg + (ld.kg ?? 0), scoopDross: ld.count ?? 0, immersed: ld.imm ?? 0,
      bathDross: bath, collectedOwn: drossStats?.bins?.main ?? '', collectedTotal: total,
    });
  }
  for (const r of coord.robots.values()) {
    const t = telem.get(r.slot);
    if (!t?.out) continue;
    const ld = toolLoadCache.get(r.slot) ?? {};
    const activity = alarm ? 'alarm' : r.status === 'holding' ? 'hold' : r.run ? (r.mode === 1 ? 'skim' : 'push') : 'idle';
    tmLog.push(simClock, {
      robot: r.slot, model: r.robot.name, activity, phase: r.run ? r.label : '',
      cycle: r.run ? r.cycles + 1 : '', lane: r.run ? r.run.laneIndex + 1 : '',
      alarm, tel: t.out, tool: r.spec.kind, loadKg: t.toolKg + (ld.kg ?? 0), scoopDross: ld.count ?? 0, immersed: ld.imm ?? 0,
      bathDross: bath, collectedOwn: r.mode === 1 ? drossStats?.bins?.[r.slot] ?? '' : '', collectedTotal: total,
    });
  }
}

function telemetryRobots() {
  return [{ id: 'main', name: `대형 · ${currentRobot?.name ?? ''}` }, ...[...coord.robots.values()].map((r) => ({ id: r.slot, name: `${r.F.S.label} · ${r.robot.name}` }))];
}

function renderTelemetryUI() {
  if (!tmPanel) return;
  const robots = telemetryRobots();
  if (!robots.some((r) => r.id === tmUI.robot)) tmUI.robot = 'main';
  const last = tmLog.rows.at(-1);
  tmPanel.render({
    show: tmUI.show, robots, robot: tmUI.robot, hz: tmLog.hz, recording: tmLog.recording, graph: tmUI.graph, windowS: tmUI.windowS,
    rows: tmLog.rows.length, durationS: last ? last[0] : 0, full: tmLog.full, cycles: tmLog.cycles.length,
  });
  renderTelemetryOverlay();
}

function renderTelemetryOverlay() {
  if (!tmPanel) return;
  const t = telem.get(tmUI.robot);
  const name = telemetryRobots().find((r) => r.id === tmUI.robot)?.name ?? '';
  const robot = t?.robot;
  tmPanel.renderOverlay(t?.out ? {
    ...t.out, name, ratedA: t.ratedA, ratedTau: t.ratedTau,
    limits: robot.jointLimitsDeg, maxSpeed: robot.maxJointSpeedDegS,
  } : null);
  // 시계열 그래프: '그래프'를 켜고 항목이 하나 이상일 때
  const canvas = $('#telemetry-chart');
  const metrics = METRICS.filter(([k]) => tmUI.show[k]);
  const on = tmUI.graph && metrics.length > 0 && !!t?.out;
  canvas.hidden = !on;
  canvas.style.height = on ? `${Math.min(70 + 90 * metrics.length, 420)}px` : '';
  if (on) drawTelemetryChart(canvas, tmHist.get(tmUI.robot) ?? [], { metrics, windowS: tmUI.windowS, name, light: document.documentElement.dataset.theme === 'light' });
}

/** 엑셀 추출: data · cycles · events · columns · meta 시트 */
function exportTelemetry() {
  if (!tmLog.rows.length) return showNotice('기록된 데이터가 없습니다. ● 기록 시작을 누르세요.');
  const s = getState();
  const d = s.cell.dross;
  const robotsMeta = [...telem.entries()].map(([k, t]) => [`robot.${k}`, `${t.robot.name} · 추정 질량 ${t.massKg.toFixed(0)} kg · 툴 ${t.toolSpec?.kind ?? (t.toolSpec ? 'gripper' : 'none')} ${t.toolKg} kg · 정격전류 ${t.ratedA} A · 정격토크 [${t.ratedTau.map((v) => v.toFixed(0)).join(', ')}] N·m`]);
  const meta = [
    ['app', 'RoboSim Lite v3.0.0'],
    ['exported_at', new Date().toISOString()],
    ['sample_hz', tmLog.hz],
    ['time_base', '시뮬레이션 시간 (60 Hz 스텝 누적, 기록 시작 = 0)'],
    ['sim_mode', s.settings.simMode],
    ['gravity', s.settings.gravity.join(', ')],
    ['dross_cell', d.enabled ? `on · 드로스 ${d.count}개 · 시드 ${d.seed} · 발생률 ${d.ratePerMin}/분 · 잠김 ${d.immersionMm} mm · 스윕 ${d.sweepMmS} mm/s` : 'off'],
    ['side_robots', Object.entries(sideEff).map(([k, c]) => `${k}: ${c.robotId} 모드 ${c.mode}`).join(' / ') || 'none'],
    ['thresholds', JSON.stringify(s.thresholds)],
    ...robotsMeta,
    ['model.current', `전류·토크는 근사 동역학 추정 (실측 아님): 링크 유효 밀도 ${LINK_DENSITY} kg/m³, 정격전류 ${JSON.stringify(RATED_CURRENT_A)} A, 마찰(정격 대비) 쿨롱 ${FRICTION.coulomb}·점성 ${FRICTION.viscous}/(rad/s), 잡음 ${NOISE_PCT}%, 욕 점성 ${BATH_DRAG_NS_M} N·s/m`],
    ['model.columns', 'q=각도(deg), qd=속도(deg/s), qdd=가속도(deg/s²), tau=토크(N·m), i=전류(A) — columns 시트 참고'],
  ];
  const bytes = buildXlsx(tmLog.sheets(meta));
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `robosim-telemetry-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showNotice(`엑셀 추출: ${a.download} (${tmLog.rows.length.toLocaleString()}행, ${(bytes.length / 1e6).toFixed(1)} MB)`);
}

function startLoop() {
  let frames = 0;
  let windowStart = performance.now();
  let lastTime = windowStart;
  let checkMax = 0;
  let checkLast = 0;
  const fpsEl = $('#status-fps');
  const checkEl = $('#status-check');
  let acc = 0;
  const tick = (now) => {
    if (replay) {
      replay.player.advance(Math.min((now - lastTime) / 1000, 0.25));
      lastTime = now;
      acc = 0;
      renderReplayFrame();
      viewer.render();
      requestAnimationFrame(tick);
      return;
    }
    // 고정 60Hz 시뮬레이션 스텝: 렌더 프레임이 느려도 실제 시간과 같은 속도로 움직인다
    acc += Math.min((now - lastTime) / 1000, 0.25); // 탭 비활성 후 큰 점프 방지
    lastTime = now;
    while (acc >= SIM_DT) {
      acc -= SIM_DT;
      simClock += SIM_DT;
      tickSideRobots();
      const ms = controller.tick(SIM_DT);
      if (ms > 0) {
        checkLast = ms;
        checkMax = Math.max(checkMax, ms);
      }
      tickGripper(SIM_DT);
      tickTelemetry();
      if (physics && physicsRunning) {
        const t0 = performance.now();
        physics.moveRobot(physicsSegments()); // 안전 검사를 통과해 적용된 자세 (FR-19)
        for (const r of coord.robots.values()) physics.moveExtraRobot(r.slot, r.physicsShapes());
        tickGripperPhysics(); // 파지한 물체가 플랜지를 따라감 (FR-22)
        physics.step();
        drossField?.tick(SIM_DT); // 드로스 발생 (시뮬레이션 시간 기준)
        lastPoses = physics.poses();
        if (controller.ctx) {
          applyPosesToSafety(controller.ctx, lastPoses);
          // 움직이는 물체가 없으면 물체 쪽 변화가 없으므로 재평가를 건너뛴다
          if (physics.awakeCount > 0) checkExternalContact();
        }
        physicsStepMs = Math.max(physicsStepMs, performance.now() - t0);
      }
    }
    if (physics && lastPoses) viewer.setObjectPoses(lastPoses);
    if (drossField) viewer.setDross(physics.particleState());
    for (const r of coord.robots.values()) viewer.updateExtraRobot(r.slot, r.current.frames);
    if (++tmFrame % 6 === 0) renderTelemetryOverlay(); // 약 10 Hz
    viewer.render();
    frames++;
    if (now - windowStart >= 1000) {
      fpsEl.textContent = `FPS ${Math.round((frames * 1000) / (now - windowStart))}`;
      // 이동 중이면 최근 1초 최대값, 정지 중이면 마지막 측정값
      checkEl.textContent = checkMax > 0 ? `검사 ${checkMax.toFixed(2)} ms` : `검사 ${checkLast.toFixed(2)} ms (정지)`;
      checkEl.classList.toggle('over', checkMax > 2);
      const physEl = $('#status-physics');
      physEl.hidden = !physics;
      if (physics) {
        physEl.textContent = `PHYS ${physicsRunning ? `${physicsStepMs.toFixed(2)} ms/step` : '일시정지'}`;
        physEl.classList.toggle('over', physicsStepMs > 4);
        physicsStepMs = 0;
        renderSimUI();
        checkPlanStaleByObjects();
        if (drossField) {
          drossStats = drossField.stats(drossBins(sideEff));
          renderDrossUI();
        }
        if (tmLog.recording || tmLog.rows.length) renderTelemetryUI();
      }
      frames = 0;
      checkMax = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let noticeTimer;
function showNotice(text, ms = 6000) {
  const el = $('#status-notice');
  el.textContent = text;
  el.title = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.textContent = ''), ms);
}

function showFatal(text) {
  const div = document.createElement('div');
  div.className = 'fatal';
  div.textContent = text;
  document.body.appendChild(div);
}

main();
