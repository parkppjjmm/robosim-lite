# 학습 파이프라인 결과 — 2026-11-07 09:47 (run3)

- 명령: `node tools/pipeline.mjs --demos results/2026-11-06/1251_cem-demos_kr210-alone10/demos.json --name run3 --iterations 40 --bc 3 --workers 6 --episodes 14 --rule-lane-dir alternate --no-cem-eval` · 소요 201분
- 교사(진화 탐색 시범): `results/2026-11-06/1251_cem-demos_kr210-alone10/demos.json` (138개)
- PPO 학습: `results/2026-11-07/0947_ppo-train_kr210-run3` — 최고 체크포인트 PPO 반복 30, 학습 평가 76.0%
- 정책 파일: `results/2026-11-07/0947_ppo-train_kr210-run3/policy-best.json` (앱 학습 패널 [정책 불러오기 (PPO)])
- 비교 규칙 경로: 쓸기 방향 `alternate`. 평가 시드 11·12·13 (학습·시범에 쓰지 않은 배치)

## 같은 시드 비교 — KR 210 단독, 10분

| 시드 | 규칙 경로 | 진화 탐색 (교사, 현장 불가) | PPO 정책 (현장용) |
|---|---|---|---|
| 11 | 78.1% | — | **79.4%** |
| 12 | 66.3% | — | **69.4%** |
| 13 | 74.4% | — | **56.9%** |
| 평균 | 72.9% | — | **68.6%** |

- 진화 탐색 행이 비어 있으면 --no-cem-eval로 건너뛴 것이다.
- 3D 재생: PPO·규칙 = `results/2026-11-07/0947_ppo-train_kr210-run3/ppo-alone-s<시드>.rsim.json.gz`·`rule-alone-s<시드>…`
