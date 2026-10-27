// 앱 진입점: 데이터 로드, 상태 복원, UI 바인딩, 렌더/시뮬레이션 루프
import { initState, getState, setState, subscribe, onSaveStatus, findRobot, defaultCamera, exportState, importState, resetState } from './state.js';
import {
  forwardKinematics, clampJoints, homeJoints, LINK_NAMES, DEG, linkSegments,
  rotationOf, poseMatrix, mul3, expRotation, origin,
} from './kinematics.js';
import { Viewer } from './viewer.js';
import { createSafetyContext, evaluatePose, violationTypes } from './safety.js';
import { compileObstacles, capsuleObstacleDistance } from './collision.js';
import { MotionController } from './motion.js';
import { singularityLabel } from './singularity.js';
import { raiseAlarm, resetAlarm, isAlarmActive, getActiveAlarm, onAlarmChange, mountAlarmBanner, mountAlarmLog } from './alarm.js';
import { mountObstaclePanel } from './obstacles-panel.js';
import { mountCartesianPanel } from './cartesian-panel.js';
import { mountWaypointPanel } from './waypoints-panel.js';
import { jointMove, linearMove, concatTrajectories, pathTrajectory, reverseTrajectory } from './trajectory.js';
import { mountPlanPanel, PLAN_REASON_LABEL } from './plan-panel.js';
import { ICONS, mountThemeToggle, mountSections, mountDrawers, mountShortcuts } from './ui.js';
import { robotThumbnail } from './thumbnail.js';

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
let planSingularity = false; // 계획 결과를 만들 때의 특이점 감지 상태 (바뀌면 stale)
const IDLE = { status: 'idle', activeId: null, t: 0, duration: 0 };
let playback = IDLE; // Waypoint 시퀀스 재생 상태
let planPanel;
let planUI = { status: 'idle' }; // 경로 계획 패널 상태
let plan = null; // { path, trajectory } 현재 계획 결과
let planWorker = null;
let planRequestId = 0;
const PLAN_TIMEOUT_MS = 5000;

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
      $('#safety-chips').replaceChildren(); // 알람 배너가 우선: 근접 경고 칩은 숨긴다
    }
    viewer.setHighlights(alarm ?? {});
    syncJointInputs(getState().joints, true);
  });

  obstaclePanel = mountObstaclePanel($('#obstacle-panel'), {
    getRobot: () => currentRobot,
    onSelect: (id) => {
      viewer.setObstacles(getState().obstacles, id);
      $('#gizmo-tools').hidden = !id;
    },
  });
  viewer.onObstaclePick((id) => obstaclePanel.select(id));
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
  waypointPanel = mountWaypointPanel($('#waypoint-panel'), {
    getRobot: () => currentRobot,
    getJoints: () => controller.current.q,
    onMoveTo: moveToWaypoint,
    onPlay: playSequence,
    onPause: pauseSequence,
    onResume: resumeSequence,
    onStop: () => controller.stop(),
  });

  planPanel = mountPlanPanel($('#plan-panel'), {
    getRobot: () => currentRobot,
    getTcp: () => {
      const { tcp } = forwardKinematics(currentRobot, controller.current.q);
      return [...tcp.pos, ...tcp.rpy];
    },
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
  mountShortcuts({ onPlayPause: togglePlayPause, onStop: stopAll, onReset: () => isAlarmActive() && resetAlarm() });

  subscribe(onStateChange);
  viewer.setObstacles(getState().obstacles);
  restoring = true; // 저장된 상태 복원: 위반이어도 새 알람 로그를 남기지 않는다
  applyRobot(getState());
  restoring = false;
  viewer.setCamera(getState().camera);
  renderMakerSelection();
  renderModelCards();
  renderFeatureToggles();
  renderThresholdFields();

  startLoop();

  // 테스트/디버깅용 핸들 (URL에 ?debug가 있을 때만)
  if (new URLSearchParams(location.search).has('debug')) window.__robosim = { viewer, controller, getState, setState };
}

function onStateChange(state, keys) {
  const has = (k) => keys.includes(k);
  if (has('selectedRobotId')) applyRobot(state);
  else if (has('joints')) updatePose(state.joints);

  if (has('selectedMaker') || has('selectedRobotId')) {
    renderMakerSelection();
    renderModelCards();
  }
  if (has('features')) renderFeatureToggles();
  if (has('thresholds')) renderThresholdFields();
  if (has('obstacles') || has('settings')) obstaclePanel.render();
  if (has('obstacles')) {
    viewer.setObstacles(state.obstacles);
    if (!has('selectedRobotId')) warnBaseOverlap(state.obstacles);
  }
  if (has('alarmLog')) renderAlarmLog();
  if (has('waypoints') && !has('selectedRobotId')) {
    waypointPanel.renderList();
    planPanel.renderInputs();
    renderWaypointMarkers();
  }
  if (has('features')) onPlanFeatureChange(state.features.autoPathPlanning);
  if (has('settings')) {
    cartesianPanel.render();
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
    obstacles: s.obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    floor: s.settings.floorEnabled,
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
    obstacles: s.obstacles,
    floor: s.settings.floorEnabled,
  });
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
      messages.push(`${LINK_NAMES[a]} ↔ ${LINK_NAMES[b]}`);
    }
  }
  if (types.includes('OBSTACLE') && obstacle) {
    const names = new Map(getState().obstacles.map((o) => [o.id, o.name]));
    names.set('floor', '바닥');
    const seen = new Set();
    for (const { link, obstacleId } of obstacle.hits) {
      const key = `${link}-${obstacleId}`;
      if (seen.has(key) || !keys.has(`O:${link}:${obstacleId}`)) continue;
      seen.add(key);
      links.add(link);
      obstacles.add(obstacleId);
      messages.push(`${LINK_NAMES[link]} ↔ ${names.get(obstacleId) ?? obstacleId}`);
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
      // 알람은 Reset으로만 해제한다 (PRD FR-11) → 알람 중에는 로봇 변경도 거부
      if (isAlarmActive()) return showNotice('알람 상태에서는 로봇을 변경할 수 없습니다. Reset 후 변경하세요.');
      // 로봇 변경: 관절은 홈 자세, 이전 경로 결과 초기화, 장애물/설정은 유지 (PRD FR-3)
      setState({
        selectedRobotId: robot.id,
        selectedMaker: robot.maker,
        joints: homeJoints(robot),
        lastPlan: null,
        camera: defaultCamera(robot),
      });
      drawers?.close(); // 좁은 화면: 모델을 고르면 드로어를 닫고 3D 뷰를 보여 준다
    });
    list.appendChild(card);
  }
}

function applyRobot(state) {
  currentRobot = findRobot(state.selectedRobotId);
  controller.stop();
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
  rebuildSafety();
  waypointPanel?.renderList();
  renderWaypointMarkers();
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
  const T = forwardKinematics(currentRobot, baseQ).frames[6];
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
  const res = linearMove(currentRobot, controller.current.q, target);
  if (!res.ok) return showNotice(`직교 조그 불가: ${res.message}`);
  controller.play(res.trajectory, { kind: 'cartesian' });
}

/** Waypoint로 이동 (관절 보간) */
function moveToWaypoint(wp) {
  const tr = jointMove(currentRobot, controller.current.q, wp.joints);
  if (!controller.play(tr, { kind: 'waypoint', rate: speedRate })) rejectWhileAlarm();
}

/** 현재 로봇의 Waypoint를 순서대로 재생 (현재 자세 → P1 → P2 → …) */
function playSequence() {
  const wps = getState().waypoints.filter((w) => w.robotId === currentRobot.id);
  if (!wps.length) return showNotice('저장된 Waypoint가 없습니다.');
  if (isAlarmActive()) return rejectWhileAlarm();
  const linear = getState().settings.playMode === 'linear';
  const segments = [];
  let q = controller.current.q;
  for (const wp of wps) {
    if (linear) {
      const res = linearMove(currentRobot, q, forwardKinematics(currentRobot, wp.joints).frames[6], { qEnd: wp.joints });
      if (!res.ok) return showNotice(`직선 보간 불가 — "${wp.name}" 구간: ${res.message}. 관절 보간을 사용해 보세요.`);
      segments.push(res.trajectory);
    } else {
      segments.push(jointMove(currentRobot, q, wp.joints));
    }
    q = wp.joints;
  }
  const tr = concatTrajectories(segments, wps.map((w) => w.id));
  const activeAt = (t) => (tr.marks.find((m) => m.time >= t - 1e-9) ?? tr.marks[tr.marks.length - 1]).id;
  const started = controller.play(tr, {
    kind: 'sequence',
    rate: speedRate,
    onProgress: (t, duration) => {
      const activeId = activeAt(t);
      if (activeId !== playback.activeId || Math.abs(t - playback.t) > 0.1) {
        setPlayback({ ...playback, activeId, t, duration });
      }
    },
    onEnd: (reason) => {
      setPlayback(IDLE);
      if (reason === 'done') showNotice('Waypoint 재생 완료');
      if (reason === 'blocked') showNotice('재생 중 위반이 감지되어 정지했습니다.');
    },
  });
  if (started) setPlayback({ status: 'playing', activeId: tr.marks[0]?.id ?? null, t: 0, duration: tr.duration });
  else rejectWhileAlarm();
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
function runPlanner({ start, goal }, onProgress) {
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
      obstacles: s.obstacles,
      thresholds: s.thresholds,
      floor: s.settings.floorEnabled,
      avoidSingularity: s.settings.planAvoidSingularity,
      reference: controller.current.q.slice(), // TCP 지정 시 현재 자세에 가까운 IK 해 우선
      start,
      goal,
      timeoutMs: PLAN_TIMEOUT_MS,
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

async function requestPlan({ start, goal }) {
  if (!getState().features.autoPathPlanning) return;
  const a = toPlanSpec(start, 'A(시작)'), b = toPlanSpec(goal, 'B(목표)');
  if (a.error || b.error) return setPlanUI({ error: a.error ?? b.error });
  if (controller.kind?.startsWith('plan')) controller.stop();
  clearPlan();
  setPlanUI({ status: 'planning', progress: 0, nodes: 0, error: null, stale: false });
  const res = await runPlanner({ start: a.spec, goal: b.spec }, (p) => setPlanUI({ progress: p.ratio, nodes: p.nodes }));
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
  const tcpOf = (q) => forwardKinematics(currentRobot, q).tcp.pos;
  const vertices = path.map((q, i) => ({ label: i === 0 ? 'A' : i === path.length - 1 ? 'B' : String(i), tcp: tcpOf(q) }));
  viewer.setPlanPreview(trajectory.points.map(tcpOf), vertices);
  setPlanUI({ status: 'ready', stats, vertices, duration: trajectory.duration, error: null, stale: false });
  if (persist) setState({ lastPlan: { robotId: currentRobot.id, path, blends, stats, createdAt: new Date().toISOString() } });
}

function clearPlan() {
  plan = null;
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
  if (bestDist < 2) {
    tr = reverseTrajectory(currentRobot, plan.trajectory, best, q); // 경로 위 → 되밟기
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
  if (planUI.status === 'paused' && controller.kind?.startsWith('plan')) {
    controller.resume();
    return setPlanUI({ status: 'running' });
  }
  if (!atPlanStart()) {
    showNotice('A(시작)로 먼저 이동한 뒤 경로를 실행합니다.');
    if (!(await moveToPlanStart())) return;
  }
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
  const added = plan.path.map((q, i) => ({
    id: `wp-${stamp}-${i}`,
    name: `경로${n}-${i === 0 ? 'A' : i === last ? 'B' : i}`,
    robotId: currentRobot.id,
    joints: q.map((v) => Math.round(v * 1000) / 1000),
  }));
  setState((s) => ({ waypoints: [...s.waypoints, ...added] }));
  showNotice(`경유점 ${added.length}개(A, 중간 ${added.length - 2}개, B)를 Waypoint 목록에 추가했습니다.`);
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
  setPlayback({ ...playback, status: 'paused' });
}

function resumeSequence() {
  if (isAlarmActive()) return rejectWhileAlarm();
  controller.resume();
  setPlayback({ ...playback, status: 'playing' });
}

function pausePlan() {
  controller.pause();
  setPlanUI({ status: 'paused' });
}

const atPlanStart = () =>
  !!plan && Math.max(...controller.current.q.map((v, i) => Math.abs(v - plan.path[0][i]))) <= 0.05;

/** Space: 진행 중인 재생을 일시정지/계속. 정지 상태면 계획 경로 시작 자세에서는 경로 실행, 아니면 Waypoint 재생. */
function togglePlayPause() {
  if (isAlarmActive()) return rejectWhileAlarm();
  if (playback.status === 'playing') return pauseSequence();
  if (playback.status === 'paused') return resumeSequence();
  if (planUI.status === 'running') return pausePlan();
  if (planUI.status === 'paused') return runPlan();
  if (planUI.status === 'planning' || planUI.status === 'approach') return;
  if (controller.active) return; // 조그 이동 중
  if (planUI.status === 'ready' && getState().features.autoPathPlanning && atPlanStart()) return runPlan();
  playSequence();
}

/** Esc: 모든 모션 정지, 진행 중인 경로 계획 취소, 열린 드로어/알람 로그 닫기 */
function stopAll() {
  controller.stop();
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
    .map((w) => ({ id: w.id, pos: forwardKinematics(currentRobot, w.joints).tcp.pos, active: w.id === playback.activeId }));
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
  viewer.update(fk.frames);
  syncJointInputs(joints, false);
  const [x, y, z] = fk.tcp.pos;
  const [rx, ry, rz] = fk.tcp.rpy;
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
    // 고정 60Hz 시뮬레이션 스텝: 렌더 프레임이 느려도 실제 시간과 같은 속도로 움직인다
    acc += Math.min((now - lastTime) / 1000, 0.25); // 탭 비활성 후 큰 점프 방지
    lastTime = now;
    while (acc >= SIM_DT) {
      acc -= SIM_DT;
      const ms = controller.tick(SIM_DT);
      if (ms > 0) {
        checkLast = ms;
        checkMax = Math.max(checkMax, ms);
      }
    }
    viewer.render();
    frames++;
    if (now - windowStart >= 1000) {
      fpsEl.textContent = `FPS ${Math.round((frames * 1000) / (now - windowStart))}`;
      // 이동 중이면 최근 1초 최대값, 정지 중이면 마지막 측정값
      checkEl.textContent = checkMax > 0 ? `검사 ${checkMax.toFixed(2)} ms` : `검사 ${checkLast.toFixed(2)} ms (정지)`;
      checkEl.classList.toggle('over', checkMax > 2);
      frames = 0;
      checkMax = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let noticeTimer;
function showNotice(text) {
  const el = $('#status-notice');
  el.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.textContent = ''), 6000);
}

function showFatal(text) {
  const div = document.createElement('div');
  div.className = 'fatal';
  div.textContent = text;
  document.body.appendChild(div);
}

main();
