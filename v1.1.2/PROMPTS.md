# RoboSim Lite v1.1.2 — 단계별 개발 프롬프트 (관절 실시간 계측 · 데이터 추출 · 머신러닝 준비)

> 기준 문서: `PRD_v.1.1.2.md`. 이전 버전 프롬프트는 `../v1.1.1/PROMPTS.md`(드로스 셀·UR·측면 로봇), `../v1.1.1/DROSS_PATH.md`(드로스 셀 재구현 1~14단계).
> 원 요청(2026-11-05): "로봇이 운영될 때 각 축(J1~J6) angle 값이 실시간으로 — 버튼을 누르면 화면에, 안 누르면 안 나와도 됨. 각 축 전류값·velocity 값도 각각 버튼으로. 머신러닝 기반 데이터로 쓸 예정이니 시간대별·상황별 엑셀로 추출(추출 버튼). 의미 있는 머신러닝 결과를 위한 과정을 PRD부터 쓰고 아이디어를 줘"

| 단계 | 내용 | PRD | 결과 |
|---|---|---|---|
| 0 | 폴더 준비: 태그 `v1.1.1` 폴더를 `v1.1.2/`로 복사(영상·docs·v1.1.1 전용 문서 제외), 포트 8112 | — | 완료 |
| 1-A | 계측 모델 `telemetry.js` (각도·속도·가속도·토크·추정 전류, 부하·욕 저항) + 테스트 | FR-38 | 완료 |
| 1-B | 기록기 `TelemetryLog` + 엑셀 작성기 `xlsx.js` (시트 5개) + 테스트(openpyxl 확인) | FR-39·40 | 완료 |
| 1-C | 패널·오버레이(버튼 4개, 로봇 선택, 기록·추출), main.js 연결(60 Hz 갱신, 샘플 기록, 단계 라벨) | FR-37 | 완료 |
| 1-D | 브라우저 시나리오, 문서 | AC-36~41 | 완료 |
| 1-E | (2차 요청) 막대·시계열 그래프, 손목 정격 하한 | FR-41, AC-42 | 완료 |
| 4 | 릴리스 (태그 `v1.1.2`) | — | 완료 (2026-11-05) |
| 2 | 고장 주입 + Node 일괄 데이터 생성기 + CSV/Parquet | PRD 5.3 | v2 단계(머신러닝·AI 활용)로 이관 |
| 3 | 첫 머신러닝 실험(부하 가상 센서·단계 인식, Python) | PRD 5.4 | v2 단계(머신러닝·AI 활용)로 이관 |

## 공통 전제
- 규칙은 루트 `CLAUDE.md`, 진행 상황은 `HANDOFF.md`. 릴리스한 폴더(`v1.0.0`·`v1.1.0`·`v1.1.1`)와 태그는 수정하지 않는다.
- 전류·토크는 추정값임을 화면·파일에 명시한다. 의존성 추가 없음. 순수 계산 모듈은 DOM 비의존.
- 단계마다 `node tests/run-all.mjs`(빠른 10종), 큰 변경 뒤 `--full`(13종).

## 1-A — 계측 모델
```
js/telemetry.js에 JointTelemetry(robot, toolSpec, { seed, noise })를 만들어줘.
- 링크 캡슐 질량 = 1400 kg/m³ × π r²(L + 4r/3) (홈 자세에서 고정), COM = 캡슐 중점.
- statics(frames, loadKg, forceN, tcp): 축 i(frames[i]의 z)에 대해 τ_i = −z·Σ(r × F) (링크 중력 + 툴 끝 부하 + 외력), I_eff,i = Σ m·(축까지 거리²).
- 정격토크 = 대표 자세 5개의 정적 토크 최대 × 1.5 + I_eff,max × 6 rad/s², 최소 1. 정격전류 소형 4·중형 10·대형 25 A.
- update(q, frames, dt, { tcp, extraKg, immersed }): 속도 = 차분, 가속도 = 평활 속도(0.4) 미분 → 평활(0.3) → ±600 deg/s² 상한,
  τ = 정적 + I_eff·α + 정격 × (0.04 tanh(ω/0.02) + 0.03 ω) , 잠김이면 F = −450 N·s/m × 잠김 × v_TCP를 외력으로,
  전류 = 정격전류 × τ/정격토크 + 0.5% 잡음(시드 고정 정규 난수).
검증(tests/telemetry.mjs): 중력 토크 = 위치 에너지 수치 미분(전 모델·전 축), 정지 전류 < 정격, 가속 > 등속 토크, 부하↑ → J2·J3 전류↑, 욕 저항.
```

## 1-B — 기록·엑셀
```
- TelemetryLog({ hz, maxRows 300000 }): start/stop/due(simT)/push(simT, 상황)/event/sheets(meta).
  data 49열(ASCII: t_s, wall_time, robot, model, activity, phase, cycle, lane, alarm, q/qd/qdd/tau/i × 6, tcp xyz, tool, load_kg, scoop_dross, immersed, bath_dross, collected_own, collected_total),
  사이클이 바뀌면 요약(피크·RMS 전류, 에너지 Σ|τω|Δt, 최대 부하, 회수 증가, 결과), 단계 변화·알람 이벤트, columns(한국어 설명), meta.
- js/xlsx.js: buildXlsx(sheets) — [Content_Types], _rels, workbook(+rels), styles(첫 행 굵게, cellStyles Normal), 시트 XML(인라인 문자열, 첫 행 고정, 열 너비),
  ZIP 무압축 + CRC-32. 검증: 다시 풀어 CRC·행 수·한글 확인, Python openpyxl로 열기.
```

## 1-C — 화면 연결
```
- index.html: 3D 뷰 오버레이 div, 오른쪽 패널 섹션 '실시간 계측 · 데이터'. js/telemetry-panel.js: 버튼 4개(aria-pressed), 표시할 로봇, 샘플링, 기록 시작/정지, 엑셀 추출, 지우기, 상태.
- main.js: 로봇·툴이 바뀌면 JointTelemetry 새로(대형), 측면 로봇 설치 때 슬롯별 생성. 60 Hz 스텝마다 tickTelemetry(툴 부하: 파지 질량 + 스쿱 위 드로스(욕 밖일 때), 잠김 = 포트 안 TCP가 욕면 아래인 정도),
  tmLog.due면 로봇마다 push(activity·phase(runSteps 단계 이름)·cycle·lane·alarm…). 오버레이 10 Hz, 상태 1 Hz. 알람 발생·해제는 이벤트로.
- 추출: buildXlsx(tmLog.sheets(meta)) → Blob 다운로드 robosim-telemetry-YYYYMMDD-HHMMSS.xlsx.
```

## 1-D — 수정·검증
```
- 브라우저 시나리오: 버튼 전 오버레이 숨김, 각도 켜기·끄기, 조그 중 속도, 측면 로봇 목록, 기록 → 1사이클 → 정지 → 행·단계·사이클 확인, 추출 파일 openpyxl 확인, 알람·콘솔 에러 0.
```

## 1-E — 막대 · 시계열 그래프
```
각도·속도·토크도 전류처럼 시각화해줘.
- 오버레이 표: 각도 = 관절 범위 위치 막대(0° 세로선, 끝 5% 주황), 속도 = 최대 속도 대비, 토크 = 정격 대비(70/90% 색).
- '그래프' 버튼 + 구간(5·10·30 s): 3D 화면 아래쪽 canvas에 켠 항목마다 한 칸, J1~J6 색 선·범례, 자동 세로 범위(각도 외 0 대칭), 시간 격자.
  이력은 로봇마다 20 Hz × 30 s를 기록 여부와 관계없이 보관. 다크/라이트 테마.
- 덤프 자세에서 손목 전류가 튀면 손목 정격토크 하한(가반 + 툴 × 툴 끝 레버)을 둔다.
```

## 2 — (v2로 이관) 고장 주입 · 일괄 데이터 생성기
```
PRD_v.1.1.2.md 5.3을 구현해줘.
- 고장 주입: 축별 마찰 배수, 백래시(속도 부호 바뀔 때 지연), 전류 센서 잡음·드리프트, 툴 끝 추가 부하, 관절 속도 제한. 시작 시각·강도를 fault_type·fault_axis·fault_level 열로 기록.
- tools/generate-dataset.mjs(Node, 화면 없이): 시나리오 매트릭스(대형 로봇 × 측면 구성 × 시드 × 발생률 × 속도 × 고장) → 에피소드마다 CSV(또는 xlsx) + episodes.csv(메타).
  tests/cell-robots.mjs의 동시 실행 재현 루프와 telemetry.js를 재사용한다.
```

## 3 — (v2로 이관) 첫 머신러닝 실험
```
PRD 5.4 레시피대로 Python 노트북을 만들어줘(ml/ 폴더): 엑셀 여러 개 읽기 → 과제 A(load_kg 회귀, RandomForest, 시드 단위 분할, MAE·중요도) →
과제 B(1 s 창 특성 → phase 분류, LightGBM, 혼동 행렬). 결과와 한계를 ml/REPORT.md로.
```
