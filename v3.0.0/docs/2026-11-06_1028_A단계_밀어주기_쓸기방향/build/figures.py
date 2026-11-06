# [A] 단계 보고서 그림 (2026-11-06 10:28) — 측면 밀어 주기(모드 3)·대형 쓸기 방향
# 실행: python build/figures.py <v3.0.0 폴더> <그림 폴더>   (matplotlib)
import json, os, sys, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle, Polygon, Circle
import numpy as np

# 이 문서가 쓴 결과
SRC = {
    'alone': 'results/2026-11-06/1022_baseline_kr210_alone_lane-dir/data.json',
    'push': 'results/2026-11-06/1022_baseline_kr210_mode2-vs-push/data.json',
    'first': 'results/2026-11-06/0952_baseline_kr210_push-test_lane-dir/data.json',
}
ROOT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
C = dict(ink='#1F2933', sub='#52606D', line='#9AA5B1', blue='#2B6CB0', blueL='#DCEBFA', green='#2F855A', greenL='#DDF3E4',
         orange='#C05621', orangeL='#FDEBD8', purple='#6B46C1', purpleL='#ECE5FB', gray='#E4E7EB', grayD='#7B8794', red='#C53030', redL='#FBE0E0',
         teal='#2C7A7B', tealL='#D7F0EF', yellow='#B7791F', yellowL='#FBF1D5')
data = {k: json.load(open(f'{ROOT}/{v}', encoding='utf8')) for k, v in SRC.items()}


def runs(key, config, lane):
    return sorted([r for r in data[key]['results'] if r['config'] == config and r.get('laneDir', 'robot') == lane], key=lambda r: r['seed'])


def canvas(w, h):
    fig = plt.figure(figsize=(w, h), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, w * 10); ax.set_ylim(0, h * 10); ax.axis('off')
    return fig, ax


def box(ax, x, y, w, h, title, body=None, fc=C['blueL'], ec=C['blue'], tsize=9.5, bsize=7.6):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0,rounding_size=1.2', fc=fc, ec=ec, lw=1.4))
    if body:
        ax.text(x + w / 2, y + h - 1.5, title, ha='center', va='top', fontsize=tsize, weight='bold', color=C['ink'])
        ax.text(x + w / 2, y + h - 5.2, body, ha='center', va='top', fontsize=bsize, color=C['sub'], linespacing=1.45)
    else:
        ax.text(x + w / 2, y + h / 2, title, ha='center', va='center', fontsize=tsize, weight='bold', color=C['ink'], linespacing=1.35)


def arrow(ax, x0, y0, x1, y1, color=None, text=None, toff=(0, 1)):
    ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle='-|>', mutation_scale=12, color=color or C['ink'], lw=1.5))
    if text: ax.text((x0 + x1) / 2 + toff[0], (y0 + y1) / 2 + toff[1], text, ha='center', fontsize=7.3, color=C['sub'])


def save(fig, name):
    fig.savefig(f'{OUT}/{name}.png', dpi=200, facecolor='white'); plt.close(fig); print('  ', name)


# 1. 실험 설계
def fig_design():
    fig, ax = canvas(10, 2.9)
    ax.text(50, 26.5, '[A] 단계 실험: 규칙 경로만 (학습 없음), KR 210, 10분, 드로스 160개, 시드 11·12·13', ha='center', fontsize=10, weight='bold', color=C['ink'])
    box(ax, 2, 2, 30, 21, '① 대형 쓸기 방향', 'robot: 스나우트 → 로봇 쪽 (열린 면이 로봇을 봄, 기존)\nsnout: 로봇 → 스나우트 쪽 (열린 면이 스나우트를 봄)\n        들어 올린 뒤 물러나 천천히 돌려 운반\nalternate: 사이클마다 번갈아', fc=C['blueL'], ec=C['blue'])
    box(ax, 35, 2, 30, 21, '② 측면 로봇 역할', 'alone: 측면 없음\nmode2: 밀기 + 포트 점유 잠금 (기존 v1.1.1)\npush (모드 3): 밀기만, 대형이 포트 밖에\n  있고 돌아오기 전에 끝낼 수 있을 때만\n  (대형만 회수)', fc=C['purpleL'], ec=C['purple'])
    box(ax, 68, 2, 30, 21, '③ 비교 지표', '10분 회수율 (셀 합계, 개수 기준)\n대형 사이클 수 · 흘림 수\n대형 로봇이 막힌 횟수(안전 게이트)\n\n결과 폴더: results/2026-11-06/\n1022_baseline_kr210_*', fc=C['greenL'], ec=C['green'])
    save(fig, 'a01-design')


# 2. 결과 막대
def fig_results():
    fig, axs = plt.subplots(1, 2, figsize=(10, 3.8), dpi=200, gridspec_kw=dict(width_ratios=[3, 2]))
    groups = [('robot', '로봇 쪽\n(기존)', C['grayD']), ('snout', '스나우트 쪽만', C['orange']), ('alternate', '번갈아', C['blue'])]
    ax = axs[0]; w = 0.26
    for k, (lane, lab, col) in enumerate(groups):
        rs = runs('alone', 'alone', lane)
        vals = [r['summary']['rateCount'] for r in rs]
        ax.bar(np.arange(3) + (k - 1) * w, vals, w, color=col, label=f"{lab.replace(chr(10), ' ')} 평균 {np.mean(vals):.1f}%")
        for i, v in enumerate(vals): ax.text(i + (k - 1) * w, v + 1, f'{v:.1f}', ha='center', fontsize=6.6)
    ax.axhline(80, color=C['red'], ls='--', lw=1); ax.text(-0.45, 81, '목표 80%', fontsize=7, color=C['red'])
    ax.set_xticks(range(3)); ax.set_xticklabels(['시드 11', '시드 12', '시드 13'], fontsize=8); ax.set_ylim(0, 92)
    ax.set_ylabel('10분 회수율 (%)', fontsize=8); ax.tick_params(labelsize=7); ax.grid(axis='y', alpha=0.3)
    ax.legend(fontsize=7, loc='upper center', bbox_to_anchor=(0.5, -0.1), ncol=3, frameon=False); ax.set_title('대형 단독: 쓸기 방향', fontsize=9)
    ax = axs[1]
    items = [('대형 단독\n(기준)', runs('alone', 'alone', 'robot'), C['grayD']), ('모드 2\n잠금 밀기', runs('push', 'mode2', 'robot'), C['purple']), ('모드 3\n타이밍 밀기', runs('push', 'push', 'robot'), C['teal'])]
    for i, (lab, rs, col) in enumerate(items):
        v = np.mean([r['summary']['rateCount'] for r in rs]); cyc = np.mean([r['summary']['mainCycles'] for r in rs])
        ax.bar(i, v, 0.55, color=col); ax.text(i, v + 1, f'{v:.1f}%\n(사이클 {cyc:.1f})', ha='center', fontsize=7)
    ax.axhline(80, color=C['red'], ls='--', lw=1)
    ax.set_xticks(range(3)); ax.set_xticklabels([x[0] for x in items], fontsize=7.5); ax.set_ylim(0, 92); ax.tick_params(labelsize=7); ax.grid(axis='y', alpha=0.3)
    ax.set_title('측면 2대 역할 (쓸기 방향 = 기존)', fontsize=9)
    fig.tight_layout(); save(fig, 'a02-results')


# 3. 스나우트 쪽 쓸기 동작 순서
def fig_snout():
    fig = plt.figure(figsize=(10, 4.6), dpi=200)
    ax = fig.add_axes([0.02, 0.05, 0.6, 0.88]); ax.set_aspect('equal'); ax.axis('off')
    ax.add_patch(Rectangle((1100, -900), 1200, 1800, fc='#F5F7FA', ec=C['ink']))
    ax.add_patch(Rectangle((2300, -900), 150, 1800, fc='#52606D'))
    ax.text(2375, 0, '스\n나\n우\n트', color='white', ha='center', va='center', fontsize=8, weight='bold')
    y = 300
    W = dict(fc='white', ec='none', alpha=0.9, pad=1)

    def scoop(cx, cy, deg, col, alpha=1):
        d = math.radians(deg); u = np.array([math.cos(d), math.sin(d)]); v = np.array([-u[1], u[0]]); a = 110; c = np.array([cx, cy])
        cs = [c + a * (u + v), c + a * (-u + v), c + a * (-u - v), c + a * (u - v)]
        ax.add_patch(Polygon(cs, closed=True, fc=col + '30', ec=col, lw=1.1, alpha=alpha))
        ax.plot([cs[0][0], cs[3][0]], [cs[0][1], cs[3][1]], color='white', lw=3); ax.plot([cs[0][0], cs[3][0]], [cs[0][1], cs[3][1]], color=col, lw=1.2, ls=(0, (2, 2)))
    scoop(1330, y, 0, C['blue']); ax.annotate('', xy=(2050, y), xytext=(1460, y), arrowprops=dict(arrowstyle='-|>', lw=2, color=C['blue']))
    ax.text(1700, y + 150, '① 스윕: 로봇 쪽 → 스나우트 쪽\n열린 면이 스나우트를 봄', ha='center', fontsize=7.5, color=C['blue'], bbox=W)
    scoop(2070, y, 0, C['orange'])
    ax.text(2070, y - 260, '② 들어 올림\n+ 뒤로 12° 기울임', ha='center', fontsize=7.3, color=C['orange'], bbox=W)
    ax.annotate('', xy=(1650, -180), xytext=(2030, y - 120), arrowprops=dict(arrowstyle='-|>', lw=1.4, color=C['purple'], ls='--'))
    for k, dg in enumerate([0, -60, -120, -180]):
        scoop(1620, -300, dg, C['purple'], alpha=0.35 + 0.2 * k)
    ax.text(1960, -470, '③ 담은 채 450 mm\n물러나기 (|Y| ≤ 400)\n④ 30°/s로 천천히\n180° 돌리기 (J6)', ha='center', fontsize=7.3, color=C['purple'], bbox=W)
    ax.annotate('', xy=(1150, -820), xytext=(1500, -420), arrowprops=dict(arrowstyle='-|>', lw=1.4, color=C['green']))
    ax.text(1180, -880, '⑤ 박스로 운반 → 덤프\n(기존과 같음)', fontsize=7.3, color=C['green'], bbox=W)
    ax.set_xlim(1050, 2500); ax.set_ylim(-950, 900)
    ax2 = fig.add_axes([0.64, 0.05, 0.35, 0.88]); ax2.axis('off')
    txt = ('왜 이렇게 했나\n\n'
           '• 열린 면이 스나우트를 보게 쓸면\n  스나우트 앞까지 밀어 담는다(사용자 제안).\n\n'
           '• 그대로 박스로 옮기면 손목이 크게 돌며\n  드로스가 튕겨 나갔다(2사이클에 26~33개).\n\n'
           '• 스나우트 옆은 높아(1200 mm) 제자리에서\n  못 돌린다 → 물러난 뒤 돌린다.\n\n'
           '• 102°/s로 돌리면 튕김 → 30°/s.\n\n'
           '• 같은 쪽으로만 돌면 J6가 감겨 관절 한계\n  → 두 방향 중 덜 감기는 쪽.\n\n'
           '• 튕김의 마지막 원인은 물리 엔진의\n  쿼터니언 부호 버그였다(4장).')
    ax2.text(0, 1, txt, va='top', fontsize=7.8, color=C['ink'], linespacing=1.35)
    save(fig, 'a03-snout-stroke')


# 4. 모드 2 vs 모드 3 시간표
def fig_timing():
    fig, ax = canvas(10, 4.6)
    ax.text(50, 43.5, '측면 로봇 밀기 시점: 모드 2(잠금) vs 모드 3(타이밍)', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    T0, T1, X0, X1 = 0, 60, 14, 96
    tx = lambda t: X0 + (X1 - X0) * t / (T1 - T0)

    def lane(y, label, segs):
        ax.text(X0 - 1, y + 1.5, label, ha='right', va='center', fontsize=8, color=C['ink'])
        ax.plot([X0, X1], [y + 1.5, y + 1.5], color=C['line'], lw=0.6, zorder=0)
        for a, b, col, t in segs:
            ax.add_patch(Rectangle((tx(a), y), tx(b) - tx(a), 3, fc=col, ec='white', lw=0.5, zorder=2))
            if t: ax.text((tx(a) + tx(b)) / 2, y + 1.5, t, ha='center', va='center', zorder=3, fontsize=6.5, color='white' if col not in (C['yellowL'],) else C['ink'])
    # 모드 2
    ax.text(2, 34, '모드 2', fontsize=9, weight='bold', color=C['purple'])
    lane(30, '대형', [(0, 9, C['blue'], '포트 안'), (9, 30, C['grayD'], '운반·덤프·복귀'), (30, 36, C['yellowL'], '기다림'), (36, 45, C['blue'], '포트 안'), (45, 60, C['grayD'], '운반·덤프')])
    lane(25, '측면', [(14, 36, C['purple'], '밀기 (늦게 끝남)')])
    # 모드 3
    ax.text(2, 18, '모드 3', fontsize=9, weight='bold', color=C['teal'])
    lane(14, '대형', [(0, 9, C['blue'], '포트 안'), (9, 30, C['grayD'], '운반·덤프·복귀'), (30, 39, C['blue'], '포트 안'), (39, 60, C['grayD'], '운반·덤프·복귀')])
    lane(9, '측면', [(10, 26, C['teal'], '밀기 (복귀 전 끝)'), (40, 55, C['teal'], '밀기')])
    for t in range(0, 61, 10):
        ax.text(tx(t), 5.5, f'{t} s', ha='center', fontsize=6.5, color=C['sub'])
    ax.text(50, 1.5, '모드 3: 대형이 들어 올린 뒤 "다음 사이클까지 남은 시간(etaS)"을 알려 주고, 측면은 계획한 밀기 시간 + 1.5 s ≤ etaS 일 때만 시작한다 (6 s 미만이면 시작 안 함). 그림은 개념도.', ha='center', fontsize=7.2, color=C['sub'])
    save(fig, 'a04-timing')


# 5. 쿼터니언 버그
def fig_quat():
    fig, ax = canvas(10, 3.0)
    ax.text(50, 27, '물리 엔진 회전 부호 버그 (모든 운동학 바디, 2026-11-06 수정)', ha='center', fontsize=10, weight='bold', color=C['ink'])
    box(ax, 2, 4, 28, 18, '스텝 k: 자세 q', '회전 행렬 → 쿼터니언\n(w, x, y, z)', fc=C['gray'], ec=C['grayD'])
    box(ax, 36, 4, 28, 18, '스텝 k+1: 거의 같은 자세', '변환 분기가 바뀌어 −q 로 나옴\n(q와 −q는 같은 자세)', fc=C['yellowL'], ec=C['yellow'])
    box(ax, 70, 4, 28, 18, '수정 전: Rapier', '한 스텝(1/60 s)에 360° 돈 것으로 계산\n→ 스쿱이 순간 고속 회전\n→ 담은 드로스가 튕겨 나감', fc=C['redL'], ec=C['red'])
    arrow(ax, 30, 13, 36, 13); arrow(ax, 64, 13, 70, 13)
    ax.text(50, 0.8, '수정: 직전 회전과 내적이 음수면 부호를 뒤집어 넘김 (physics.js continuousRot). 기존 로봇 쪽 쓸기 결과는 그대로(61.3%).', ha='center', fontsize=7.6, color=C['green'])
    save(fig, 'a05-quat')


for f in [fig_design, fig_results, fig_snout, fig_timing, fig_quat]:
    f()
print('ok')
