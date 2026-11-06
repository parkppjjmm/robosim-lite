# CLAUDE.md — RoboSim Lite

> **새 세션이면 먼저 [HANDOFF.md](HANDOFF.md)를 읽는다.** 어디까지 진행했는지(현재 상태)와 앞으로 할 일(v2.0.0 이상·고장 데이터·조건부 threshold — `v2.0.0/PROMPTS.md` 1단계부터, v1.1.1 남은 경미 이슈 n-1~n-9, AI 경로 최적화)이 거기 있다. 작업을 마칠 때마다 HANDOFF.md를 갱신한다.

브라우저 기반 경량 산업용 로봇 시뮬레이터 (Vanilla JS ES Modules + Three.js 0.160.0 CDN, 빌드 없음). 사용자는 한국어로 소통하며, UI 문구와 코드 주석도 한국어(전문 용어 영문 병기)로 작성한다.

## 저장소 구조와 버전 규칙 (반드시 지킬 것)

```
robosim-lite/
├─ README.md, CLAUDE.md, .gitattributes, .gitignore   # 저장소 공통
├─ v1.0.0/   # v1.0.0 고정본 — 태그 v1.0.0과 동일, 포트 8000
├─ v1.1.0/   # v1.1.0 고정본 — 태그 v1.1.0, 물리엔진·그리퍼, 수정 금지, 포트 8011
├─ v1.1.1/   # v1.1.1 고정본 — 태그 v1.1.1, 드로스 셀·UR·측면 로봇, 수정 금지, 포트 8111
├─ v1.1.2/   # v1.1.2 고정본 — 태그 v1.1.2, 관절 실시간 계측·데이터 엑셀 추출·머신러닝 계획, 수정 금지, 포트 8112
├─ v2.0.0/   # v2.0.0 개발 폴더 — 뼈대 v1.1.2, 이상·고장 데이터 생성·조건부 threshold 학습, 포트 8200 (tools/ = Node 생성기, analysis/ = Python)
└─ v3.0.0/   # v3.0.0 개발 폴더 — 뼈대 v1.1.2, J1~J6 관절 학습 드로스 제거 AI(계층형 B), 포트 8300, 진행표 PROMPTS.md
```

- **v1.0.0은 영구 백업이다.** `v1.0.0/` 폴더, 태그 `v1.0.0`, 브랜치 `backup/v1.0.0`(커밋 c8f3fdb)은 절대 수정·삭제·이동·강제 push하지 않는다.
- **최신 릴리스는 `v1.1.2/`**(태그 `v1.1.2`, 2026-11-05, 관절 계측·데이터 추출, 요구사항 `v1.1.2/PRD_v.1.1.2.md`, 진행표 `v1.1.2/PROMPTS.md`, 작업 기록 `v1.1.2/WORKLOG.md`)다. **현재 개발 폴더는 `v2.0.0/`**(요구사항 `v2.0.0/PRD_v.2.0.0.md`, 진행표 `v2.0.0/PROMPTS.md`)와 **`v3.0.0/`**(J1~J6 관절 학습 드로스 제거 AI, `v3.0.0/PRD_v.3.0.0.md`, 진행표 `v3.0.0/PROMPTS.md`)이다. 둘 다 v1.1.2 뼈대로 독립 개발하며, 사용자가 v3.0.0 PRD를 먼저 정하기로 했다(2026-11-05). 드로스 셀 요구사항은 `v1.1.1/PRD_v.1.1.1.md`이고, 없는 부분은 `v1.1.0/PRD_v.1.1.0.md` → `v1.0.0/PRD.md` 순으로 따른다. 단계별 작업·진행표는 `v1.1.1/PROMPTS.md`.
- **릴리스한 폴더(`v1.0.0/`·`v1.1.0/`·`v1.1.1/`·`v1.1.2/`)와 태그는 수정하지 않는다.** 새 버전은 이전 폴더를 복사해 새 폴더에서 시작한다.
- 버전 계획: v1.1.0 = 물리엔진(Rapier) + 그리퍼·Pick & Place, v1.1.1 = v1.1.0 경미 이슈 9건 + 드로스 제거 셀(2026-11-05 결정, 컨베이어 등은 이후로), v1.1.2 = 관절 계측·데이터 추출(2026-11-05 릴리스), v2.0.0 = 이상·고장 데이터 생성 + 상황 조건부 이상 경계 학습(머신러닝·AI 활용은 v2 단계, 2026-11-05 사용자 결정). 원래 v1.2.0이던 AI 경로 최적화는 **v3.0.0**에서 한다(2026-11-05 사용자 결정: AI가 드로스 분포에 따라 J6 yaw·툴 방향과 경로를 정해 벽 띠·모서리까지 회수).
- 변경 내용은 작업 중인 버전 폴더의 `CHANGELOG.md` `[Unreleased]`에 기록한다. 릴리스 시 같은 이름의 태그를 붙인다. 릴리스한 태그는 이후에도 수정하지 않는다.
- 저장소는 public(2026-11-05 사용자가 private → public으로 변경): https://github.com/parkppjjmm/robosim-lite (계정 parkppjjmm). 공개 저장소이므로 토큰·개인 자료(예: `Document (현대제철 결과보고서)/`)를 커밋하지 않는다. 커밋 작성자는 `parkppjjmm <parkppjjmm@gmail.com>`이며, 저장소 로컬 git config로 설정한다(전역 설정 변경 금지).
- 커밋·push·태그·GitHub 설정 변경은 사용자가 요청할 때만 한다.

## 실행 / 검증 (v2.0.0 기준, `v2.0.0/` 폴더에서 — 이전 버전도 같은 방법, 포트만 다름)
- 실행: `start.bat`(Windows) 또는 `python serve.py [port] [--no-browser]` (기본 8200). **Claude가 테스트용 서버를 띄웠다면 끝나고 반드시 끈다** — 같은 포트가 열려 있으면 사용자의 start.bat이 "포트 사용 중"으로 닫힌다(2026-11-05 사례). file:// 직접 실행은 지원하지 않는다(ES 모듈·Worker).
- 버전마다 포트가 달라 localStorage(`robosim-lite:v1`)가 분리된다(v1.0.0 8000 / v1.1.0 8011 / v1.1.1 8111 / v1.1.2 8112 / v2.0.0 8200 / v3.0.0 8300). 같은 포트로 여러 버전을 번갈아 열지 않는다(저장 형식 충돌).
- 디버그 핸들: URL에 `?debug` → `window.__robosim` (viewer, controller, getState, setState, physics, dross, skim).
- Node 검증: `node tests/run-all.mjs` (빠른 10종: 도달거리·안전·IK·계획·물리·그리퍼·Pick & Place·경미 이슈·드로스 셀·계측(v1.1.2)), `--full` (스트레스·수치·측면 로봇 동시 실행 `cell-robots.mjs` 포함). `cell-robots.mjs`는 `ONLY=A|B|C`, `SIM_S`, `PROFILE=1`, `DBG=1` 환경 변수로 일부만·짧게 돌릴 수 있다. 기능을 바꾸면 반드시 다시 실행한다. 다른 폴더 검증은 스크립트에 경로 인자(예: `node tests/planner.mjs ../v1.0.0`).
- 브라우저 확인: v1.0.0 AC-1~AC-10(`v1.0.0/PRD.md` 7장), v1.1.0 AC-11~20(`v1.1.0/PRD_v.1.1.0.md` 7장), v1.1.1 AC-21~29(`PRD_v.1.1.1.md` 7장). 자동화할 때는 캐시를 피하려고 요청에 no-cache 헤더를 붙인다. Playwright가 없으면 헤드리스 Chrome + CDP 스크립트(`--use-angle=swiftshader`)로 할 수 있다(소프트웨어 렌더링이라 FPS는 참고값).

## 구조 핵심 (`v2.0.0/js/`, v1.1.1부터 같은 구조)
- `kinematics.js`(FK/IK/Jacobian), `collision.js`(캡슐 거리), `singularity.js`, `safety.js`(적용 전 세분 검사, 대상별 복구 규칙), `motion.js`(모든 모션의 안전 게이트) — DOM 비의존이며 Node 테스트와 Worker에서 재사용한다.
- 경로 계획: `planner.js`(A·B IK → RRT-Connect → Shortcut) → `optimizer.js`(CHOMP 스타일) → `trajectory.js`(블렌딩, 시간 파라미터화). `planner.worker.js`에서 실행하고, UI는 `plan-panel.js`, 흐름은 `main.js`의 "자동 경로 계획" 절에 있다.
- 상태와 저장은 `state.js`(localStorage `robosim-lite:v1`, sanitize/migrate)가 맡는다. 저장 스키마를 바꾸면 sanitize·migrate와 PRD 스키마 절을 함께 고친다.
- 물리: `physics.js`(Rapier 래퍼: 물체·로봇 운동학 바디·고정 설비·입자·액체 부력·구름 저항, DOM 비의존), 툴: `gripper.js`(평행 그리퍼 + 드로스 스키머), Pick & Place: `task.js`.
- 드로스 제거 셀(설계·수치·재구현 프롬프트는 `v1.1.1/DROSS_PATH.md`, 그림 문서는 `v1.1.1/docs/*.docx`): `dross.js`(셀 배치 상수, 설비, DrossField 입자 관리, 레인, `planSkimCycle`·`planPushStroke`) + `cell-robot.js`(측면 로봇·조정기, 로컬 좌표 계획) + `dross-panel.js`, 흐름은 `main.js`의 "드로스 제거 셀" 절. 설비는 `envObstacles()`로 안전 검사·경로 계획에 들어가고, 드로스 입자는 장애물이 아니다(작업 대상).
- v3.0.0 모듈: `task-eval.js`(작업 설정·회수율 평가), `cell-sim.js`(헤드리스 셀 `runEpisode`, `mainChooser`로 외부가 스트로크 결정), `replay.js`·`replay-panel.js`(에피소드 기록·3D 재생), `stroke-lab.js`(학습: 스트로크 변수·점수 규칙·후보 평가·진화 탐색·StrokeEnv·정책 실행), `ppo.js`(순수 JS PPO), `lab-panel.js`·`lab.worker.js`·`lab-eval.worker.js`(앱 학습 창). 도구: `tools/baseline.mjs`·`episode.mjs`·`train.mjs`·`ppo-train.mjs`·`ppo-eval.mjs`(공용 `tools/lib/policy-eval.mjs`). 결과 `results/<날짜>/<시각>_<종류>_<이름>/`(`tools/lib/run-dir.mjs`, `results/INDEX.md` 자동, 3D 재생 .rsim.json.gz·log.json까지 모두 git에 올림(2026-11-06, 다른 PC 재현)). 기술 문서 `v3.0.0/docs/<날짜>_<시각>_<제목>/`(docx·images·build, python-docx·matplotlib). **결과·문서는 덮어쓰지 않고, 커밋 메시지 앞에 `[날짜 시각 KST]`를 붙인다(2026-11-06 사용자 요청).** 측면 모드 3 = 타이밍 밀기(`push`), 대형 쓸기 방향 `task.mainRule.laneDir`. 브라우저 Worker는 importmap을 못 쓰므로 Rapier를 CDN 주소로 직접 불러온다.
- v2.0.0 예정 모듈(PRD FR-42~53): `cell-sim.js`(헤드리스 에피소드), `anomaly.js`(이상 판정, 라벨은 전류가 아닌 결과로), `fault.js`(고장 주입), `scenario.js`(몬테카를로 샘플러), `thresholds.js`(학습 경계 적용), `tools/generate.mjs`(일괄 생성, 출력 `out/`은 git 제외), `analysis/`(Python, `.venv` 로컬).
- 계측(v1.1.2): `telemetry.js`(JointTelemetry 근사 동역학 → 추정 전류, TelemetryLog 기록), `xlsx.js`(자체 엑셀 작성기), `telemetry-panel.js`, 흐름은 `main.js`의 "실시간 계측 · 데이터 기록" 절. 전류·토크는 추정값임을 항상 명시한다.
- 원칙: 로봇 이동(스키밍 포함)은 물리엔진보다 먼저 안전 게이트를 통과해야 한다(적용 전 검사). 시뮬레이션 모드(고정/물리)는 전체 단위로만 선택한다(물체별 선택 금지). 고정 모드·셀 꺼짐은 이전 버전과 동일하게 동작해야 한다.

## 알려진 함정
- **`start.bat`은 ASCII 전용 + CRLF로 유지한다.** UTF-8 한글이나 LF가 들어가면 cmd가 즉시 종료된다. `.gitattributes`가 체크아웃 시 CRLF를 강제한다.
- **브라우저 모듈 캐시:** 예전 JS가 캐시되면 Worker가 버전 불일치로 실패한다("Worker 오류"). `serve.py`의 `Clear-Site-Data`가 이를 막으므로 다른 정적 서버로 테스트할 때 주의한다.
- **거리 지표:** 충돌 검사의 `minDistance`는 여유거리 밖의 먼 장애물에 대해 경계구 하한값을 쓴다. 정확한 거리가 필요하면 `checkObstacleCollision(segs, compiled, 큰값)`을 쓴다.
- Windows 셸에서 한글과 따옴표가 섞인 heredoc은 깨지기 쉽다. 패치 스크립트는 파일로 작성해서 실행한다.
- **부력 입자의 속도:** 스텝 직후 `linvel()`은 부력 충격량과 중력이 번갈아 반영된 값이라 정지해 있어도 약 60 mm/s로 보인다. 정지 여부는 위치 변화로 판단한다.
- **측면 로봇 비동기 계획:** `CellRobot.planNext`는 async다. Node 시뮬레이션 루프에서 양보(`await setImmediate`)하지 않으면 계획이 끝나지 않아 교착처럼 보인다(브라우저는 프레임마다 양보).
- **측면 박스 거리 표(`SIDE_BIN_TABLE`):** 스키밍 사이클 형상(덤프·운반 자세)을 바꾸면 값이 달라질 수 있다 → `tests/cell-robots.mjs`의 표 = 계산 비교가 실패하면 표를 갱신한다.
- 사용자가 만든 버전 폴더 이름이 규칙과 다르면(예: `v.1.1.1`) 규칙 이름(`v1.1.1`)으로 맞춘다(2026-11-05 사례).
