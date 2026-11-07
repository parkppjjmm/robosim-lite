# 분석 그림 (2026-11-07): 왼쪽 = 시드별 PPO 스나우트 쪽 사이클 비율 vs PPO−규칙, 가운데·오른쪽 = 시드 17 끝날 때 남은 드로스(위에서 본 작업 영역)
# 실행: python figure.py (이 폴더에서, matplotlib 필요) → analysis.png
import json, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']; plt.rcParams['axes.unicode_minus'] = False
here = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(f'{here}/data.json', encoding='utf8'))
S, W, B = d['seeds'], d['work'], d['band']
fig, ax = plt.subplots(1, 3, figsize=(13, 4.3), dpi=170, gridspec_kw=dict(width_ratios=[1.15, 1, 1]))
for s, v in S.items():
    x = 100 * v['ppo']['snoutCycles'] / v['ppo']['cycles']; y = v['ppo']['rate'] - v['rule']['rate']
    ax[0].scatter(x, y, s=60, color='#C53030' if y < 0 else '#2F855A'); ax[0].annotate(s, (x, y), (5, 4), textcoords='offset points', fontsize=8)
ax[0].axhline(0, color='#7B8794', lw=1); ax[0].set_xlabel('PPO가 고른 스나우트 쪽 쓸기 비율 (%)'); ax[0].set_ylabel('PPO − 규칙 (%p)')
ax[0].set_title('시드별: 스나우트 쪽을 많이 고를수록 진다 (상관 −0.88)', fontsize=9.5); ax[0].grid(alpha=0.3)
for a, k, nm in [(ax[1], 'rule', '규칙'), (ax[2], 'ppo', 'PPO')]:
    v = S['17'][k]
    a.add_patch(plt.Rectangle((W['x0'], W['y0']), W['x1'] - W['x0'], W['y1'] - W['y0'], fill=False, ec='#52606D'))
    a.add_patch(plt.Rectangle((W['x0'], W['y0']), B, W['y1'] - W['y0'], color='#DCEBFA', alpha=0.6))
    a.add_patch(plt.Rectangle((W['x1'] - B, W['y0']), B, W['y1'] - W['y0'], color='#FDEBD8', alpha=0.6))
    xs = [p[0] for p in v['leftXY']]; ys = [p[1] for p in v['leftXY']]
    a.scatter(xs, ys, s=18, color='#1F2933')
    a.set_xlim(W['x0'] - 60, W['x1'] + 60); a.set_ylim(W['y0'] - 60, W['y1'] + 60); a.set_aspect('equal')
    a.set_title(f'시드 17 {nm} {v["rate"]}% — 남은 {v["left"]}개, 스나우트 쪽 {v["snoutCycles"]}/{v["cycles"]} 사이클', fontsize=9)
    a.set_xlabel('x (mm) — 왼쪽 = 로봇 쪽 벽 띠(파랑), 오른쪽 = 스나우트 쪽 띠(주황)', fontsize=7.5)
fig.tight_layout(); fig.savefig(f'{here}/analysis.png', facecolor='white'); print('saved analysis.png')
