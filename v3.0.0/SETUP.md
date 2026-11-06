# 새 노트북(다른 PC)에서 RoboSim Lite 설정하기

GitHub의 공개(public) 저장소 `parkppjjmm/robosim-lite`를 받아, 지금과 똑같이 실행하고 Claude Code로 이어서 작업하는 방법입니다.

## 1. 준비물

| 프로그램 | 용도 | 확인 명령 |
|---|---|---|
| Git for Windows (Git Credential Manager 포함) | 저장소 받기/올리기 | `git --version` |
| Python 3.8 이상 | 로컬 서버(`serve.py`) 실행 | `python --version` |
| Chrome 또는 Edge 최신 버전 | 앱 실행 | — |
| Node.js 18 이상 (선택) | `tests/` 검증 스크립트 실행 | `node --version` |
| Claude Code (선택) | 이어서 개발 | `claude --version` |

- Python을 설치할 때 **"Add python.exe to PATH"** 를 반드시 체크하세요.
- `python --version`을 쳤는데 Microsoft Store가 열리면, Python이 설치되지 않은 상태입니다(Windows 기본 바로가기만 있는 경우). python.org에서 설치하거나, **설정 → 앱 → 고급 앱 설정 → 앱 실행 별칭**에서 `python.exe` / `python3.exe` 별칭을 끄세요.
- 인터넷 연결이 필요합니다. 3D 라이브러리 Three.js를 CDN에서 불러옵니다.

## 2. 저장소 받기

저장소는 **공개(public)** 입니다(2026-11-05 변경). 받기만 할 때는 로그인이 필요 없습니다.

```bash
git clone https://github.com/parkppjjmm/robosim-lite.git
```

수정 내용을 **올릴(push) 때는 parkppjjmm 계정 로그인**이 필요합니다. 그 PC에 다른 GitHub 계정이 저장돼 있으면, 주소에 계정명을 넣어 받아 두면 push할 때 parkppjjmm로 로그인 창이 뜹니다.

```bash
git clone https://parkppjjmm@github.com/parkppjjmm/robosim-lite.git
```

받은 저장소는 버전별 폴더로 나뉘어 있습니다.

| 폴더 | 내용 | 기본 주소 |
|---|---|---|
| `robosim-lite/v1.0.0/` | v1.0.0 고정본 (수정 금지) | http://localhost:8000 |
| `robosim-lite/v1.1.0/` | v1.1.0 (물리엔진·그리퍼, 릴리스 대기, 수정하지 않음) | http://localhost:8011 |
| `robosim-lite/v1.1.1/` | v1.1.1 릴리스 (드로스 제거 셀·UR·측면 로봇) | http://localhost:8111 |
| `robosim-lite/v1.1.2/` | v1.1.2 릴리스 (관절 실시간 계측·데이터 엑셀 추출) | http://localhost:8112 |
| `robosim-lite/v2.0.0/` | v2.0.0 개발 폴더 (이상·고장 데이터, 조건부 threshold) | http://localhost:8200 |
| `robosim-lite/v3.0.0/` | v3.0.0 개발 폴더 (AI 스키밍 경로 최적화) | http://localhost:8300 |

- v1.0.0 시점의 저장소 전체가 필요하면 `git clone --branch backup/v1.0.0 …`으로 받을 수 있습니다. 태그 `v1.0.0`과 같습니다.

- 처음 push할 때 브라우저에 GitHub 승인 페이지가 열립니다. **parkppjjmm로 로그인 → Authorize** 하면 이후로는 자동 인증됩니다.
- 로그인 창이 안 뜨면 아래 명령으로 직접 띄울 수 있습니다.
  ```bash
  git credential-manager github login --username parkppjjmm --browser
  ```
- push할 때 403(Permission denied)이 나면 다른 계정으로 인증된 것입니다. 주소에 `parkppjjmm@`가 들어 있는지 확인하세요.

## 3. 실행

| 환경 | 방법 |
|---|---|
| Windows | 실행할 버전 폴더(`v1.0.0/`, `v1.1.0/`, `v1.1.1/`, `v1.1.2/`, `v2.0.0/`, `v3.0.0/`)의 `start.bat` 더블클릭 → 브라우저가 자동으로 열림 (검은 창은 서버이므로 사용하는 동안 열어 둠) |
| macOS / Linux | 버전 폴더에서 `python3 serve.py` → v1.0.0은 http://localhost:8000, v1.1.0은 http://localhost:8011, v1.1.1은 http://localhost:8111, v1.1.2는 http://localhost:8112, v2.0.0은 8200, v3.0.0은 8300 |

- `index.html`을 직접 열면(file://) 실행 방법 안내만 나옵니다. 반드시 위 방법으로 실행하세요.
- 저장 데이터(로봇, 장애물, Waypoint 등)는 **브라우저마다, 그리고 버전(포트)마다 따로** 저장됩니다. 이전 버전 장면을 새 버전에서 쓰려면 이전 버전에서 내보내고 새 버전에서 가져오세요(v1.0.0 → v1.1.x는 고정 모드로 열림). 이전 PC의 작업 상태를 옮기려면, 이전 PC에서 **데이터 관리 → 내보내기(JSON)** 를 하고 새 PC에서 **가져오기**를 하세요.

## 4. 정상 동작 확인

1. **자동 검증 (Node 필요):** `v3.0.0/` 폴더에서 아래 명령을 실행해 `모두 정상 실행`이 나오면 됩니다(약 2~3분, 13종).
   ```bash
   node tests/run-all.mjs
   ```
   `--full`을 붙이면 스트레스·수치 검증까지 포함합니다(수 분). v1.0.0 폴더를 검증하려면 개별 스크립트에 경로를 주면 됩니다. 예: `node tests/planner.mjs ../v1.0.0`
2. **화면 확인:** README의 "시연 팁 → 벽 우회 예"를 따라 해서 A→B 경로가 생성·실행되는지 봅니다. v1.1.1은 "드로스 제거 셀" 사용법대로 대형 로봇에서 ▶ 1사이클을 실행해 드로스가 박스로 옮겨지는지 봅니다.

## 4-1. v3.0.0 AI 학습 환경 (다른 PC에서 그대로 이어 하기)

저장소를 받으면 지금까지의 **모든 실행 결과**가 함께 들어옵니다. 3D 재생 파일, 진화 탐색 시도 기록, PPO 정책, 보고서가 모두 포함됩니다(2026-11-06부터).

| 필요 | 버전 | 용도 |
|---|---|---|
| Node.js | 18 이상 (개발 PC는 26.13) | 테스트, 헤드리스 시뮬레이션, 진화 탐색·PPO 학습 (`v3.0.0/tools/`) |
| Python | 3.8 이상 | 앱 서버 `serve.py` |
| Python 패키지 (선택) | `python -m pip install -r v3.0.0/docs/requirements.txt` | 기술 문서(Word)·그림 다시 만들기 |
| 인터넷 | — | Three.js·Rapier(CDN). 첫 테스트 때 Rapier를 `tests/.cache/`에 자동으로 받음 |

1. **확인:** `v3.0.0/`에서 `node tests/run-all.mjs`를 실행해 `모두 정상 실행 (13개 스크립트)`가 나오는지 봅니다.
2. **결과 보기:** `v3.0.0/results/INDEX.md`에 모든 실행이 시간순으로 있습니다. 3D로 보려면 `start.bat` → **에피소드 재생 → 에피소드 불러오기**에서 `results/<날짜>/<시각>_…/*.rsim.json.gz`를 고릅니다.
3. **학습된 정책 실행:** 앱 **학습 (Trial & Error) → 정책 불러오기 (PPO)**에서 `results/2026-11-05/1814_ppo-train_kr210-run1/policy-best.json`을 고릅니다.
4. **같은 결과 다시 만들기:** 각 실행 폴더의 `run.json`에 실행한 명령이 그대로 있습니다. 같은 명령을 다시 실행하면 새 날짜·시각 폴더에 같은 결과가 생깁니다(시드 고정, 결정적 실행).
   - 예: `node tools/baseline.mjs --mains kuka-kr210-r2700 --configs alone --lane-dir robot,snout,alternate`
5. **기술 문서:** `v3.0.0/docs/README.md`에 목록이 있습니다. 문서마다 `build/` 스크립트로 다시 만들 수 있습니다.
6. **혼자 학습:** `v3.0.0\train.bat` 더블클릭 → 메뉴(전체 학습 / PPO 학습만 / 모델 평가 / 기준선 / 결과 목록). README의 "혼자 학습하기" 참고.
7. **학습 속도:** 진화 탐색·PPO는 CPU 코어를 많이 씁니다. 개발 PC 기준 Worker 14개입니다. 코어가 적으면 `--workers`를 줄이세요. 결과는 같고 시간만 늘어납니다.

## 5. Claude Code로 이어서 작업하기

```bash
cd robosim-lite
claude
```

- 저장소 루트의 `CLAUDE.md`가 자동으로 읽혀서 Claude Code가 폴더 구조, 실행·검증 방법, **버전 규칙(v1.0.0 보존, 현재 개발 폴더 v2.0.0·v3.0.0)** 을 알고 시작합니다. Claude Code는 저장소 루트(`robosim-lite`)에서 실행하세요.
- 이전 PC의 Claude Code 대화 기록과 메모리는 넘어오지 않습니다. 필요한 맥락은 루트의 `HANDOFF.md`(현재 상태·다음 할 일)와 `CLAUDE.md`, 각 버전 폴더의 `README.md`·`CHANGELOG.md`·PRD·PROMPTS·REVIEW에 정리되어 있습니다.
- 첫 요청 예: "HANDOFF.md와 v3.0.0/README.md를 읽고 v3.0.0/tests/run-all.mjs를 실행해서 이 환경에서 정상인지 확인해줘"

## 6. 문제 해결

| 증상 | 해결 |
|---|---|
| start.bat 창에 "Python was not found" 또는 Store가 열림 | 1장의 Python 설치/앱 실행 별칭 안내 참고 |
| "포트를 이미 사용 중" | 같은 버전의 다른 start.bat 창을 닫거나, `python serve.py 8021`처럼 다른 포트로 실행 (포트를 바꾸면 저장 데이터도 별도) |
| 로봇이 안 보이거나 "경로 계획 Worker 오류" | 다른 서버로 연 적이 있어 예전 파일이 캐시된 경우입니다. start.bat으로 다시 열고 새로고침. 계속되면 Ctrl+Shift+Delete → "캐시된 이미지 및 파일"만 삭제 |
| git push 403 | 2장 참고 (parkppjjmm 계정으로 인증) |
