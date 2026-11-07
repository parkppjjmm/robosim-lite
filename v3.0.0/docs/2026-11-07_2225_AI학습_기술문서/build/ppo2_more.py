# 개정 6판(2026-11-07 22:25) 6.6절 — 2차 PPO 추가 학습(run3·run4)과 채택 모델 변경. make_docx.py가 6.5절 다음에 exec로 읽는다.
# 읽는 결과(v3.0.0 기준): run3·run4 train-curve.json·cell-eval-alone.md, 40회째 평가 1352(시드 3개)·1534(시드 10개), results/adopted.json
R3 = 'results/2026-11-07/0947_ppo-train_kr210-run3'
R4 = 'results/2026-11-07/1800_ppo-train_kr210-run4'
E3_3 = 'results/2026-11-07/1352_ppo-eval_kr210-run3-alone/cell-eval-alone.md'
E3_10 = 'results/2026-11-07/1534_ppo-eval_kr210-run3-alone/cell-eval-alone.md'


def cell_rows(p):
    return [dict(seed=int(m.group(1)), ppo=float(m.group(2)), rule=float(m.group(3)))
            for m in re.finditer(r'^\| (\d+) \| \*\*([\d.]+)%\*\* \| ([\d.]+)% \|', read(p), re.M)]


def ev_curve(d):
    return [e for e in json.loads(read(f'{d}/train-curve.json')) if e['phase'] == 'eval']


R3_EV, R4_EV = ev_curve(R3), ev_curve(R4)
R3_BEST = cell_rows(f'{R3}/cell-eval-alone.md')     # 30회째 (policy-best), 시드 11·12·13
R3_L3, R3_L10 = cell_rows(E3_3), cell_rows(E3_10)    # 40회째 (policy-last = 채택)
R4_10 = cell_rows(f'{R4}/cell-eval-alone.md')        # run4 40회째, 시드 11~20
ADOPTED = json.loads(read('results/adopted.json'))['ppo2']['policy']
m_ = lambda rs, k: sum(r[k] for r in rs) / len(rs)
wins = lambda rs: sum(r['ppo'] > r['rule'] for r in rs)

H('6.6 2차 PPO 추가 학습과 채택 모델 변경 (2026-11-07, 6판)', 2)
P('2차 PPO는 11/06에 10회만 학습했다(6.4절). 11/07에 사용자 요청으로 두 번 더 학습하고, 평가를 시드 10개로 늘렸다. '
  '조건은 모두 같다: 시범 138개(1251_cem-demos_kr210-alone10), 모방 3회, PPO 40회, 반복당 에피소드 14, 행동 = 규칙 레인 기준 조정 10값, 관측 102. '
  '학습은 결정적이라, 같은 설정이면 run2와 run3은 10회째까지 소수점까지 같은 값이 나온다.', size=9.5)
T([['학습', '바꾼 것', '연습장 시험 (5회마다)', '실제 셀 결과', '채택'],
   ['run2 (11/06)', '— (10회)', '시드 11·12·13', f'5회째 {pct(m_(cell_rows("results/2026-11-06/1311_ppo-train_kr210-run2/cell-eval-alone.md"), "ppo"))} (시드 3개)', '11/07까지'],
   ['run3 (11/07)', '40회', '시드 11·12·13', f'30회째 {pct(m_(R3_BEST, "ppo"))} · 40회째 {pct(m_(R3_L3, "ppo"))} (시드 3개) / 40회째 {pct(m_(R3_L10, "ppo"))} (시드 10개)', '**40회째 채택**'],
   ['run4 (11/07)', '40회 + 학습 폭 줄임(학습률 3e-4 → 1e-4, 클립 0.2 → 0.1) + 연습장·평가 시드 10개', '시드 11~20', f'40회째 {pct(m_(R4_10, "ppo"))} (시드 10개)', '안 함']],
  widths=[2.2, 5.0, 2.6, 5.4, 1.8], font=8)

H('6.6.1 run3 — 40회 학습: 연습장 최고가 실제 셀 최고가 아니었다', 3)
IMGP('f26-ppo2-curves.png', '2차 PPO 연습장 시험 곡선 — run2(10회)·run3(40회)·run4(40회, 학습 폭 줄임, 시드 10개)')
rows = [['시점'] + ['모방 직후' if e['iter'] == 0 else str(e['iter']) for e in R3_EV], ['run3 (시드 3)'] + [f"{e['rate']:.1f}" for e in R3_EV], ['run4 (시드 10)'] + [f"{e['rate']:.1f}" for e in R4_EV]]
T(rows, font=7.5, bold_first_col=True)
B([('출렁임: ', f'run3 연습장 시험은 {min(e["rate"] for e in R3_EV):.1f}~{max(e["rate"] for e in R3_EV):.1f}%를 오갔다. 반복마다 정책이 크게 바뀌었다(KL 0.025~0.05, 클립 비율 26~35%).'),
   ('도구가 고른 "최고"(30회째): ', f'연습장 76.0% → 실제 셀 {pct(m_(R3_BEST, "ppo"))}. 시드 13에서 규칙보다 17.5%p 낮았다.'),
   ('마지막(40회째, policy-last.json): ', f'연습장 73.1% → 실제 셀 {pct(m_(R3_L3, "ppo"))} (시드 3개, 규칙 {pct(m_(R3_L3, "rule"))}). 2차 PPO 중 처음으로 규칙 평균을 넘었다.'),
   ('사용자 결정: ', f'채택 모델을 40회째로 바꿨다 → {ADOPTED}. 파일 이름이 policy-best가 아니다. 채택 경로는 results/adopted.json에 적고, train.bat 메뉴 3이 ★로 표시한다(11.7절).'),
   ('교훈: ', '연습장 시험(시드 3개, 스트로크 단위 환경)으로 고른 체크포인트가 실제 셀(60 Hz 셀 루프 + 실행기 보정)에서도 가장 좋다는 보장이 없다. 후보 체크포인트는 실제 셀에서 평가해 고른다.')])

H('6.6.2 시드 10개 재평가 — 시드 3개는 좋은 쪽으로 치우쳐 있었다', 3)
IMGP('f27-seeds10.png', '실제 셀 10분, 시드 11~20: 규칙 경로 · 채택 모델(run3 40회째) · run4')
rows = [['시드'] + [str(r['seed']) for r in R3_L10] + ['평균'],
        ['규칙 (번갈아)'] + [f"{r['rule']:.1f}" for r in R3_L10] + [pct(m_(R3_L10, 'rule'))],
        ['채택 (run3 40회째)'] + [f"{r['ppo']:.1f}" for r in R3_L10] + [f"**{pct(m_(R3_L10, 'ppo'))}**"],
        ['run4 40회째'] + [f"{r['ppo']:.1f}" for r in R4_10] + [pct(m_(R4_10, 'ppo'))]]
T(rows, font=7.5, bold_first_col=True)
d10 = [r['ppo'] - r['rule'] for r in R3_L10]
sd = (sum((x - sum(d10) / len(d10)) ** 2 for x in d10) / (len(d10) - 1)) ** 0.5
B([('시드: ', '원래 11·12·13에 14~20을 더했다. 학습에 쓴 배치와 겹치지 않는다(진화 탐색 시범 101~110, PPO 연습 경기 1000번부터).'),
   ('채택 모델: ', f'{pct(m_(R3_L10, "ppo"))} vs 규칙 {pct(m_(R3_L10, "rule"))} ({dp(m_(R3_L10, "ppo"), m_(R3_L10, "rule"))}), 이긴 시드 {wins(R3_L10)}/10. 시드 3개의 +1.2%p는 쉬운 배치 쪽으로 치우친 값이었다.'),
   ('통계: ', f'시드별 차이의 표준편차 약 {sd:.1f}%p → 평균의 표준오차 약 {sd / len(d10) ** 0.5:.1f}%p. −2.0%p는 확실한 차이가 아니다 → "규칙과 비슷한 수준"이 맞는 판단이다.'),
   ('크게 지는 배치: ', '시드 15·17·20처럼 규칙이 75~81%로 잘 되는 배치에서 PPO가 11~13%p 낮다. PPO 스트로크는 12회 안팎으로 규칙보다 적다(원인은 3D 재생으로 확인할 과제).')])

H('6.6.3 run4 — 학습 폭 줄이기 + 연습장 시험 시드 10개', 3)
B([('바꾼 것: ', '정책 학습률 3e-4 → 1e-4, 클립 범위 0.2 → 0.1(업데이트 반복 8회 그대로). 연습장 시험과 학습 직후 실제 셀 평가를 시드 11~20으로. 새 옵션 --pi-lr·--clip·--epochs(기본값 = run1~run3과 같음).'),
   ('흔들림: ', f'연습장 {R4_EV[0]["rate"]:.1f}% → {R4_EV[-1]["rate"]:.1f}%로 천천히 올랐다(25회째 한 번 51.4%). 반복당 KL 0.001~0.02로 run3보다 작다.'),
   ('결과: ', f'실제 셀 {pct(m_(R4_10, "ppo"))}(시드 10개), 이긴 시드 {wins(R4_10)}/10 → 채택 모델({pct(m_(R3_L10, "ppo"))})보다 낮아 채택하지 않았다.'),
   ('해석: ', '덜 흔들리지만 40회 안에 충분히 배우지 못했다(40회째에도 오르는 중). 크게 지는 시드(15·17·20)는 run3과 같다 — 학습 설정보다 정책이 이 배치를 다루는 방식의 문제일 수 있다.'),
   ('참고: ', f'모방 직후 연습장 성적이 시드 10개에서 {R4_EV[0]["rate"]:.1f}%, 시드 3개에서 61.9%다 → 시드 11·12·13이 쉬운 배치다.')])

H('6.6.4 이 PC에서 긴 학습을 돌리는 법 (2026-11-07)', 3)
B(['이 PC는 8코어·메모리 7.7 GB다. 작업자 14로는 메모리가 모자란다 → --workers 6 --episodes 14 (에피소드 수를 따로 정하면 학습 조건은 그대로, 시간만 늘어난다. 40회 약 3.5~4시간).',
   'Claude Code 백그라운드 실행은 메모리가 부족하면 중단된다(run3에서 두 번). 긴 학습은 cmd 창에서 직접 실행하거나, Claude가 별도 PowerShell 창으로 띄운다.',
   'train.bat 메뉴 1·2도 작업자 수 다음에 "반복당 에피소드 수"(기본 14)를 묻는다.'])

H('6.6.5 다음 후보', 3)
B(['크게 지는 시드(15·17·20)의 3D 재생으로 PPO가 놓치는 곳 확인 → 관측·보상 보완',
   'run4에서 이어서 학습(--resume policy-last.json, 같은 학습 폭) 또는 학습 폭 중간값(학습률 2e-4 · 클립 0.15)',
   '시범 늘리기(진화 탐색 시드 111~), 후보 체크포인트를 실제 셀 시드 10개로 평가해 고르기'])
