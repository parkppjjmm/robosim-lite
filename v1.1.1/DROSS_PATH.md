# 드로스 제거 셀 — 경로 생성 설계서 + 재구현 프롬프트

> 대상: RoboSim Lite v1.1.1 `v1.1.1/js/dross.js`(셀·드로스·레인·사이클 계획), `cell-robot.js`(측면 로봇·조정기), `physics.js`(설비·입자·부력), `gripper.js`(스키머·밀대), `main.js`("드로스 제거 셀" 절)
> 2026-11-05 2차 갱신: UR 협동 로봇 3종, 측면 로봇(모드 1 제거 / 모드 2 보조 밀기), 대형 로봇 사이클에 '스쿱 뒤로 기울임'·부드러운 출발/정지·통로 규칙 추가. 같은 내용을 스크린샷과 함께 정리한 Word 문서: `docs/RoboSim_v1.1.1_드로스셀_기술문서.docx`
> 목적: ① "▶ 1사이클"을 누르면 로봇 경로가 **어떻게** 만들어지는지 사람과 AI가 같은 그림으로 이해한다. ② 이 문서만 보고 다른 AI가 **같은 결과**를 다시 구현할 수 있다(2부 프롬프트).
> 관련 문서: 요구사항 `PRD_v.1.1.1.md`(FR-25~30), 진행표 `PROMPTS.md`, 검토 `REVIEW_v1.1.1.md`. 모든 수치는 2026-11-05 코드 기준이다.
> 좌표: 로봇 베이스 원점, Z-up, 단위 mm·deg·s. TCP = 스쿱 바닥판 윗면 중심.

---

# 1부. 설계 설명

## 1. 한 줄 요약
경로는 **랜덤이 아니라 정해진 동작 템플릿**이다. 바뀌는 입력은 세 가지다.
- **어느 레인을 쓸지:** 그 순간의 드로스 분포로 정한다.
- **어디서 출발하는지:** 현재 로봇 자세다.
- **어느 방향으로 쏟을지:** 정해진 8방향 중 처음 통과하는 방향이다.

구간은 대부분 **직선 보간**으로 만든다. 레인 접근이 직선으로 막힐 때만 **RRT 경로 계획**을 쓴다.

## 2. 무작위성과 재현성 (정확한 정리)

| 요소 | 무작위인가 | 재현성 |
|---|---|---|
| 레인 선택 | 아니오 (드로스 개수 최댓값) | 같은 드로스 분포 → 같은 레인 |
| 경유 자세(접근·하강·스윕·상승·박스 위·덤프) | 아니오 (상수 + 레인 좌표로 계산) | 항상 같음 |
| 직선 보간 → 관절값 | 아니오 (IK, 이전 해를 시드로 사용) | 같은 시작 자세 → 같은 관절 궤적 |
| 덤프 방향 | 아니오 (8방향을 고정 순서로 시도) | 같음 |
| RRT 경로 계획(①의 마지막 대안) | **고정 시드 의사난수**(`planner.js` `seed = 0x9e3779b9`) | 입력이 같으면 표본도 같다. 다만 smoothing 200 ms·블렌딩 150 ms·최적화 250 ms에 **시간 상한**이 있어서, PC 속도에 따라 다듬기 정도가 달라질 수 있다 |
| 드로스 초기 배치·발생 | 시드 난수(`rng(seed)`, mulberry32) | 같은 시드·발생률 → 비트 단위로 같음(테스트로 확인) |

> 정정: 이전 대화에서 "RRT는 무작위 표본이라 매번 다를 수 있다"고 설명했지만, 정확히는 **고정 시드라 입력이 같으면 같은 표본**이다. 결과가 달라질 수 있는 원인은 시간 상한이 있는 후처리다. 대형 4종 Node 테스트의 첫 사이클은 모두 직선 구간만으로 계획되어 RRT를 쓰지 않았다.

## 3. 셀 배치 상수 (`dross.js`)

| 항목 | 값 |
|---|---|
| 욕면 높이 `BATH_Z_MM` | 700 |
| 아연 포트 `POT` (안쪽) | X 1100~3700, Y −900~900, 벽 두께 100, 테두리 높이 800 |
| 강판·스나우트 `SNOUT` | X 2300~2500, Z 560~1200, 포트 폭 전체(Y −900~900) |
| 드로스 박스 `BIN` (바깥) | X 250~950, Y −1650~−1050, 높이 550, 벽 40 |
| 작업 영역 `WORK_ZONE` | X 1100~2300 (포트 앞벽 ~ 스나우트 앞), Y −900~900 |
| 스나우트 너머 `FAR_ZONE` | X 2500~3700 (다른 로봇 담당, 장면 재현용) |
| 사용 가능 로봇 | 도달거리 ≥ 2400 mm (IRB 6700, KR 210, R-2000iC, SRA166) |

고정 설비는 박스 10개(`drossFixtures()`)다. 내역은 포트 벽 4, 스나우트 1, 박스 바닥 1, 박스 벽 4이고 id는 `cell:`로 시작한다. 이 설비들은 **안전 검사·경로 계획의 장애물**이고, 물리 모드에서는 고정 바디다.

## 4. 드로스와 욕면 물리 (`physics.js` + `DrossField`)
- **입자:** 지름 40~90 mm 구, 밀도 3800 kg/m³, 마찰 0.7, 반발 0.05, 각감쇠 1.5. 장애물 목록·안전 검사와 별개다(작업 대상).
- **부력·저항:** 매 스텝 `world.step()` **전에** 충격량으로 준다. 포트 안쪽 XY에 있는 입자만 대상이다.
  - 잠긴 깊이 `h = clamp(zs − (z − r), 0, 2r)`
  - 잠긴 부피 `V = π·h²·(3r − h)/3` (구면 캡)
  - 저항 계수 `c = drag(10 s⁻¹) · m · (h/2r) · dt`
  - 충격량 `J = (−c·vx, −c·vy, ρ_zinc(6600)·g·V·dt − c·vz)`
  - 결과: 약 60% 잠긴 채 1 s 이동량 0 mm 수준으로 떠 있다.
  - 주의: 스텝 직후 `linvel()`은 약 60 mm/s로 보이는 인공값이다. 정지 판정은 위치 변화로 한다.
- **초기 배치(`init`):** 작업 영역 `count`개 + 스나우트 너머 `count/2`개를 놓는다.
  - 위치는 시드 난수로 뽑고, 기존 입자와 `r1 + r2 + 2 mm` 이상 떨어져야 한다(최대 30회 시도).
  - 60% 확률로 벽 띠(350 mm)에 몰린다. 그 안에서 40%는 +Y 벽, 40%는 −Y 벽, 20%는 앞벽(너머 영역은 뒷벽)이다.
  - 시작 높이는 `z = 700 − 0.15r`이다.
- **발생(`tick`):** 시뮬레이션 시간으로 `60/ratePerMin`초마다 하나씩 작업 영역에 `z = 700 + r`로 떨어뜨린다.
  - 욕면 근처(±150 mm) 입자와 겹치지 않는 자리를 최대 12회 찾는다. 전체 최대 800개.
- **물리 월드 생성 순서(결정성):** 새 `PhysicsWorld` → `setFixtures` → `load(사용자 물체)` → `setRobot` → `DrossField.init()`. 리셋도 새 월드로 같은 순서를 밟는다.

## 5. 스키머 툴 (`gripper.js`)
- **치수 `SKIMMER_SPEC`:** 봉 길이 700(=TCP 오프셋), 봉 지름 50, 바닥판 360×360×10, 턱 높이 80, 턱 두께 10. 앞쪽(+X 툴)은 열려 있다.
- **툴 좌표:** Z = 플랜지 → TCP 방향(스키밍 중에는 월드 아래), X = 열린 앞쪽. 바닥판은 z = 700~710, 턱은 z = 620~700(플랜지 쪽 = 위)이다.
- **안전 검사 캡슐(모두 link 7, 보수적):**
  - 봉: z 25 ~ 620, 반경 25
  - 스쿱: 반경 `r = max(180/3, 80, 10) = 80`, z = 700, y ∈ {−100, 0, 100}, x −100 ~ 100인 캡슐 3개 → 판 전체 폭·턱 끝·판 아랫면을 덮는다
- **물리 형상:** 봉 캡슐 + 박스 4개(바닥판, 뒤 턱, 좌·우 턱)를 운동학 바디로 둔다. 실제로 드로스를 떠 담는다.
- **레버암 상한(세분 검사):** `toolExtentMm = 700 + 10 + √(360²+360²)/2 ≈ 965 mm`.

## 6. 레인 (`skimLanes`)
여유 `m = 장애물 여유거리(기본 20) + 30 = 50`이다. 스쿱 반폭은 `hx = hy = 180`이다.
- `yMax = 900 − 180 − 50 = 670`
- 시작 X `xs = 2300 − 180 − 50 = 2070` (스나우트 앞)
- 끝 X `xe = 1100 + 180 + 50 = 1330` (포트 앞벽 쪽)
- 레인 수 `n = ceil(2·670 / (360·0.85)) + 1 = 6`, Y = −670, −402, −134, 134, 402, 670

## 7. 레인 선택 (`chooseLane`, 탐욕 선택)
- **센 대상:** 욕면에 떠 있는(`|z − 700| < r + 40`) 입자 중 레인 띠 `|y − lane.y| < 180`, `xe − 180 < x < xs + 180` 안에 있는 것.
- **점수:** `개수 + |레인 번호 − 직전 레인| × 0.001`. 최댓값 레인을 고르고, 같으면 직전 레인에서 먼 쪽이 된다.
- 개수가 0이면 'empty'다. 자동 연속 중 발생률 > 0이면 5 s(시뮬레이션 시간) 기다렸다가 다시 본다.

## 8. 사이클 경로 계획 (`planSkimCycle`)

### 8.1 자세 정의
- **수평 자세 `levelPose(p, dir)`:** 툴 Z = (0,0,−1), 툴 X = (dir, 0) 정규화, 툴 Y = Z × X. 스윕 방향 `dir = (−1, 0)`이다(스나우트 → 로봇 쪽으로 당김). 이때 열린 앞쪽이 진행 방향이라, 판이 드로스 밑으로 들어가고 뒤 턱이 모아 담는다.
- **기울인 자세 `tiltPose(T, θ)`:** `T · Ry(−θ)`. 툴 Y축 기준으로 θ = 105° 돌려 **열린 앞쪽이 아래로** 가게 한다(쏟기).

### 8.2 구간과 목표 (TCP, mm)

| # | 이름 | 목표 | 방법 | TCP 속도 |
|---|---|---|---|---|
| ① | 레인 접근 | (xs, y, 700+120) 수평 | (a) 직선 → (b) 높이 980에서 수평 이동(대각선 → X 먼저 → Y 먼저) → (c) RRT(Worker). **측면 로봇이 있으면 (a)를 건너뛰고 "지금 X에서 Y 먼저"만**(통로 규칙) | 250 (기본) |
| ② | 스쿱 하강 | (xs, y, 700 − 잠김 깊이 60) | 직선 | 150 |
| ③ | 스윕 | (xe, y, 640) | 직선 | 120 (설정) |
| ④ | 스쿱 상승 | (xe, y, 980) | 직선, **부드러운 출발·정지** | 150 |
| ④' | 스쿱 뒤로 기울임 | ④ 자세를 −12°(열린 앞쪽이 위로) | 직선(자세만), 부드럽게 | 90°/s |
| ⑤ | 드로스 박스로 이동 | 박스 중심 (600, −1350, 980), 뒤로 12° 기울인 채, 툴 X = 덤프 방향 d. **측면 로봇이 있으면 (600, y레인) 경유 = 박스 X까지 먼저** | 직선, 부드럽게 | 150 (담은 채) |
| ⑥ | 덤프 높이로 하강 | (600, −1350, zDump), 기울인 채 | 직선, 부드럽게 | 150 |
| ⑦ | 기울여 쏟기 | 수평 자세에서 105° 앞으로(tiltPose) | 직선(자세만 회전) → 안 되면 관절 보간(IK maxIter 100) | 회전 90°/s |
| ⑧ | 쏟는 중 | 대기 1.2 s | `action: wait` (시뮬레이션 시계) | — |
| ⑨ | 스쿱 수평 복귀 | ⑥ 위치의 수평 자세 | ⑦과 같음 | — |

- `zDump = 박스 높이 550 + 여유 20 + 30 + 판 반폭 180 + 캡슐 반경 80 = 860`이다. 덤프 높이는 860부터 +80, +160까지 올려 본다(팔이 짧거나 길어 접히는 로봇 대비).
- **부드러운 출발·정지(`linearMove` `ease`):** 드로스를 담은 구간(④~⑥)만 코사인 속도 프로파일로 바꾼다. 경로점은 같고 시각만 바꾸며, 최고 속도는 원래 일정 속도와 같고 시간은 π/2배다. 급출발 때 가속도가 마찰(0.7 g)을 넘어 드로스가 미끄러지던 문제(REVIEW n-2)를 줄인다.
- **뒤로 기울임 12°:** 구형 드로스는 판 위에서 잘 구른다. 운반 중 열린 앞쪽으로 굴러 나가지 않도록 앞을 들어 둔다.
- **통로 규칙(측면 로봇이 있을 때):** 대형 로봇은 드로스 박스 쪽(X ≈ 600) 통로로만 포트와 박스를 오간다. 측면 띠(|y| ≥ 470) 위를 대각선으로 지나다가 측면 로봇과 마주치던 문제를 막는다. 2차 시험에서 발견했다(측면 로봇이 대기하는 사이 대형 로봇이 다가가 정지).
- **덤프 방향 d 후보:** 박스 중심의 방위각 `atan2(−1350, 600)`에 [0, +45, −45, +90, −90, +135, −135, 180]°를 더한 8개다. ⑤~⑨가 **모두** 통과하는 첫 방향을 쓴다. 0°(로봇에서 멀어지는 방향)가 첫 후보인 이유는, 기울이면 플랜지가 d 방향으로 약 0.97·L 나가서 로봇 베이스에서 멀어지기 때문이다.

### 8.3 직선 보간 (`trajectory.js` `linearMove`)
- **분할:** 위치 5 mm 또는 자세 1° 단위 중 촘촘한 쪽으로 나눈다.
- **보간과 IK:** 위치는 선형, 자세는 slerp로 보간한다. 각 샘플을 플랜지 목표(`× toolMatrix(−700)`)로 바꿔, **이전 샘플의 관절값을 시드로** IK(DLS, maxIter 60)를 푼다.
- **실패 판정:** 샘플 사이 관절 변화가 10°를 넘으면 특이점 통과로 보고 실패시킨다.
- **시간:** 구간 시간 = max(위치/TCP 속도, 회전/90°/s, 관절별 변화/관절 기준 속도)이다. 기본은 일정 속도(가감속 없음)이고, `ease: true`면 코사인 프로파일(시간 π/2배, 최고 속도 동일)이다.

### 8.4 계획 시점 안전 검사
- **직선·관절 보간 구간:** 결과 관절 궤적의 인접 점 사이를 `motionValid`로 세분 검사한다.
  - 검사 항목은 자기 충돌 + 장애물(설비 + 사용자 물체 + 바닥) + 특이점(계획 옵션)이다.
  - 실행 기준 여유거리를 쓰고, 위반이 하나라도 있으면 그 구간 이름으로 실패한다.
- **RRT(① 대안):** 기존 `planPath`를 그대로 쓴다. 여유거리 + 4 mm 패딩 → RRT-Connect → Shortcut → CHOMP 스타일 최적화 → 블렌딩 → `pathTrajectory` 순서다.
- **드로스 입자는 검사 대상이 아니다.**
- **결과:** `{ steps: [{kind:'move', label, trajectory} | {kind:'action', type:'wait', sec}], vertices, duration }`

## 9. 실행 (`main.js`)
- **레인 선택과 계획:** `skimOnce()`에서 `chooseLane(현재 입자 상태)` → `planSkimCycle`을 부른다. RRT는 플래너 Worker로 보낸다.
- **3D 미리보기:** 보라 튜브 = TCP 궤적, 주황 점 = 스윕 끝(pick), 청록 점 = 쏟기(place).
- **실행:** `runSteps(steps)`로 이동마다 `MotionController.play`를 부른다. **매 tick 적용 전 안전 게이트**(`sweepCheck`)를 다시 통과하고, 위반이면 정지·알람이다.
- **물리 반영:** 통과한 자세의 스쿱 박스가 운동학 바디로 이동해 드로스를 떠 담고 쏟는다.
- **사이클 시간:** 시뮬레이션 시계(`simClock`) 차이로 잰다.
- **자동 연속:** 'done'이면 반복한다. Esc·정지 버튼·알람·실패면 끝난다. Space = 일시정지/계속.
- **바쁜 상태:** 계획·실행 중에는 `robotBusy()`가 true다. 모드 전환·리셋·로봇 변경·셀 켜기/끄기를 막는다.

## 10. 측정값 (Node `tests/dross.mjs`, 드로스 120개·시드 11·홈 자세 시작)

| 로봇 | 계획 시간 | 예상 사이클 | 회수 | 흘림 | 안전 위반 |
|---|---|---|---|---|---|
| IRB 6700 | 578 ms | 30.5 s | 22개 (13.9 kg) | 1 | 0 |
| KR 210 | 439 ms | 30.2 s | 23개 (14.2 kg) | 0 | 0 |
| R-2000iC | 463 ms | 30.2 s | 21개 (13.0 kg) | 1 | 0 |
| SRA166 | 448 ms | 30.4 s | 21개 (13.3 kg) | 1 | 0 |

(2차 갱신 후 값. 1차(가감속·뒤로 기울임 없음)는 사이클 24.2~24.6 s, 회수 18~22개, 흘림 2~3개였다. 사이클은 약 6 s 길어지고 흘림이 줄었다.)

## 11. UR 협동 로봇 3종 (`robots.json`)

| 모델 | 크기 | 가반하중 | 도달거리(카탈로그 / 근사) | d1 | 상완 | 전완(근사) | 플랜지 d6 | 관절 범위 | 관절 속도 °/s |
|---|---|---|---|---|---|---|---|---|---|
| UR5e | 소형 | 5 kg | 850 / 855 mm | 163 | 425 | 430 | 100 | J1·J4~J6 ±360, J2 ±150, J3 ±160 | 180 ×6 |
| UR10e | 중형 | 12.5 kg | 1300 / 1303 mm | 181 | 613 | 690 | 117 | 같음 | 120,120,180,180,180,180 |
| UR20 | 중형 | 20 kg | 1750 / 1750 mm | 236 | 862 | 888 | 154 | 같음 | 120,120,150,210,210,210 |

- 다른 모델과 같은 규칙의 **근사 모델**(6축 구형 손목)이다. 실제 UR은 오프셋 손목이라 손목 모양은 다르다. 전완 길이는 도달거리(J1 축 → 손목 중심 최대 수평거리)가 카탈로그 ±5% 안에 들도록 정했다.
- `cobot: true`. 근사에서 생기는 베이스↔상완(0-2) 자기 충돌 오탐은 협동 로봇만 검사하지 않는다(실제 상완은 어깨 오프셋만큼 옆으로 나가 있음).

## 12. 측면 로봇 (`cell-robot.js`)

### 12.1 배치·좌표
- **슬롯:** 왼쪽 L 베이스 (1700, 1250, 800), yaw −90° / 오른쪽 R (1700, −1250, 800), yaw +90°. 로봇 로컬 +X가 포트 안쪽을 본다. 받침대 400×400×800(노랑)은 다른 로봇에게 장애물이다.
- **좌표 변환(`slotFrame`):** 베이스는 Z축 회전만 있다.
  - 월드 → 로컬: `pL = Rz(−yaw)·(pW − base)`
  - 장애물 회전: ZYX 회전 `[rx, ry, rz]` → `[rx, ry, rz − yaw]`
  - 측면 로봇은 **로컬 좌표에서 계획·안전 검사**를 하고, 화면·물리·로봇 간 간섭에는 월드로 바꿔 쓴다.
- **후보:** 소형(sizeClass small) 또는 협동 로봇(cobot) → IRB 1200, KR 6, LR Mate, MZ07, UR5e, UR10e, UR20.
- **대기 자세(park):** TCP (1700, ±980, 1000)(자기 쪽 포트 벽 위), 툴 아래, 포트 안쪽을 봄. 안 되면 후보 4개를 더 시도한다((1700, ±960, 1150), (1950, ±960, 1100), (1450, ±960, 1100), (1700, ±940, 1300)).
- **툴:** 모드 1 = 작은 스키머(봉 350, 스쿱 200×200×6, 턱 50), 모드 2 = 밀대(봉 350, 날 폭 300 × 높이 120 × 두께 8, 툴 X = 미는 방향). 밀대 안전 캡슐 = 봉 + 날 폭 방향 캡슐 1개(r 60), 물리 = 날 박스 1개.

### 12.2 모드 1 — 제거(구역 분할, 동시 작업)
- **구역 분할:** 경계 |y| = 470 mm, 경계 여유 60 mm.
  - 대형 로봇: 그쪽 측면에 모드 1 로봇이 있으면 레인 중심 |y| ≤ 230 (`mainLaneRange`). 양쪽 모두면 레인 3개(−230, 0, 230).
  - 측면 로봇: 레인 중심 |y| = 630, 750.
- **측면 레인:** 각 Y에서 X = 2150 → 1400 사이를 25 mm 간격으로 IK·정적 검사해, 연속으로 가능한 가장 긴 구간을 쓴다. 200 mm 미만이면 버린다. 스윕은 −X 방향이다. X < 1400은 대형 로봇 통로라 비운다.
- **사이클:** 대형과 같은 `planSkimCycle`에 로컬 좌표 셀을 넘긴다.
  - 셀 값: bathZ = −100, liftZ = 930 − 800, bin = 측면 박스(로컬), 잠김 45 mm, 스윕 120 mm/s.
  - RRT 대신 관절 보간을 대안으로 쓴다(플래너 Worker는 대형 로봇 전용).
- **측면 박스:** 380×380×450. 베이스에서 +X로 로봇별 거리 `SIDE_BIN_TABLE`에 둔다.
  - IRB 1200·KR 6·UR10e 750 mm / UR5e·UR20 650 mm / LR Mate·MZ07 550 mm.
  - 이 값은 `pickSideBinDist`가 450~850 mm 후보마다 실제 사이클을 계획해 보고 성공 레인이 가장 많은 거리를 고른 결과다. 테스트가 표와 계산이 같은지 확인한다.

### 12.3 모드 2 — 보조 밀기(포트 점유 잠금)
- **밀기 레인:** X = 1300·1500·1700·1900·2100 각각에서, |y| 790(벽 쪽)부터 |y| 250(목표)까지 25 mm 간격으로 가능한 구간을 쓴다. 150 mm 미만이면 버린다.
- **스트로크(`planPushStroke`):** 시작점 위(욕면 + 120) → 날 하강(욕면 − 70) → 밀기(150 mm/s) → 상승(욕면 + 150) → 대기 자세 복귀.
- **잠금(`CellCoordinator`):**

```
대형 로봇 사이클:  계획 시작 → wantsPot = true
                 → [대기: 모드 2 측면 로봇이 포트 안(계획 중 포함)이 아닐 때까지]
                 → ① 레인 접근 ~ ④ 스쿱 상승  (포트 안)
                 → ⑤부터 wantsPot = false     (박스로 가는 동안 포트를 비워 줌)
모드 2 측면 로봇:  wantsPot = false일 때만 새 스트로크 계획·시작 → 끝나면 대기 자세
```

- **레인 선택:** 레인 띠(진행 방향 길이 + 반폭) 안의 욕면 드로스 수가 최대인 레인을 고른다. 0개면 3 s 뒤 다시 본다. 실패한 레인은 다음 3번의 계획에서 뺀다.

### 12.4 로봇 간 간섭 — 세 겹의 안전장치
1. **대형 로봇의 적용 전 검사:** `ctx.others`에 측면 로봇의 현재 캡슐(월드)을 넣는다. 감지 토글과 무관하게 항상 검사하고, 여유거리(20 mm) 안이면 정지·알람이다. `safeFraction`도 이 거리를 써서 세분 간격을 정한다.
2. **측면 로봇의 양보:** 매 스텝 정적 검사(로컬 `sweepCheck`) 뒤, 다른 로봇과 (여유거리 + 30 = 50 mm)보다 가까워지면 그 자리에서 기다린다. 20 s를 넘으면 알람이다.
3. **시작 전 경로 확인(`pathClash`):** 계획한 경로 전체(점 3개마다)가 다른 로봇의 현재 자세와 50 mm 이상 떨어져 있을 때만 시작한다. 막히면 계획을 보관했다가 1 s마다 확인만 다시 한다(최대 10회).

## 13. 측정값 — 측면 로봇 동시 실행 (Node `tests/cell-robots.mjs`, KR 210, 드로스 160개·시드 11, 120 s)

| 시나리오 | 대형 사이클 | 박스별 회수 (대형 / 왼쪽 / 오른쪽) | 흘림 | 안전 위반 | 로봇 간 최소 거리 | 측면 작업 |
|---|---|---|---|---|---|---|
| A. 대형 단독 | 2 | 64 / – / – | 2 | 0 | – | – |
| B. 모드 1 (L UR10e, R IRB 1200) | 2 | 28 / 8 / 5 (합계 41) | 13 | 0 | 236 mm | 각 3회 |
| C. 모드 2 (양쪽 UR10e) | 2 | 46 / – / – | 8 | 0 (잠금 위반 0) | 85 mm | 밀기 각 5회 |

- 안전: 세 시나리오 모두 대형·측면 로봇 안전 위반 0, 로봇 간 최소 거리 ≥ 20 mm(여유거리)이다.
- **처리량(측정값, 합격 기준 아님):** 120 s 동안의 회수량은 대형 단독(64)보다 모드 1 합계(41)와 모드 2(46)가 적었다.
  - 모드 1: 대형 레인이 가운데(|y| ≤ 230)로 줄었다. 드로스는 벽 근처에 많은데(초기 배치 60%), 작은 스쿱은 한 번에 적게 담는다.
  - 모드 2: 대형 로봇이 측면 밀기가 끝나기를 기다리는 시간이 생긴다.
  - 짧은 시간의 처리량이 아니라 역할 분담 기능을 구현했다. 처리량 최적화(구역 경계·스쿱 크기·밀기 시점)는 v1.2.0 AI 최적화의 좋은 대상이다(REVIEW n-7).

## 14. 한계 (REVIEW_v1.1.1 n-1~n-9)
- 계획(직선 구간 검사)이 메인 스레드에서 돈다. 대형 사이클 약 0.4~0.6 s, 측면 모드 1 약 0.4~0.6 s, 모드 2 약 0.07 s 동안 화면이 멈출 수 있다.
- 벽·스나우트 앞 띠(여유거리 때문)의 드로스는 레인이 닿지 않는다.
- 레인 선택은 탐욕(1단계 앞만 봄)이다 → v1.2.0 AI 최적화 후보.
- 모드 2는 시간 분할(잠금)이라 대형 로봇이 측면 밀기를 기다리는 시간이 생긴다. 120 s 시험에서 대형 박스 회수는 단독보다 적었다(13장).
- 측면 로봇이 2대면 실제 GPU에서의 FPS는 재지 않았다(헤드리스 소프트웨어 렌더링 4~8 FPS).

---

# 2부. 재구현 프롬프트 (다른 AI용)

> 사용법: 아래 단계를 순서대로 각각 새 요청으로 붙여넣는다. 전제 코드는 RoboSim Lite **v1.1.0**(물리엔진 Rapier, 그리퍼, Pick & Place, `runSteps` 단계 실행, Worker 경로 계획)이다. 각 단계는 앞 단계의 테스트가 통과한 뒤 진행한다.
> 모든 수치는 1부와 같아야 같은 결과(레인 6개, 회수 21~23개/사이클)가 나온다. 10~14단계는 2차 요청(UR·측면 로봇)이다.

## 공통 전제 (모든 단계에 포함)
```
- 프로젝트 규칙은 저장소 루트 CLAUDE.md, 설계 기준은 v1.1.1/DROSS_PATH.md 1부(수치 포함)를 따른다.
- 좌표: 로봇 베이스 원점 Z-up, mm·deg·s. 앱 ↔ Rapier 단위 변환은 physics.js 경계에서만(MM = 0.001).
- 순수 계산 모듈(dross.js, gripper.js, physics.js, trajectory.js)은 DOM에 의존하지 않게 해서 Node 테스트·Worker에서 재사용한다.
- 모든 로봇 이동은 물리엔진보다 먼저 기존 안전 게이트(motion.js → safety.js)를 통과해야 한다.
- 셀을 끄면 v1.1.0과 완전히 같은 동작이어야 한다(회귀 금지). 단계마다 node tests/run-all.mjs 실행.
- UI 문구·주석은 한국어(전문 용어 영문 병기). 결과는 사실대로 보고(생략한 검증 포함).
```

## 1단계 — 셀 배치 상수와 고정 설비
```
js/dross.js를 새로 만들어줘 (DOM 비의존).
1. 상수: BATH_Z_MM=700, POT={x0:1100,x1:3700,y0:-900,y1:900,wall:100,rimZ:800},
   SNOUT={x0:2300,x1:2500,z0:560,z1:1200}, BIN={x0:250,x1:950,y0:-1650,y1:-1050,h:550,wall:40},
   WORK_ZONE=포트 x0~SNOUT.x0, FAR_ZONE=SNOUT.x1~포트 x1, DROSS_MIN_REACH_MM=2400, drossRobotOk(robot).
2. drossFixtures(): 박스 10개 { id:'cell:…', name(한국어), type:'box', pos(중심), size, rot:[0,0,0], visible:true, fixture:true, part:'pot'|'snout'|'bin' }
   — 포트 벽 4(앞·뒤는 Y 길이 = 안쪽+2·벽, 좌·우는 X 길이 = 안쪽+2·벽, 높이 rimZ), 스나우트 1(포트 폭 전체),
     드로스 박스 바닥 1(두께 = 벽 40) + 벽 4(높이 550).
3. 설정: DROSS_DEFAULTS={enabled:false,count:160,ratePerMin:0,seed:1,immersionMm:60,sweepMmS:120},
   DROSS_LIMITS={count:[0,400],ratePerMin:[0,120],seed:[1,99999],immersionMm:[20,75],sweepMmS:[30,250]},
   sanitizeDross(raw): 범위 안 숫자만, count·seed는 반올림, 없으면 꺼짐+기본값.
4. state.js: createDefaultState의 cell에 dross 기본값, sanitize에서 cell.dross = sanitizeDross(raw.cell.dross). schemaVersion은 2 유지.
검증: drossFixtures() 개수 10, sanitizeDross 범위 테스트.
```

## 2단계 — 물리: 고정 설비·입자·부력
```
js/physics.js의 PhysicsWorld에 추가해줘.
1. setFixtures(list): 고정 바디 1개에 cuboid 콜라이더(마찰 0.5)를 설비 수만큼. 다시 부르면 이전 것 제거.
2. addParticle({pos,rMm,densityKgM3,friction=0.7,restitution=0.05}): 동적 구(각감쇠 1.5), particles 배열에 {body,r,massKg,out} 저장.
3. setFluid({zMm,bounds:[x0,x1,y0,y1],densityKgM3,drag}) / applyFluid(): bounds 안 입자마다
   h=clamp(zs-(z-r),0,2r), V=π h²(3r-h)/3, c=drag·m·(h/2r)·dt,
   applyImpulse({x:-c·vx, y:-c·vy, z: ρ·g·V·dt - c·vz}) (g = -gravityZ). step()에서 world.step() 전에 호출.
4. step()에서 입자도 범위 이탈(z < -1000 mm 또는 반경 > 50 m)이면 비활성화(out=true).
5. particleState(): 재사용 Float64Array [x,y,z,r,…](mm), out이면 r=0.
6. setGravity에 gravityZ 갱신, 입자도 wakeUp.
7. 로봇 바디: 세그먼트에 box:{center(mm),R(3x3),half(mm)}가 있으면 캡슐 대신 cuboid (setRobot·moveRobot·placeRobot 공통).
검증(Node): 입자 60개를 욕면에 놓고 240 스텝 뒤 모든 중심이 욕면 ± 반지름(실측 최대 3.4 mm), 이후 1 s 이동량 < 10 mm.
주의: 정지 판정에 linvel()을 쓰지 말 것(부력 충격량 때문에 정지해도 ~60 mm/s로 보임).
```

## 3단계 — 드로스 입자 관리(DrossField)
```
js/dross.js에 추가해줘.
1. rng(seed): mulberry32. ZINC_DENSITY=6600, DROSS_DENSITY=3800, FLUID_DRAG=10, DROSS_DIAMETER_MM=[40,90], MAX_PARTICLES=800.
   drossFluid() = {zMm:700, bounds:[POT.x0,POT.x1,POT.y0,POT.y1], densityKgM3:6600, drag:10}.
2. class DrossField(physics, cfg): 생성자에서 rand=rng(seed), physics.setFluid(drossFluid()).
   - samplePos(zone,r,existing,tries=30): 균일 표본, 단 60% 확률로 벽 띠(band=350·rand)로 이동
     (side<0.4 → y=zone.y1-r-band, <0.8 → y=zone.y0+r+band, 나머지 → 작업 영역은 x=x0+r+band / 너머는 x=x1-r-band).
     기존 입자와 (r1+r2+2)² 이상 떨어진 첫 위치, 없으면 null. **난수 호출 순서를 이대로 지킬 것(결정성).**
   - init(): r = (40 + rand·50)/2, 작업 영역 count개 → 너머 round(count/2)개, z = 700 - 0.15r.
   - tick(dt): ratePerMin>0이고 800개 미만이면 누적 시간으로 60/rate초마다 1개, 욕면 ±150 mm 입자와 겹침 확인(12회), z = 700 + r.
   - stats(): 박스 안쪽(벽 두께만큼 안) & z < 610 → bin, 욕면(|z-700| < r+40) & 작업 영역 → work(+coverage 면적),
     욕면 & 너머 → far, z < 200 & 포트 밖 → spilled, 나머지 → carried, out → out. binKg, workKg, coverage(%), total, spawned.
검증(Node): 같은 시드(7)·발생률(60)로 300 스텝 2회 → 입자 위치 차이 0.
```

## 4단계 — 스키머 툴
```
js/gripper.js에 스키머를 추가해줘.
1. SKIMMER_SPEC = {kind:'skimmer', lengthMm:700, rodDiaMm:50, plateXMm:360, plateYMm:360, plateThickMm:10, lipMm:80, wallMm:10,
   maxOpenMm:0, fingerThickMm:0, fingerWidthMm:0, bodyDiaMm:50, bodyHeightMm:0, actuationS:0.3, maxPayloadKg:60}.
2. toolSegments(spec,T6,opening): kind==='skimmer'면 skimmerSegments — 모두 link 7, part 표시:
   봉 {part:'rod', a:(0,0,rr), b:(0,0,L-lip), r:rr}, 스쿱 r=max(hy/3,lip,thick)=80, x=hx-r, yOff=hy-r, z=L인
   {part:'plate'} 캡슐 3개(y = -yOff, 0, +yOff, a.x=-x, b.x=+x). (플랜지 좌표 → apply(T6, ·))
3. skimmerBoxes(spec,T6): 박스 4개 {link:7, part:'scoop', box:{center, R(T6 회전), half}} —
   바닥판 c(0,0,L+t/2) h(hx,hy,t/2) / 뒤 턱 c(-hx+w/2,0,L-lip/2) h(w/2,hy,lip/2) / 좌·우 턱 c(0,±(hy-w/2),L-lip/2) h(hx,w/2,lip/2).
4. toolExtentMm(spec): 스키머 = L + 두께 + √(px²+py²)/2, 그리퍼 = 기존 식. safety.js leverBounds가 이 함수를 쓰게 변경.
5. viewer.js setGripper: kind==='skimmer'면 봉 원기둥 + 판·턱 박스 메쉬(하이라이트 link 7).
검증(Node): 툴 Z가 아래인 T6에서 캡슐 최저점 ≤ 판 아랫면, 캡슐 최고점 ≥ 턱 끝, y 범위가 ±180을 덮음. 박스 4개.
```

## 5단계 — 레인과 레인 선택
```
js/dross.js에 추가해줘.
SKIM = {approachAboveMm:120, liftZMm:980, dumpTiltDeg:105, dumpWaitS:1.2, loadedMmS:150, verticalMmS:150, laneOverlap:0.85, clearanceMm:30}.
1. skimLanes(spec, marginMm): m = margin+30, yMax = POT.y1-hy-m, xs = SNOUT.x0-hx-m, xe = POT.x0+hx+m,
   n = max(1, ceil(2·yMax/(plateY·0.85))+1), lane i: {index:i, y: -yMax + 2·yMax·i/(n-1), xs, xe}.
   기본(여유 20)에서 n=6, y=±670/±402/±134, xs=2070, xe=1330이 나와야 한다.
2. chooseLane(lanes, particleState, spec, lastIndex=-1): r>0 & |z-700|<r+40 & |y-lane.y|<hy & xe-hx<x<xs+hx 개수,
   score = count + |index-lastIndex|·0.001 (lastIndex≥0일 때), 최댓값 {lane,count,score}.
```

## 6단계 — 사이클 계획(planSkimCycle)
```
js/dross.js에 planSkimCycle(input, {plan})을 만들어줘. DROSS_PATH.md 8장과 같은 구간·수치.
- 먼저 trajectory.js linearMove에 옵션 tcpSpeedMmS(기본 BASE_TCP_MM_S=250)를 추가해 구간 시간 계산에 쓴다.
- levelPose(p, dir): X=(dir 정규화,0), Z=(0,0,-1), Y=Z×X=(X.y,-X.x,0), poseMatrix(열 X,Y,Z).
- tiltPose(T, deg) = T · Ry(-deg) (Ry(a) = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1], a = -deg).
- ctx = createSafetyContext(robot, {features:{selfCollision:true, obstacleCollision:true, singularity:avoidSingularity},
  thresholds, obstacles(설비+물체), floor, tool:{spec, opening:0}, physicsMode:true}).
- linear(qa, T, speed): linearMove(…, {toolLengthMm:L, tcpSpeedMmS:speed}) → 인접 점마다 motionValid(ctx, …, 위반 0). 실패 시 메시지.
- joint(qa, T): solveIK(T·toolMatrix(-L), seed=qa, maxIter 100) → 끝 자세 위반 0 & motionValid → jointMove.
- 순서: ① Tapp=(xs,y,820): linear → [현재 xy, max(z,980)] → (xs,y,980) → Tapp 직선 3개 → plan({start,goal:pose(Tapp),obstacles,tool,attached:null,physicsMode:true}) 후 pathTrajectory
  ② (xs,y,700-immersion) 150 ③ (xe,y,…) sweepMmS ④ (xe,y,980) 150
  ④ 다음에 ④' '스쿱 뒤로 기울임' = tiltPose(level, -12°). ④·④'·⑤·⑥은 linearMove({ ease: true }) — 코사인 속도 프로파일(시간 π/2배).
  ⑤~⑨ 박스 중심 c=(600,-1350), zDump = BIN.h + margin + 30 + plateX/2 + r(80), 덤프 높이 +0/+80/+160 차례로 시도;
     d 후보 = atan2(c.y,c.x) + [0,45,-45,90,-90,135,-135,180]°. 각 d마다
     a=linear(q4, level(c,980,d), 150) → b=linear(level(c,zDump,d), 150) → c=linear(tilt 105°) 실패 시 joint → back=linear(level) 실패 시 joint.
     전부 성공한 첫 d 사용, 없으면 '덤프' 실패.
- steps: move 8개 + {kind:'action', type:'wait', sec:1.2, label:'쏟는 중'}, label은 한국어(레인 접근, 스쿱 하강, 스윕, 스쿱 상승,
  드로스 박스로 이동, 덤프 높이로 하강, 기울여 쏟기, 쏟는 중, 스쿱 수평 복귀). vertices: start/via/pick(스윕 끝)/place(쏟기)/end.
- 실패 반환: {ok:false, stage, message:'구간: 원인'}.
```

## 7단계 — Node 실행 재현 테스트
```
tests/dross.mjs를 만들어 run-all.mjs 빠른 목록에 넣어줘.
- 월드 순서: new PhysicsWorld → setFixtures(drossFixtures()) → load([]) → DrossField(count 120, seed 11).init() → 120 스텝 안착.
- 대형 4종 각각: skimLanes → chooseLane → planSkimCycle(q0 = 홈 자세, plan = planPath 직접 호출, timeout 8000).
- 실행 재현(main.js 루프와 같은 순서): 매 1/60 s 궤적 샘플 → evaluatePose(위반 집계) → moveRobot(rod 캡슐 + skimmerBoxes) → step → field.tick.
  wait 단계는 그 시간만큼 스텝, 끝나고 90 스텝 더.
- 기대: 4종 모두 계획 성공, 안전 위반 0 tick, 박스 회수 ≥ 1 (실측 18~22개), 결정성·부력·스키머 모델·설정 검증 포함.
```

## 8단계 — 앱 통합(UI·실행)
```
main.js / viewer.js / dross-panel.js / index.html을 통합해줘.
1. cellActive() = 셀 ON & 대형 로봇. cellFixtures(), envObstacles(obstacles) = [...설비, ...obstacles]를 rebuildSafety·드래그 미리보기·
   알람 이름·경로 계획 스냅샷(obstaclesSnapshot)·물리 재개 안내에 사용.
2. applyGripper: cellActive면 SKIMMER_SPEC, 아니면 그리퍼 설정. physicsSegments: part 'plate' 캡슐 대신 skimmerBoxes.
   스키머일 때 그리퍼 명령은 안내 후 건너뜀({ok:true}), 그리퍼 설정·Pick & Place는 거부 안내, 알람 링크 이름 '스키머 (봉·스쿱)'.
3. createWorld(RAPIER): 새 월드 → setFixtures → load → dropGripState → setRobot → DrossField.init → 집계·표시. 모드 전환·리셋·셀 토글·로봇 변경(셀 활성 여부 변화)에서 사용.
4. 루프: simClock += 1/60 (매 스텝), 물리 스텝 뒤 drossField.tick, 매 프레임 viewer.setDross(particleState), 매 1 s stats → 패널.
5. 실행: startSkim(auto) → skimOnce(): chooseLane → planSkimCycle(plan = runPlanner Worker) → setPlanPreview(궤적 TCP, vertices) →
   runSteps(steps, kind 'skim') → 사이클 시간 = simClock 차이. auto면 'done'인 동안 반복, empty & 발생률>0이면 5 s 대기.
   stopSkim(Esc·정지 버튼·로봇 변경): auto 해제, 계획 중이면 Worker 취소, 실행 중이면 stopSteps. robotBusy에 계획 중 포함. Space = 일시정지/계속.
6. viewer: setCell(설비 박스 — 포트 #4d535b, 스나우트 #9aa2ab, 박스 #7b2f38 / 욕면 #cdd3da 금속 + 100 mm 격자 / 강판 판 / 박스 윗면 노란 X),
   setDross(InstancedMesh 구, 6색 팔레트 [#3a3c40,#55585d,#7e8287,#a3a7ac,#2b2c2f,#b8a68a]를 인덱스 해시로), 설비 충돌 하이라이트.
7. 패널: 스위치, 대형 로봇 안내 + "대형 로봇으로 바꾸기"(같은 메이커 우선), ▶ 1사이클 / ⟳ 자동 연속 / ■ 정지 / ↺ 다시 배치 / 셀 보기,
   상태 문구, 집계 6줄, 설정 5개(개수·시드는 다시 배치 때 반영 안내). 셀 보기 카메라 pos (1700,-4300,6000) target (1700,-350,450).
검증(브라우저): KR 210 → 셀 켜기 → 1사이클(회수 ~20) → 자동 연속 2회(알람 0) → Esc → 새로고침 복원 → 셀 끄기, 콘솔 에러 0.
```

## 9단계 — 문서·검토
```
PRD(요구사항·수용 기준), PROMPTS(진행표), REVIEW(실행한 검증과 하지 않은 검증, 남은 이슈), CHANGELOG [Unreleased],
README 사용법, 루트 HANDOFF.md(현재 상태·다음 할 일)를 갱신해줘. 커밋·태그는 사용자 요청 시에만.
```

## 10단계 — UR 협동 로봇 3종
```
js/robots.json에 메이커 { id:'UR', name:'UR', color:'#1C8FD6' }와 모델 3종을 추가해줘 (cobot: true, color '#D3DCE4', home [0,0,0,0,90,0]).
DH는 기존 모델과 같은 6축 구형 손목 패턴 [a, alpha, d, offset]:
  J1 [0,-90,d1,0] J2 [상완,0,0,-90] J3 [0,-90,0,0] J4 [0,90,전완,0] J5 [0,-90,0,0] J6 [0,0,d6,0]
  UR5e  small  5 kg  850 mm: d1 163, 상완 425, 전완 430, d6 100, 속도 [180×6], 반경 [75,60,50,45,42,38]
  UR10e medium 12.5  1300:   d1 181, 상완 613, 전완 690, d6 117, 속도 [120,120,180,180,180,180], 반경 [95,80,65,52,50,45]
  UR20  medium 20    1750:   d1 236, 상완 862, 전완 888, d6 154, 속도 [120,120,150,210,210,210], 반경 [120,100,80,65,60,55]
  관절 범위 J1·J4~J6 [-360,360], J2 [-150,150], J3 [-160,160].
collision.js buildSelfPairs: robot.cobot이면 (0,2) 쌍 제외 (실제 UR 상완은 어깨 오프셋으로 베이스와 닿지 않음 — 근사 오탐 방지).
catalog note에 'UR은 오프셋 손목이지만 구형 손목으로 근사' 명시. 검증: tests/reach.mjs ±5%(855/1303/1750), gripper.mjs 홈 자세 오탐 0.
```

## 11단계 — 측면 로봇 기반(슬롯·툴·물리·안전)
```
1. dross.js: SIDE_SLOTS(left: base [1700,1250,800], yaw -90 / right: [1700,-1250,800], yaw 90), PEDESTAL 400×400,
   SIDE_BIN { half 190, y0 1080, y1 1460, h 450, wall 30 }, sideBin(slot, binDist) = 베이스 X + binDist 중심,
   drossFixtures(sides): 슬롯에 robotId가 있으면 'cell:ped-<slot>' 받침대 + 'cell:sbin-<slot>-*' 박스 5개 추가, drossBins(sides).
   stats(bins): 박스별 개수 s.bins[id]. DROSS_DEFAULTS와 별도로 SIDE_DEFAULTS, sanitizeDross(raw, robotOk)에 sides 검증.
2. gripper.js: SKIMMER_SMALL_SPEC(L 350, 봉 30, 판 200×200×6, 턱 50, 벽 6, payload 5), RAKE_SPEC(kind 'rake', L 350, 봉 30, 날 W300 H120 T8),
   rakeSegments(봉 + 툴 Y방향 캡슐 r = H/2), rakeBoxes(날 박스), toolBoxes(spec, T6), toolExtentMm에 rake.
3. physics.js: setExtraRobot / moveExtraRobot / removeExtraRobot (id별 운동학 바디, 캡슐·박스).
4. safety.js: ctx.others = [{ id, segments(이 로봇 좌표) }] — evaluatePose에서 항상 링크(≥1) × 상대 캡슐 거리 검사,
   여유거리 안이면 OBSTACLE 위반 key 'O:<link>:robot:<id>', obstacle.minDistance에 반영, safeFraction도 이 거리 사용.
   capsuleSetDistance(segsA, segsB) export.
```

## 12단계 — CellRobot·레인·계획
```
js/cell-robot.js (DOM 비의존):
- slotFrame(slot): toWorld/toLocal/dirLocal, obstacleLocal(rot[2] - yaw), segWorld(캡슐·박스), levelLocal(p, dirW), binLocal(bin).
- class CellRobot(slot, robot, mode, { thresholds, obstaclesWorld, binDist }):
  setEnvironment(로컬 ctx: features self+obstacle, floor:false, 자기 받침대 제외, tool, physicsMode),
  findPark(후보 5개 순서, solveIKMulti 40 seeds, 위반 없는 첫 해), computeLanes(모드 1: |y| 630·750 × X 2150→1400 스캔 25 mm, 200 mm 이상 /
  모드 2: X 1300..2100 × |y| 790→250 스캔, 150 mm 이상), planNext(particles, obstaclesWorld, others):
  레인 선택(실패 레인 3회 냉각) → 모드 1 planSkimCycle(cell: 로컬 bathZ·liftZ(930)·bin, plan:null) / 모드 2 planPushStroke(park 포함)
  → pathClash(경로 전체 vs 다른 로봇 현재 캡슐, 여유 + 30) 막히면 'blocked'(계획 보관, 자세 그대로면 재확인만)
  → startPlan. tick(dt, env): sweepCheck(로컬) 실패 = onBlocked(알람), 다른 로봇과 (여유 + 30) 미만이면 hold(20 s 넘으면 알람).
- dross.js 일반화: motionKit(linear(ease 옵션)/joint/reach(order 'auto'|'y-first')), planSkimCycle(lane{start,end} 지원, cell{bathZ,liftZ,bin,corridor,dumpVia}),
  planPushStroke, chooseLane(일반 레인 inLane), skimLanes(..., {yLo,yHi}), mainLaneRange(spec, sides) = 모드 1 측면 쪽은 |y| ≤ 470-60-hy.
- pickSideBinDist(robot, slot, thresholds): SIDE_BIN_DISTS [750,650,550,850,450] 순서로 레인별 계획 성공 수 최대 → SIDE_BIN_TABLE로 저장
  (IRB1200·KR6·UR10e 750, UR5e·UR20 650, LR Mate·MZ07 550). 앱은 표만 쓴다(계획 비용 때문).
```

## 13단계 — 조정기·앱 통합
```
- CellCoordinator: robots Map, main.wantsPot, planning Set, sideInPot()(모드 2의 running/holding/planning),
  start(budget) / stop() / busy / tick(dt, env{ mainSegments, particles(), obstaclesWorld(), paused, onBlocked, onPlanFail }):
  실행 중이면 tick, 쉬면 (active·budget·모드 2면 !wantsPot·idle 대기 끝) planNext → started/blocked(1 s)/empty(3 s)/failed(3 s).
- main.js: 매 60 Hz 스텝 controller.tick 전에 tickSideRobots()(coord.tick + controller.ctx.others = 측면 캡슐),
  물리 moveExtraRobot, 화면 updateExtraRobot. syncSideRobots(설정·셀 활성·여유거리 키가 바뀌면 재설치 → drawCell → rebuildSafety → createWorld).
  skimOnce: 레인 = skimLanes(..., mainLaneRange), cell.corridor = 측면 로봇 있음, 모드 2가 있으면 wantsPot + 'until' 단계(runAction type 'until')
  + '스쿱 상승' 다음 단계부터 wantsPot=false. startSkim: coord.start(auto ? ∞ : 1), 자동 연속에서 empty면 측면 로봇이 있을 때도 5 s 대기 후 재시도.
  알람·Esc·로봇 변경 → coord.stop(). robotBusy에 coord.busy. 알람 이름 'robot:<slot>' → '<왼쪽/오른쪽> 측면 로봇 (모델)'.
- viewer: setExtraRobot/updateExtraRobot/removeExtraRobot/setExtraHighlight(toolGroup: 스키머·밀대), 받침대(노랑)·측면 박스 X 표시, L/R 라벨.
- 패널: 측면 로봇 영역 — 슬롯별 로봇 선택(없음 + 후보), 모드 선택, 상태(단계·대기 사유·작업 횟수·측면 박스 회수·레인 수·오류).
- state: cell.dross.sides 저장·검증(카탈로그에 있고 소형/협동만).
```

## 14단계 — 동시 실행 검증·문서
```
tests/cell-robots.mjs (run-all --full): UR 3종·후보 7종, 후보×슬롯×모드 설치·레인 표, SIDE_BIN_TABLE = 계산 결과,
시나리오 A(대형 단독) / B(모드 1: KR 210 + L UR10e + R IRB 1200) / C(모드 2: KR 210 + 양쪽 UR10e) 각 120 s —
main.js와 같은 순서(측면 tick → 대형 sweepCheck(others 포함) → 물리)로 실행, 비동기 계획이 끝나도록 매 스텝 setImmediate 양보.
기대: 안전 위반 0, 로봇 간 최소 거리 ≥ 20 mm, B 측면 박스 회수 각 ≥ 1·합계 > 단독, C 잠금 위반 0·측면 밀기 각 ≥ 1.
브라우저: UR 배너, 측면 로봇 선택·모드 전환, 1사이클·자동 연속, Esc, 콘솔 에러 0. 문서·Word(스크린샷) 갱신.
```
