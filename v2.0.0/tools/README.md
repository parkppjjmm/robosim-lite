# tools/ — 헤드리스 데이터 생성 도구 (Node 18+)

> PRD_v.2.0.0.md FR-45·47·51, PROMPTS.md 5단계. 외부 npm 패키지 없이 Node 표준 라이브러리만 쓴다.

| 파일 | 상태 | 역할 |
|---|---|---|
| `scenario-space.json` | 초안 | 시나리오 변수·범위·분포(몬테카를로 공간). 1단계 배속 측정 후 범위 조정 |
| `generate.mjs` | 5단계 예정 | 시나리오 샘플링 → 에피소드 실행(`js/cell-sim.js`) → `out/<run>/`에 CSV.gz·manifest |
| `check-dataset.mjs` | 5단계 예정 | 샘플 간격·열·결측·라벨 분포 검사 |

## 출력 (예정, `out/`은 git 제외)
```
out/run-001/
├─ manifest.json      앱 버전·git 커밋·스키마(robosim-data/2)·시나리오 공간·판정 기준·시각
├─ episodes.csv       에피소드당 1행: 설정 + 요약(사이클·회수·흘림·이상·고장)
├─ samples/ep-00001.csv.gz
├─ events.csv         단계·알람·게이트 차단·고장 시작/끝
└─ errors.csv         실패 에피소드
```

## 실행 예 (5단계 이후)
```
node tools/generate.mjs --space tools/scenario-space.json --n 200 --seed 42 --method lhs --hz 20 --workers 4 --out out/run-001
node tools/check-dataset.mjs out/run-001
```
