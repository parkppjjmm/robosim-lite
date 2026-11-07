# RoboSim Lite v3.0.0 AI 학습 기술 문서 개정 6판(2026-11-07 22:25) — 6판에서 더한 그림 f26·f27 (matplotlib)
# 실행: python build/figures6.py <v3.0.0 폴더> <그림 출력 폴더>   (나머지 그림 f01~f25는 figures.py, 스크린샷 s01~s11은 capture/)
# 읽는 결과: run3·run4 train-curve.json, 시드 10개 평가 cell-eval-alone.md
import json, re, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT, OUT = sys.argv[1], sys.argv[2]
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
C = dict(ink='#1F2933', sub='#52606D', blue='#2B6CB0', green='#2F855A', orange='#C05621', purple='#6B46C1', gray='#7B8794', red='#C53030')
RUN2 = 'results/2026-11-06/1311_ppo-train_kr210-run2'
RUN3 = 'results/2026-11-07/0947_ppo-train_kr210-run3'
RUN4 = 'results/2026-11-07/1800_ppo-train_kr210-run4'
EVAL10_RUN3 = 'results/2026-11-07/1534_ppo-eval_kr210-run3-alone/cell-eval-alone.md'
EVAL10_RUN4 = f'{RUN4}/cell-eval-alone.md'


def curve(d):
    return [e for e in json.load(open(f'{ROOT}/{d}/train-curve.json', encoding='utf8')) if e['phase'] == 'eval']


def cell(p):
    t = open(f'{ROOT}/{p}', encoding='utf8').read()
    return [(int(m.group(1)), float(m.group(2)), float(m.group(3))) for m in re.finditer(r'^\| (\d+) \| \*\*([\d.]+)%\*\* \| ([\d.]+)% \|', t, re.M)]


def save(fig, name):
    fig.savefig(f'{OUT}/{name}.png', dpi=200, facecolor='white'); plt.close(fig); print('  ', name)


# f26: 연습장 시험 곡선 — run2(10회, 시드 3) · run3(40회, 시드 3) · run4(40회, 시드 10, 학습 폭 줄임)
fig, ax = plt.subplots(figsize=(8.6, 4.2), dpi=200)
for d, lab, col, mk in [(RUN2, 'run2 — 10회 · 시드 3개 (10회까지 run3과 같은 값, 겹쳐 보임)', C['gray'], 's'), (RUN3, 'run3 — 40회 · 시드 3개 · 학습률 3e-4 · 클립 0.2', C['orange'], 'o'), (RUN4, 'run4 — 40회 · 시드 10개 · 학습률 1e-4 · 클립 0.1', C['blue'], 'D')]:
    ev = curve(d)
    ax.plot([e['iter'] for e in ev], [e['rate'] for e in ev], marker=mk, color=col, lw=2, ms=5, label=lab)
r3 = {e['iter']: e['rate'] for e in curve(RUN3)}
ax.annotate('30회째 76.0%\n(연습장 최고 → 실제 셀 68.6%)', (30, r3[30]), (16.5, 79), fontsize=8, color=C['orange'], arrowprops=dict(arrowstyle='->', color=C['orange']))
ax.annotate('40회째 73.1%\n(채택 → 실제 셀 74.2% / 시드 10개 72.5%)', (40, r3[40]), (24.5, 85.5), fontsize=8, color=C['red'], arrowprops=dict(arrowstyle='->', color=C['red']))
ax.set_xlabel('PPO 반복 (0 = 모방 직후)'); ax.set_ylabel('연습장 시험 회수율 (%)'); ax.set_ylim(40, 90); ax.set_xticks(range(0, 41, 5))
ax.grid(alpha=0.3); ax.legend(fontsize=8, loc='lower right')
ax.set_title('2차 PPO 연습장 시험 (5회마다, 결정적 행동) — run3은 크게 출렁이고 run4는 천천히 오른다', fontsize=9.5, color=C['ink'])
fig.tight_layout(); save(fig, 'f26-ppo2-curves')

# f27: 시드 10개 실제 셀 — 규칙 · 채택 모델(run3 40회째) · run4
a, b = cell(EVAL10_RUN3), cell(EVAL10_RUN4)
seeds = [s for s, _, _ in a]
rule = [r for _, _, r in a]; p3 = [p for _, p, _ in a]; p4 = [dict((s, p) for s, p, _ in b)[s] for s in seeds]
x = np.arange(len(seeds) + 1); w = 0.27
mean = lambda v: sum(v) / len(v)
fig, ax = plt.subplots(figsize=(9.2, 4.2), dpi=200)
for k, (vals, lab, col) in enumerate([(rule, '규칙 경로 (번갈아)', C['gray']), (p3, '채택: run3 40회째', C['red']), (p4, 'run4 40회째', C['blue'])]):
    v = vals + [mean(vals)]
    bars = ax.bar(x + (k - 1) * w, v, w, color=col, label=f'{lab} — 평균 {mean(vals):.1f}%', alpha=0.9 if k else 0.55)
ax.set_xticks(x); ax.set_xticklabels([str(s) for s in seeds] + ['평균']); ax.set_xlabel('평가 시드 (드로스 배치)')
ax.set_ylabel('10분 회수율 (%)'); ax.set_ylim(40, 97); ax.axhline(80, color=C['green'], ls='--', lw=1); ax.text(len(seeds) + 0.45, 80.6, '목표 80%', fontsize=7.5, color=C['green'], ha='right')
ax.axvline(len(seeds) - 0.5, color='#CBD2D9', lw=1)
ax.grid(axis='y', alpha=0.3); ax.legend(fontsize=8, loc='upper left', ncol=3)
ax.set_title('실제 셀 10분 과제, 시드 11~20 (KR 210 단독) — 같은 배치에서 세 가지 비교', fontsize=9.5, color=C['ink'])
fig.tight_layout(); save(fig, 'f27-seeds10.png'.replace('.png', ''))
