# 새 노트북(다른 PC)에서 RoboSim Lite 설정하기

GitHub의 private 저장소 `parkppjjmm/robosim-lite`를 받아, 지금과 똑같이 실행하고 Claude Code로 이어서 작업하는 방법입니다.

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

## 2. 저장소 받기 (private 저장소 로그인)

저장소가 private이라 **parkppjjmm 계정 로그인**이 필요합니다. 주소에 계정명을 넣으면, 그 PC에 다른 GitHub 계정이 저장돼 있어도 parkppjjmm로 로그인 창이 뜹니다.

```bash
git clone https://parkppjjmm@github.com/parkppjjmm/robosim-lite.git
```

받은 저장소는 버전별 폴더로 나뉘어 있습니다.

| 폴더 | 내용 | 기본 주소 |
|---|---|---|
| `robosim-lite/v1.0.0/` | v1.0.0 고정본 (수정 금지) | http://localhost:8000 |
| `robosim-lite/v1.1.0/` | v1.1.0 개발 폴더 (문서·테스트 포함) | http://localhost:8011 |

- v1.0.0 시점의 저장소 전체가 필요하면 `git clone --branch backup/v1.0.0 …`으로 받을 수 있습니다. 태그 `v1.0.0`과 같습니다.

- 처음 clone할 때 브라우저에 GitHub 승인 페이지가 열립니다. **parkppjjmm로 로그인 → Authorize** 하면 이후로는 자동 인증됩니다.
- 로그인 창이 안 뜨면 아래 명령으로 직접 띄울 수 있습니다.
  ```bash
  git credential-manager github login --username parkppjjmm --browser
  ```
- 403(Permission denied)이 나면 다른 계정으로 인증된 것입니다. 주소에 `parkppjjmm@`가 들어 있는지 확인하세요.

## 3. 실행

| 환경 | 방법 |
|---|---|
| Windows | 실행할 버전 폴더(`v1.0.0/` 또는 `v1.1.0/`)의 `start.bat` 더블클릭 → 브라우저가 자동으로 열림 (검은 창은 서버이므로 사용하는 동안 열어 둠) |
| macOS / Linux | 버전 폴더에서 `python3 serve.py` → v1.0.0은 http://localhost:8000, v1.1.0은 http://localhost:8011 |

- `index.html`을 직접 열면(file://) 실행 방법 안내만 나옵니다. 반드시 위 방법으로 실행하세요.
- 저장 데이터(로봇, 장애물, Waypoint 등)는 **브라우저마다, 그리고 버전(포트)마다 따로** 저장됩니다. v1.0.0 장면을 v1.1.0에서 쓰려면 v1.0.0에서 내보내고 v1.1.0에서 가져오세요. 이전 PC의 작업 상태를 옮기려면, 이전 PC에서 **데이터 관리 → 내보내기(JSON)** 를 하고 새 PC에서 **가져오기**를 하세요.

## 4. 정상 동작 확인

1. **자동 검증 (Node 필요):** `v1.1.0/` 폴더에서 아래 명령을 실행해 `모두 정상 실행`이 나오면 됩니다(약 1분).
   ```bash
   node tests/run-all.mjs
   ```
   `--full`을 붙이면 스트레스·수치 검증까지 포함합니다(수 분). v1.0.0 폴더를 검증하려면 개별 스크립트에 경로를 주면 됩니다. 예: `node tests/planner.mjs ../v1.0.0`
2. **화면 확인:** README의 "시연 팁 → 벽 우회 예"를 따라 해서 A→B 경로가 생성·실행되는지 봅니다.

## 5. Claude Code로 이어서 작업하기

```bash
cd robosim-lite
claude
```

- 저장소 루트의 `CLAUDE.md`가 자동으로 읽혀서 Claude Code가 폴더 구조, 실행·검증 방법, **버전 규칙(v1.0.0 보존, v1.1.0 폴더에서 개발)** 을 알고 시작합니다. Claude Code는 저장소 루트(`robosim-lite`)에서 실행하세요.
- 이전 PC의 Claude Code 대화 기록과 메모리는 넘어오지 않습니다. 필요한 맥락은 `CLAUDE.md`, 각 버전 폴더의 `README.md`·`CHANGELOG.md`, `v1.0.0/PRD.md`·`REVIEW.md`, `v1.1.0/PRD_v.1.1.0.md`·`PROMPTS.md`에 정리되어 있습니다.
- 첫 요청 예: "CLAUDE.md와 v1.1.0/README.md를 읽고 v1.1.0/tests/run-all.mjs를 실행해서 이 환경에서 정상인지 확인해줘"

## 6. 문제 해결

| 증상 | 해결 |
|---|---|
| start.bat 창에 "Python was not found" 또는 Store가 열림 | 1장의 Python 설치/앱 실행 별칭 안내 참고 |
| "포트를 이미 사용 중" | 같은 버전의 다른 start.bat 창을 닫거나, `python serve.py 8021`처럼 다른 포트로 실행 (포트를 바꾸면 저장 데이터도 별도) |
| 로봇이 안 보이거나 "경로 계획 Worker 오류" | 다른 서버로 연 적이 있어 예전 파일이 캐시된 경우입니다. start.bat으로 다시 열고 새로고침. 계속되면 Ctrl+Shift+Delete → "캐시된 이미지 및 파일"만 삭제 |
| git push/clone 403 | 2장 참고 (parkppjjmm 계정으로 인증) |
