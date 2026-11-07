# 실행 기록 (시간순, 도구가 자동 추가)

폴더 규칙은 `README.md`. 시각은 이 PC 시각(한국). 2026-11-06 이전 실행은 정리하면서 파일 시각으로 옮겨 적었다.

| 날짜 | 시각 | 종류 | 폴더 | 요약 |
|---|---|---|---|---|
| 2026-11-05 | 15:24 | episode | `2026-11-05/1524_episode_rule-kr210-mode1-s11` | 규칙 경로 10분 3D 재생 파일 (KR 210 + 측면 모드 1, 시드 11) |
| 2026-11-05 | 15:41 | baseline | `2026-11-05/1541_baseline_alone+mode1+mode2` | 규칙 경로 36회: KR 210 단독 61.3% · 모드 1 37.1% · 모드 2 53.3%, 80% 도달 0회 |
| 2026-11-05 | 15:52 | cem | `2026-11-05/1552_cem_kr210-alone-s11` | cem 75.0% vs 규칙 61.9% |
| 2026-11-05 | 16:02 | cem | `2026-11-05/1602_cem_kr210-alone-s12` | cem 75.6% vs 규칙 56.9% |
| 2026-11-05 | 16:09 | cem | `2026-11-05/1609_cem_kr210-mode1-s11` | cem 52.5% vs 규칙 38.8% |
| 2026-11-05 | 18:14 | ppo-train | `2026-11-05/1814_ppo-train_kr210-run1` | 최고 = 반복 40, 학습 평가 71.9% (모방 3 + PPO 40, 약 2시간) |
| 2026-11-06 | 08:36 | ppo-eval | `2026-11-06/0836_ppo-eval_kr210-run1-alone` | alone: PPO 65.6% vs 규칙 61.3% |
| 2026-11-06 | 08:42 | ppo-eval | `2026-11-06/0842_ppo-eval_kr210-run1-mode1` | mode1: PPO 34.6% vs 규칙 37.1% |
| 2026-11-06 | 09:36 | ppo-eval | `2026-11-06/0936_ppo-eval_kr210-run1-mode2` | mode2: PPO 56.7% vs 규칙 53.3% |
| 2026-11-06 | 09:52 | baseline | `2026-11-06/0952_baseline_kr210_push-test_lane-dir` | KR alone robot 61.3% · KR alone snout 51.5% · KR alone alternate 72.5% · KR mode2 robot 53.3% · KR mode2 snout 0.0% · KR mode2 alternate 48.1% · KR push robot 33.8% · KR push snout 15.8% · KR push alternate 36.1% ※ 모드 3 첫 설계(구역 분리 동시 작업) — 교착으로 폐기, 1022에서 다시 잼 |
| 2026-11-06 | 10:22 | baseline | `2026-11-06/1022_baseline_kr210_mode2-vs-push` | KR mode2 robot 53.3% · KR push robot 57.5% |
| 2026-11-06 | 10:22 | baseline | `2026-11-06/1022_baseline_kr210_alone_lane-dir` | KR alone robot 61.3% · KR alone snout 51.0% · KR alone alternate 72.9% |
| 2026-11-06 | 10:48 | cem | `2026-11-06/1048_cem_kr210-alone-s101` | cem 86.1% vs 규칙 71.5% (kr210-alone-s101) |
| 2026-11-06 | 10:53 | cem | `2026-11-06/1053_cem_kr210-alone-s102` | cem 88.7% vs 규칙 76.7% (kr210-alone-s102) |
| 2026-11-06 | 10:59 | cem | `2026-11-06/1059_cem_kr210-alone-s103` | cem 84.4% vs 규칙 76.9% (kr210-alone-s103) |
| 2026-11-06 | 11:08 | cem | `2026-11-06/1108_cem_kr210-alone-s104` | cem 83% vs 규칙 58.5% (kr210-alone-s104) |
| 2026-11-06 | 11:14 | cem | `2026-11-06/1114_cem_kr210-alone-s105` | cem 84.4% vs 규칙 73.1% (kr210-alone-s105) |
| 2026-11-06 | 11:21 | cem | `2026-11-06/1121_cem_kr210-alone-s106` | cem 84.9% vs 규칙 81.8% (kr210-alone-s106) |
| 2026-11-06 | 11:30 | cem | `2026-11-06/1130_cem_kr210-alone-s107` | cem 81.3% vs 규칙 56.3% (kr210-alone-s107) |
| 2026-11-06 | 11:35 | cem | `2026-11-06/1135_cem_kr210-alone-s108` | cem 88.1% vs 규칙 79.2% (kr210-alone-s108) |
| 2026-11-06 | 11:41 | cem | `2026-11-06/1141_cem_kr210-alone-s109` | cem 85% vs 규칙 56.9% (kr210-alone-s109) |
| 2026-11-06 | 11:48 | cem | `2026-11-06/1148_cem_kr210-alone-s110` | cem 83% vs 규칙 73.6% (kr210-alone-s110) |
| 2026-11-06 | 12:51 | cem-demos | `2026-11-06/1251_cem-demos_kr210-alone10` | 시범 138개 · alone CEM 84.9% vs 규칙 70.5% (10개) |
| 2026-11-06 | 13:11 | ppo-train | `2026-11-06/1311_ppo-train_kr210-run2` | 최고 = 반복 5 학습 평가 71.3% · 셀 단독 PPO 71.5% vs 규칙 72.9% ※ PPO 10회까지만 학습(사용자 결정, 추가 학습 안 함). 채택 = 5회째 (NOTE.md) |
| 2026-11-06 | 13:42 | cem | `2026-11-06/1342_cem_kr210-alone-s11` | cem 80.6% vs 규칙 78.1% (kr210-alone-s11) |
| 2026-11-06 | 13:48 | cem | `2026-11-06/1348_cem_kr210-alone-s12` | cem 84.4% vs 규칙 66.3% (kr210-alone-s12) |
| 2026-11-06 | 13:54 | cem | `2026-11-06/1354_cem_kr210-alone-s13` | cem 86.9% vs 규칙 74.4% (kr210-alone-s13) |
| 2026-11-06 | 13:11 | pipeline | `2026-11-06/1311_pipeline_kr210-run2` | PPO 71.5% · 진화 탐색 84.0% · 규칙(alternate) 72.9% (시드 11·12·13, 교사 시범 138개) ※ PPO 10회까지만 학습(사용자 결정, 추가 학습 안 함). 채택 = 5회째 (NOTE.md) |
| 2026-11-07 | 09:47 | ppo-train | `2026-11-07/0947_ppo-train_kr210-run3` | 최고 = 반복 30 학습 평가 76.0% · 셀 단독 PPO 68.6% vs 규칙 72.9% ※ 2차 PPO 40회(사용자 요청, 작업자 6). best(30회째) 실제 셀 68.6% → 채택 안 함. 40회째(policy-last.json) 74.2% → **채택**(사용자 결정, NOTE.md) |
| 2026-11-07 | 09:47 | pipeline | `2026-11-07/0947_pipeline_kr210-run3` | PPO 68.6% · 진화 탐색 — · 규칙(alternate) 72.9% (시드 11·12·13, 교사 시범 138개) ※ 2차 PPO 40회(사용자 요청, 작업자 6). 실제 셀은 run2(71.5%)보다 낮아 채택 안 함 (NOTE.md) |
| 2026-11-07 | 13:52 | ppo-eval | `2026-11-07/1352_ppo-eval_kr210-run3-alone` | alone: PPO 74.2% vs 규칙 72.9% (시드 11·12·13) ※ run3의 40회째(policy-last.json) 평가 → 2차 채택 모델(사용자 결정 2026-11-07, NOTE.md) |
