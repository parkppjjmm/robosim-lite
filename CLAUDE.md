# CLAUDE.md — RoboSim Lite

> **새 세션이면 먼저 [HANDOFF.md](HANDOFF.md)를 읽는다.** 어디까지 진행했는지(현재 상태)와 앞으로 할 일(v1.1.0 릴리스, 경미 이슈 9건, v1.2.0 AI 경로 최적화)이 거기 있다. 작업을 마칠 때마다 HANDOFF.md를 갱신한다.

브라우저 기반 경량 산업용 로봇 시뮬레이터 (Vanilla JS ES Modules + Three.js 0.160.0 CDN, 빌드 없음). 사용자는 한국어로 소통하며, UI 문구와 코드 주석도 한국어(전문 용어 영문 병기)로 작성한다.

## 저장소 구조와 버전 규칙 (반드시 지킬 것)

```
robosim-lite/
├─ README.md, CLAUDE.md, .gitattributes, .gitignore   # 저장소 공통
├─ v1.0.0/   # v1.0.0 고정본 — 태그 v1.0.0과 동일, 포트 8000
└─ v1.1.0/   # v1.1.0 개발 폴더 — 앱·tests·문서, 포트 8011
```

- **v1.0.0은 영구 백업이다.** `v1.0.0/` 폴더, 태그 `v1.0.0`, 브랜치 `backup/v1.0.0`(커밋 c8f3fdb)은 절대 수정·삭제·이동·강제 push하지 않는다.
- **현재 개발 대상은 `v1.1.0/` 폴더**다(물리엔진 통합). 요구사항은 `v1.1.0/PRD_v.1.1.0.md`이고, 이 문서에 없는 부분은 `v1.0.0/PRD.md`를 따른다. 단계별 작업은 `v1.1.0/PROMPTS.md` 순서로 진행한다.
- 버전 계획: v1.1.0 = 물리엔진(Rapier) + 그리퍼·Pick & Place, v1.1.1 = 작업 셀(컨베이어, 사이클 타임).
- 변경 내용은 `v1.1.0/CHANGELOG.md`의 `[Unreleased]`에 기록한다. 릴리스 시 태그 `v1.1.0`을 붙인다. 릴리스한 태그는 이후에도 수정하지 않는다.
- 저장소는 private: https://github.com/parkppjjmm/robosim-lite (계정 parkppjjmm). 커밋 작성자는 `parkppjjmm <parkppjjmm@gmail.com>`이며, 저장소 로컬 git config로 설정한다(전역 설정 변경 금지).
- 커밋·push·태그·GitHub 설정 변경은 사용자가 요청할 때만 한다.

## 실행 / 검증 (v1.1.0 기준, `v1.1.0/` 폴더에서)
- 실행: `start.bat`(Windows) 또는 `python serve.py [port] [--no-browser]` (기본 8011). file:// 직접 실행은 지원하지 않는다(ES 모듈·Worker).
- 두 버전은 포트가 달라 localStorage(`robosim-lite:v1`)가 분리된다. 같은 포트로 두 버전을 번갈아 열지 않는다(저장 형식 v1/v2 충돌).
- 디버그 핸들: URL에 `?debug` → `window.__robosim` (viewer, controller, getState, setState).
- Node 검증: `node tests/run-all.mjs` (빠른 7종: 도달거리·안전·IK·계획·물리·그리퍼·Pick & Place), `--full` (스트레스·수치 포함). 기능을 바꾸면 반드시 다시 실행한다. 다른 폴더 검증은 스크립트에 경로 인자(예: `node tests/planner.mjs ../v1.0.0`).
- 브라우저 확인: v1.0.0 수용 기준 AC-1~AC-10(`v1.0.0/PRD.md` 7장)과 v1.1.0 AC-11~(`PRD_v.1.1.0.md` 7장). 자동화할 때는 캐시를 피하려고 요청에 no-cache 헤더를 붙인다.

## 구조 핵심 (`v1.1.0/js/`)
- `kinematics.js`(FK/IK/Jacobian), `collision.js`(캡슐 거리), `singularity.js`, `safety.js`(적용 전 세분 검사, 대상별 복구 규칙), `motion.js`(모든 모션의 안전 게이트) — DOM 비의존이며 Node 테스트와 Worker에서 재사용한다.
- 경로 계획: `planner.js`(A·B IK → RRT-Connect → Shortcut) → `optimizer.js`(CHOMP 스타일) → `trajectory.js`(블렌딩, 시간 파라미터화). `planner.worker.js`에서 실행하고, UI는 `plan-panel.js`, 흐름은 `main.js`의 "자동 경로 계획" 절에 있다.
- 상태와 저장은 `state.js`(localStorage `robosim-lite:v1`, sanitize/migrate)가 맡는다. 저장 스키마를 바꾸면 sanitize·migrate와 PRD 스키마 절을 함께 고친다.
- v1.1.0 원칙: 로봇 이동은 물리엔진보다 먼저 안전 게이트를 통과해야 한다(적용 전 검사). 시뮬레이션 모드(고정/물리)는 전체 단위로만 선택한다(물체별 선택 금지). 고정 모드는 v1.0.0과 동일하게 동작해야 한다.

## 알려진 함정
- **`start.bat`은 ASCII 전용 + CRLF로 유지한다.** UTF-8 한글이나 LF가 들어가면 cmd가 즉시 종료된다. `.gitattributes`가 체크아웃 시 CRLF를 강제한다.
- **브라우저 모듈 캐시:** 예전 JS가 캐시되면 Worker가 버전 불일치로 실패한다("Worker 오류"). `serve.py`의 `Clear-Site-Data`가 이를 막으므로 다른 정적 서버로 테스트할 때 주의한다.
- **거리 지표:** 충돌 검사의 `minDistance`는 여유거리 밖의 먼 장애물에 대해 경계구 하한값을 쓴다. 정확한 거리가 필요하면 `checkObstacleCollision(segs, compiled, 큰값)`을 쓴다.
- Windows 셸에서 한글과 따옴표가 섞인 heredoc은 깨지기 쉽다. 패치 스크립트는 파일로 작성해서 실행한다.
