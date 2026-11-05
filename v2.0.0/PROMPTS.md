# v2.0.0 단계별 작업 · 진행표 (PROMPTS)

> 요구사항은 `PRD_v.2.0.0.md`(FR-42~53, AC-43~55). 뼈대는 `../v1.1.2/`(태그 `v1.1.2`)를 그대로 복사한 이 폴더.
> 각 단계는 아래 프롬프트를 Claude Code(또는 같은 수준의 AI)에 그대로 주면 진행할 수 있게 썼다. 한 단계가 끝날 때마다 진행표·`CHANGELOG.md`·루트 `HANDOFF.md`를 갱신한다.

## 진행표
| 단계 | 내용 | PRD | 결과 |
|---|---|---|---|
| 0 | 폴더 준비: `v1.1.2/` 코드 복사(v1.1.2 전용 문서 제외), 포트 8200, PRD·PROMPTS·README·CHANGELOG, `tools/`·`analysis/` 뼈대 | — | 완료 (2026-11-05) |
| 1 | 헤드리스 실행기 `js/cell-sim.js` 공통화 + 배속 측정 | FR-46, AC-48 | 예정 |
| 2 | 기록 확장: TCP 자세·팔 뻗음·안전 여유·게이트·고정 경보 열 | FR-42, AC-43 | 예정 |
| 3 | 이상 판정기 `js/anomaly.js` + 사후 라벨 | FR-43, AC-44·45 | 예정 |
| 4 | 고장 주입 `js/fault.js`(P1 5종) + 브라우저 패널 | FR-44, AC-46·47 | 예정 |
| 5 | 시나리오 샘플러 `js/scenario.js` + `tools/generate.mjs` + 품질 검사 | FR-45·47·51, AC-49·50 | 예정 |
| 6 | Python 파이프라인 + 첫 실험(200 에피소드) + 보고서 | FR-48, AC-51·53 | 예정 |
| 7 | `thresholds.json` 앱 적용(그래프 밴드·조건부 경보) | FR-49, AC-52 | 예정 |
| 8 | (P2) 백래시·속도 제한·외란 물체 + 적응 샘플링 비교 | FR-44·45·50, AC-54 | 예정 |
| 9 | 자체 검토 `REVIEW_v2.0.0.md`, 회귀(AC-55), 문서, 릴리스(태그는 사용자 확인 후) | — | 예정 |

## 공통 전제 (모든 단계)
- 규칙은 루트 `CLAUDE.md`, 진행 상황은 `HANDOFF.md`. 릴리스한 폴더(`v1.0.0`~`v1.1.2`)와 태그는 수정하지 않는다. 작업은 `v2.0.0/` 안에서만.
- 순수 계산 모듈(`anomaly.js`·`fault.js`·`scenario.js`·`cell-sim.js`)은 DOM에 의존하지 않는다. 브라우저와 Node에서 같이 쓴다.
- 의존성 추가 금지: 브라우저는 Three·Rapier, Node는 표준 라이브러리, Python 패키지는 `analysis/`에만.
- 이동은 항상 안전 게이트를 먼저 통과한다. 고장 주입은 게이트를 끄지 않는다.
- 라벨은 결과(기하·작업·주입 사실)로만 정한다. 전류 크기는 라벨 입력이 아니다(PRD 2.2).
- 전류·토크는 추정값임을 화면·파일·보고서에 명시한다.
- 기능을 바꾸면 `node tests/run-all.mjs`(필요하면 `--full`)를 다시 돌린다. 브라우저 확인은 `python serve.py 8200 --no-browser`로 하고, **끝나면 서버를 끈다.**
- Windows에서 한글이 든 패치는 파일로 작성해 실행한다(heredoc 깨짐).

---

## 1 — 헤드리스 실행기 공통화 (FR-46)
```
v2.0.0/tests/cell-robots.mjs의 simulate() 루프(측면 로봇 → 대형 로봇 안전 게이트(다른 로봇 포함) → 물리, 60 Hz)를
DOM 비의존 모듈 v2.0.0/js/cell-sim.js로 옮겨줘.
- export async function runEpisode(config, { RAPIER, hz = 20, onSample, onEvent, deterministic = true })
  config = { mainId, sides: {left:{robotId,mode}, right:{…}}, dross: {count, ratePerMin, seed, immersionMm, sweepMmS}, simS, perturb: {}, faults: [] }
  반환 { summary: {cycles, collected, spilled, mainBlocked, sideBlocked, minMainSide, holdS, planFail, wallS, speedup}, events }
- 비동기 계획 중에는 await setImmediate로 양보(CLAUDE.md 함정).
- deterministic = true면 시간 제한 후처리(planner Shortcut·optimizer)를 시간 대신 반복 횟수 고정으로 돌려
  PC 속도와 무관하게 같은 결과가 나오게 해줘(planner.js·optimizer.js에 옵션 추가, 기본 동작은 그대로).
- tests/cell-robots.mjs는 이 모듈을 쓰도록 바꾸고, 기존 검사(안전 위반 0, 회수량, 잠금 위반 0)가 그대로 통과해야 해.
- 같은 config를 두 번 돌려 summary가 같은지 확인하는 검사를 추가해줘.
- 대형 + 측면 2대(모드 2) 120 s 기준 실시간 대비 배속(sim s / wall s)을 출력하고 PRD FR-46 목표(≥ 5배)와 비교해 보고해줘.
  목표에 못 미치면 원인(계획·물리·안전 검사 비중)을 PROFILE로 재고 대안을 제안해줘.
main.js(브라우저) 루프는 바꾸지 마.
```

## 2 — 기록 확장 (FR-42)
```
PRD_v.2.0.0.md 5장 열을 계측 기록에 추가해줘(기존 49열 뒤, 스키마 'robosim-data/2').
- telemetry.js: DATA_COLUMNS·COLUMN_DOC에 새 열(설명 한국어), TelemetryLog.push가 새 값을 받게.
  TCP roll·pitch·yaw(physics.js rpyFromMatrix)와 쿼터니언(quatFromMatrix), reach_ratio(손목 중심 거리/maxReach).
- 안전 여유는 새 함수 safetyMargins(ctx, q, others)로 계산(safety.js 또는 새 파일):
  d_obs_mm는 checkObstacleCollision(segs, compiled, 큰값)으로 정확 거리(경계구 하한 금지), d_self_mm, d_robot_mm,
  jlim_margin_deg·jlim_joint, singularity 지표(checkSingularity metrics)와 manipulability.
  샘플 주기(20 Hz)에만 계산.
- gate_block·gate_violation: MotionController/CellRobot에서 이번 샘플 사이 차단을 모아 둠. hold_s: 간섭 대기 누적.
- fixed_alarm: 정격 대비 90% 초과 축 수(비교 기준, 라벨 아님).
- 브라우저 엑셀 meta 시트에 schema = robosim-data/2.
- tests/anomaly.mjs(새로)에 AC-43: 정확 거리 = checkObstacleCollision(…, 1e6) 결과, 열 개수·순서, 자세 열이 FK와 일치.
```

## 3 — 이상 판정기 (FR-43)
```
v2.0.0/js/anomaly.js를 만들어줘(DOM 비의존).
- ANOMALY_RULES 상수: PRD 2.1 표의 기준값(근접 = 여유거리 + 30 mm, 관절 한계 5°/1°, 특이점 1.5배/1배, 대기 10 s/20 s, 흘림).
- class AnomalyMonitor { update(sample, cellEvents, faultState) → { anomaly(0/1/2), codes[], severity } }
  입력에 전류·토크를 쓰지 마(PRD 2.2 순환 논리 방지).
- 사후 라벨 function postLabel(rows, hz) → t_to_anomaly_s, pre_anomaly_1s/3s/5s.
  브라우저 기록은 '기록 정지' 때, 헤드리스는 에피소드 끝에 계산.
- main.js 기록과 cell-sim.js에 연결하고 anomaly·anomaly_codes·anomaly_severity·spill_event 열을 채워줘.
- 오버레이 상태 줄에 현재 이상 코드(근접 = 노랑, 이상 = 빨강)를 작게 표시(계측 표가 켜져 있을 때만).
- tests/anomaly.mjs에 AC-44·45: 일부러 만든 근접·한계·특이점·차단·대기·흘림 상황마다 코드 확인,
  정상 사이클 anomaly = 0이 95% 이상, 전류를 0으로 바꿔도 라벨 동일.
```

## 4 — 고장 주입 (FR-44, P1 5종)
```
v2.0.0/js/fault.js를 만들어줘(DOM 비의존).
- FAULT_TYPES: friction, payload, sensor_noise, sensor_drift, sensor_bias (PRD 4장 표의 파라미터·범위).
  시간 형태 step / ramp / intermittent, level(t) 0~1.
- class FaultInjector { constructor(faults, seed); at(t) → 현재 상태; applyTelemetry(jt, out, t) }
  friction: JointTelemetry 마찰 항 배수, payload: 계측 부하 추가(물리 모드면 툴 끝 질량도),
  sensor_*: 전류 출력에 잡음 배수·누적 드리프트·오프셋.
  JointTelemetry에는 훅(예: update(q, frames, dt, load, mods))만 최소로 추가하고 기본 동작은 그대로.
- 기록 열 fault_active·fault_type·fault_joint·fault_level·fault_id, 이벤트 '고장 시작/끝'.
- 브라우저: '실시간 계측 · 데이터' 아래에 '고장 주입' 섹션(종류·대상 로봇·축·강도·형태·[주입]/[해제]),
  상태바 '고장 주입 중' 배지, 세션 단위(저장 안 함, 새로고침하면 해제).
- tests/fault.mjs(새로)에 AC-46: friction ×2 → 마찰 토크 2배, payload +m → J2 정적 토크 증가 = m·g·레버(±5%),
  bias·drift·noise 설정값 확인, 해제 후 원래 값. run-all 빠른 목록에 추가.
- 브라우저 확인(AC-47): 주입 → 배지·그래프 변화, 해제 → 원래대로, 새로고침 → 해제. 끝나면 서버 끄기.
```

## 5 — 샘플러 · 일괄 생성기 · 품질 검사 (FR-45·47·51)
```
1) v2.0.0/js/scenario.js: tools/scenario-space.json(변수·범위·분포, PRD 4장 FR-45 표)을 읽어
   sample(space, {method: 'mc'|'lhs', n, masterSeed}) → 에피소드 config 배열.
   같은 시드 → 같은 결과, 불가능 조합 제외(rejected 수 반환), lhs는 변수마다 n개 구간을 하나씩 채움.
   자세 섭동(레인 목표·덤프 위치·툴 기울기)은 cell-sim이 받아 계획 입력에 반영.
2) v2.0.0/tools/generate.mjs: --space --n --seed --method --hz --workers --out --resume --dry --from(proposals.json)
   출력 manifest.json(앱 버전, git 커밋, 스키마, 공간, ANOMALY_RULES, 시각), episodes.csv, samples/ep-NNNNN.csv.gz(node:zlib),
   events.csv, errors.csv. workers는 child_process로 병렬, 진행률·남은 시간 표시. 외부 npm 패키지 금지.
3) tools/check-dataset.mjs: 샘플 간격·열 수·결측·중복·라벨 분포·고장 시각 정렬 보고.
4) tests/generate.mjs(작은 N=3, simS=30): AC-49·50 — 같은 시드 두 번 → 데이터 동일(wall_time 제외), --resume, 실패 에피소드 처리.
5) 실제로 --n 20을 돌려 배속·용량·라벨 비율을 재고, 200 에피소드 예상 시간을 보고해줘.
out/은 git에 넣지 않아(.gitignore 확인).
```

## 6 — Python 파이프라인 + 첫 실험 (FR-48)
```
v2.0.0/analysis/에 PRD FR-48 표의 스크립트를 만들어줘. 가상환경은 analysis/.venv(전역 설치 금지),
requirements.txt 고정 버전. 순서:
to_parquet.py → features.py → split.py(에피소드 단위, 대형 로봇 1종 시험 전용) → baseline_fixed.py →
band_model.py(정상 샘플로 축별 전류 분위수 회귀 0.005/0.995, LightGBM quantile, 검증 세트 conformal 보정) →
risk_model.py(pre_anomaly_3s 분류 + 깊이 3~4 결정 트리 규칙 + SHAP) → risk_map.py → evaluate.py(PRD 7.3 지표) →
export_thresholds.py(PRD FR-49 형식 v1) → report.py(report.md: 설정·결과 표·그림·한계, '추정 전류' 명시).
먼저 10 에피소드로 끝까지 오류 없이 도는지(AC-51) 확인하고, 그다음 200 에피소드로 첫 실험을 돌려
고정 vs 조건부 비교표와 가이드라인 규칙 3개 이상을 보고해줘(AC-53). 사후 라벨은 특징에 넣지 마(누수).
```

## 7 — 학습 결과 앱 적용 (FR-49)
```
계측 패널에 [경계 불러오기](파일 선택)를 추가해 thresholds.json(robosim-thresholds/1)을 읽어줘.
- 형식 검사 함수는 DOM 비의존(js/thresholds.js)으로 만들고 Node 테스트(AC-52 형식 부분).
- 현재 로봇의 상황(단계·reach_ratio·부하·속도)으로 구간을 찾아 축별 lo/hi를 구하고(없으면 fallback),
  그래프 전류 칸에 반투명 밴드, 벗어나면 오버레이 칸 보라색 + '조건부 경계 이탈 Jn' 경보(정지하지 않음).
- 고정 threshold 경보 수와 조건부 경보 수를 패널에 같이 표시.
- 세션 단위(저장 안 함). 브라우저 확인 후 서버 끄기.
```

## 8 — (P2) 고장 확장 · 외란 · 적응 샘플링 (FR-44·45·50)
```
- fault.js에 backlash(방향 전환 데드밴드 + 토크 튐), velocity_limit(궤적 시간 재조정) 추가 + 테스트.
- scenario에 외란 물체 0~2개(셀 경계 안, 설비와 겹치지 않게) 추가 — envObstacles로 안전 검사·계획에 들어가게.
- analysis/propose.py: 1차 모델로 후보 5,000개의 위험 확률을 예측해 p≈0.5(경계 근처)이면서 서로 먼 N개를 proposals.json으로.
  tools/generate.mjs --from proposals.json으로 생성.
- 같은 총 에피소드 수에서 mc vs adaptive 샘플 효율 곡선을 report에 추가(AC-54).
```

## 9 — 검토 · 릴리스
```
REVIEW_v2.0.0.md(치명·주요·경미 분류, AC-43~55 결과, 측정값, 한계)를 쓰고
node tests/run-all.mjs --full(AC-55 회귀 포함)과 브라우저 시나리오를 돌려줘.
CHANGELOG [Unreleased] → [2.0.0], README·HANDOFF·CLAUDE.md 갱신.
커밋·push·태그 v2.0.0은 내가 요청할 때만.
```
