# RoboSim Lite v3.0.0 AI 학습 기술 문서 개정판(2026-11-06 11:15) — 도식 생성 (matplotlib). 이전 판: docs/2026-11-06_0845_AI학습_기술문서
# 실행: python docs/build/figures.py <v3.0.0 폴더> <그림 출력 폴더>
# 수치 그림(기준선·학습 곡선·결과 비교)은 results/ 파일에서 읽는다.
import json, os, re, sys, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle, Polygon, Circle, Wedge
import numpy as np

# 이 문서가 쓴 결과 (2026-11-06 날짜·시각별 폴더로 옮긴 경로)
EVAL = {'alone': 'results/2026-11-06/0836_ppo-eval_kr210-run1-alone/cell-eval-alone.md', 'mode1': 'results/2026-11-06/0842_ppo-eval_kr210-run1-mode1/cell-eval-mode1.md'}
CEM = {'kr210-alone-s11': 'results/2026-11-05/1552_cem_kr210-alone-s11/report.md', 'kr210-alone-s12': 'results/2026-11-05/1602_cem_kr210-alone-s12/report.md', 'kr210-mode1-s11': 'results/2026-11-05/1609_cem_kr210-mode1-s11/report.md'}
ROOT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']  # DejaVu = 맑은 고딕에 없는 − ⋮ 등 보충
plt.rcParams['axes.unicode_minus'] = False

C = dict(ink='#1F2933', sub='#52606D', line='#9AA5B1', blue='#2B6CB0', blueL='#DCEBFA', green='#2F855A', greenL='#DDF3E4',
         orange='#C05621', orangeL='#FDEBD8', purple='#6B46C1', purpleL='#ECE5FB', gray='#E4E7EB', grayD='#7B8794', red='#C53030', redL='#FBE0E0',
         teal='#2C7A7B', tealL='#D7F0EF', yellow='#B7791F', yellowL='#FBF1D5')


def canvas(w, h):
    fig = plt.figure(figsize=(w, h), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, w * 10); ax.set_ylim(0, h * 10); ax.axis('off')
    return fig, ax


def box(ax, x, y, w, h, title, body=None, fc=C['blueL'], ec=C['blue'], tsize=10, bsize=8, r=1.2, bold=True, align='center'):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f'round,pad=0,rounding_size={r}', fc=fc, ec=ec, lw=1.4))
    if body:
        ax.text(x + w / 2, y + h - 1.6, title, ha='center', va='top', fontsize=tsize, color=C['ink'], weight='bold' if bold else 'normal')
        ax.text(x + w / 2 if align == 'center' else x + 1.2, y + h - 1.6 - tsize * 0.33 - 1.2, body, ha=align, va='top', fontsize=bsize, color=C['sub'], linespacing=1.45)
    else:
        ax.text(x + w / 2, y + h / 2, title, ha='center', va='center', fontsize=tsize, color=C['ink'], weight='bold' if bold else 'normal', linespacing=1.35)


def arrow(ax, x0, y0, x1, y1, text=None, color=None, ls='-', lw=1.6, tsize=7.5, toff=(0, 1.2), rad=0.0, style='-|>'):
    color = color or C['grayD']
    ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle=style, mutation_scale=12, color=color, lw=lw, ls=ls,
                                 connectionstyle=f'arc3,rad={rad}', shrinkA=0, shrinkB=0))
    if text:
        ax.text((x0 + x1) / 2 + toff[0], (y0 + y1) / 2 + toff[1], text, ha='center', va='bottom', fontsize=tsize, color=C['sub'])


def save(fig, name):
    fig.savefig(f'{OUT}/{name}.png', dpi=200, facecolor='white')
    plt.close(fig)
    print('  ', name)


def read(p):
    return open(f'{ROOT}/{p}', encoding='utf8').read()


def eval_md(cfg):
    """cell-eval-<cfg>.md → [(seed, ppo, rule)]"""
    rows = []
    for m in re.finditer(r'^\| (\d+) \| \*\*([\d.]+)%\*\* \| ([\d.]+)% \|', read(EVAL[cfg]), re.M):
        rows.append((int(m.group(1)), float(m.group(2)), float(m.group(3))))
    return rows


def cem_md(name):
    s = read(CEM[name])
    m = re.search(r'회수율 \(개수 / 질량\) \| \*\*([\d.]+)%\*\* / [\d.]+% \| \*\*([\d.]+)%\*\*', s)
    return float(m.group(1)), float(m.group(2))


# ---------------------------------------------------------------- 1. 셀 평면도
def fig_cell():
    fig = plt.figure(figsize=(8.6, 5.2), dpi=200)
    ax = fig.add_axes([0.06, 0.08, 0.92, 0.86])
    ax.set_aspect('equal')
    # 포트 전체
    ax.add_patch(Rectangle((1000, -1000), 2800, 2000, fc='#CBD2D9', ec=C['ink'], lw=1.2))
    ax.add_patch(Rectangle((1100, -900), 2600, 1800, fc='#F5F7FA', ec=C['ink'], lw=0.8))
    ax.add_patch(Rectangle((1100, -900), 1200, 1800, fc=C['blueL'], ec=C['blue'], lw=1.6))
    ax.add_patch(Rectangle((2300, -900), 200, 1800, fc='#52606D', ec=C['ink'], lw=1))
    ax.add_patch(Rectangle((2500, -900), 1200, 1800, fc='#EEF0F2', ec=C['grayD'], lw=0.8, hatch='//'))
    ax.add_patch(Rectangle((1330, -670), 740, 1340, fc='none', ec=C['green'], lw=1.6, ls='--'))
    ax.add_patch(Rectangle((1330, -230 + 0), 740, 460, fc=C['orangeL'], ec=C['orange'], lw=1.2, ls=':', alpha=0.8))
    rng = np.random.default_rng(4)
    pts = np.c_[rng.uniform(1130, 2270, 160), rng.uniform(-870, 870, 160)]
    ax.scatter(pts[:, 0], pts[:, 1], s=7, c='#3E4C59', zorder=3)
    # 로봇·박스
    ax.add_patch(Circle((0, 0), 170, fc=C['orange'], ec=C['ink'], zorder=4))
    ax.text(0, -300, '대형 로봇\n(AI 학습 대상)', ha='center', va='top', fontsize=8, color=C['ink'])
    ax.add_patch(Rectangle((250, -1650), 700, 600, fc=C['redL'], ec=C['red'], lw=1.2))
    ax.text(600, -1350, '대형 드로스 박스', ha='center', va='center', fontsize=7.5)
    for y, lab in [(1250, '왼쪽 측면 로봇\n(기존 경로)'), (-1250, '오른쪽 측면 로봇\n(기존 경로)')]:
        ax.add_patch(Circle((1700, y + (120 if y > 0 else -120)), 110, fc=C['purple'], ec=C['ink'], zorder=4))
        ax.text(2000, y + (120 if y > 0 else -120), lab, ha='left', va='center', fontsize=7.5)
    ax.text(1700, 1030, '작업 영역 WORK_ZONE (회수율 기준)', ha='center', va='bottom', fontsize=8.5, color=C['blue'], weight='bold')
    ax.text(2400, 0, '스\n나\n우\n트', ha='center', va='center', fontsize=8, color='white', weight='bold')
    WB = dict(fc='white', ec='none', alpha=0.9, pad=1.5)
    ax.text(3100, 0, 'FAR_ZONE\n(스나우트 너머,\n회수율에서 제외)', ha='center', va='center', fontsize=8, color=C['sub'], bbox=WB)
    ax.text(3050, -1500, '초록 점선 = 스트로크 상자\n(스쿱 중심이 갈 수 있는 범위)\nX 1330~2070, Y ±670', ha='center', va='center', fontsize=7, color=C['green'])
    ax.text(1700, 0, '측면 로봇 모드 1일 때\n대형 구역 |Y| ≤ 230', ha='center', va='center', fontsize=7, color=C['orange'], bbox=WB, zorder=5)
    ax.set_xlim(-400, 3900); ax.set_ylim(-1800, 1700)
    ax.set_xlabel('X (mm) — 로봇 쪽 → 스나우트 쪽', fontsize=8); ax.set_ylabel('Y (mm)', fontsize=8)
    ax.tick_params(labelsize=7)
    save(fig, 'f01-cell')


# ---------------------------------------------------------------- 2. 전체 로드맵
def fig_roadmap():
    fig, ax = canvas(10, 4.6)
    steps = [
        ('0. 기준선', '규칙 경로(v1.1.2)만\n대형 4종 × 구성 3 × 시드 3\n= 36회 측정', '단독 약 61%\n3대 모드 1 약 37%', C['gray'], C['grayD']),
        ('1. 진화 탐색 (CEM)', '로봇이 쉴 때마다 후보\n스트로크 128개를 시뮬레이터로\n미리 시도 → 최선만 실행', 'KR 210 단독 75%\n(규칙 59%)', C['greenL'], C['green']),
        ('2. PPO 강화학습', '미리 연습한 신경망이\n드로스 분포만 보고\n바로 스트로크 결정', 'KR 210 단독 {ppo}\n(규칙 {rule})', C['blueL'], C['blue']),
        ('3. 현장 적용 준비', '상부 카메라 → 같은 격자\n→ 정책(ONNX) → 안전 필터\n→ 로봇 어댑터', 'H0 오프라인 재생\nH1 섀도 모드 …', C['purpleL'], C['purple']),
    ]
    a = eval_md('alone')
    ppo = sum(r[1] for r in a) / len(a); rule = sum(r[2] for r in a) / len(a)
    w, h, gap, y = 21.5, 30, 3.2, 9
    for i, (t, b, res, fc, ec) in enumerate(steps):
        x = 2 + i * (w + gap)
        box(ax, x, y, w, h, t, b, fc=fc, ec=ec, tsize=10.5, bsize=8.2)
        ax.add_patch(FancyBboxPatch((x + 1.5, y + 1.5), w - 3, 8.5, boxstyle='round,pad=0,rounding_size=0.8', fc='white', ec=ec, lw=1))
        ax.text(x + w / 2, y + 5.75, res.format(ppo=f'{ppo:.1f}%', rule=f'{rule:.1f}%'), ha='center', va='center', fontsize=8.2, color=ec, weight='bold')
        if i < 3:
            arrow(ax, x + w + 0.2, y + h / 2, x + w + gap - 0.2, y + h / 2, color=C['ink'])
    ax.text(50, 43, '진행 순서: 기준 측정 → 시뮬레이터 안 최적화 → 현장에서 쓸 수 있는 정책 → 하드웨어', ha='center', fontsize=9.5, color=C['ink'], weight='bold')
    ax.text(50, 3.5, '1·2단계 숫자: 10분 과제, 시드별 평균(1단계 시드 11·12, 2단계 시드 11·12·13). 3단계는 문서·인터페이스 준비 단계(실제 로봇 시범은 v3.1.0).', ha='center', fontsize=7.5, color=C['sub'])
    save(fig, 'f02-roadmap')


# ---------------------------------------------------------------- 3. A vs B
def fig_ab():
    fig, ax = canvas(10, 5.4)
    ax.text(25, 51, '개념 A — 순수 관절 직접', ha='center', fontsize=11, weight='bold', color=C['red'])
    ax.text(75, 51, '개념 B — 계층형 + 관절 직접 (지금 개발 중)', ha='center', fontsize=11, weight='bold', color=C['blue'])
    ax.plot([50, 50], [3, 49], color=C['line'], lw=1, ls='--')
    # A
    box(ax, 8, 38, 34, 8, '관측: 드로스 격자 + 관절 각도 J1~J6', fc=C['gray'], ec=C['grayD'], tsize=8.5)
    box(ax, 8, 24, 34, 9, '신경망 1개', '매 0.05 s마다 J1~J6 변화량(Δq)', fc=C['redL'], ec=C['red'], tsize=9.5, bsize=8)
    box(ax, 8, 11, 34, 8, '안전 게이트 → 물리 시뮬레이터', fc=C['gray'], ec=C['grayD'], tsize=8.5)
    arrow(ax, 25, 38, 25, 33.2); arrow(ax, 25, 24, 25, 19.2)
    ax.text(25, 3.5, '장점: 자유도가 가장 큼\n단점: 행동이 수천 번/에피소드 → 학습이 매우 느리고\n충돌·이상 자세가 많음, 현장 검증이 어려움', ha='center', fontsize=7.6, color=C['sub'], linespacing=1.4)
    # B
    box(ax, 58, 41, 34, 6, '관측: 드로스 격자 12×8 + 남은 비율 + 시간', fc=C['gray'], ec=C['grayD'], tsize=8.3)
    box(ax, 58, 27, 34, 11.5, '상위: 정책 (신경망)', '스트로크 1번마다 9개 값을 고름\n(시작점·방향·길이·열린 면 J6·기울임 등)', fc=C['blueL'], ec=C['blue'], tsize=9.5, bsize=7.6)
    box(ax, 58, 14, 34, 10.5, '하위: 경로 계획 · IK · 안전 게이트', '스트로크를 J1~J6 관절 궤적으로 바꿈\n(충돌·특이점·도달거리 검사)', fc=C['tealL'], ec=C['teal'], tsize=9.5, bsize=7.6)
    box(ax, 58, 6.5, 34, 5.5, '물리 시뮬레이터 → 회수 결과 → 점수', fc=C['gray'], ec=C['grayD'], tsize=8.3)
    arrow(ax, 75, 41, 75, 38.6); arrow(ax, 75, 27, 75, 24.6); arrow(ax, 75, 14, 75, 12.1)
    ax.text(75, 2.3, '장점: 결정이 15번/10분 → 빠르게 학습, 안전 검사를 그대로 통과\nJ1~J6는 모두 움직이며, 열린 면 방향(J6)·기울임(J4·J5)이 행동에 들어 있음', ha='center', fontsize=7.6, color=C['sub'], linespacing=1.4)
    save(fig, 'f03-a-vs-b')


# ---------------------------------------------------------------- 4. B 상세 데이터 흐름
def fig_b_flow():
    fig, ax = canvas(10, 5.6)
    box(ax, 2, 40, 18, 12, '① 관측', '작업 영역 드로스를\n12×8 칸으로 셈\n+ 남은 비율 + 경과 시간\n= 숫자 98개', fc=C['gray'], ec=C['grayD'], bsize=7.5)
    box(ax, 26, 40, 20, 12, '② 정책 (PPO)', '신경망 98→64→64→9\n평균 μ와 표준편차 σ\n(학습 땐 무작위로 흔들어 시도)', fc=C['blueL'], ec=C['blue'], bsize=7.5)
    box(ax, 52, 40, 20, 12, '③ 스트로크 9변수', 'x0, y0, 방향, 길이,\n열린 면 시작·끝(J6),\n기울임, 깊이, 속도', fc=C['blueL'], ec=C['blue'], bsize=7.5)
    box(ax, 78, 40, 20, 12, '④ 실행기 안전장치', '구역 제한 · 길이 0 방지\n계획 실패 → 보정 2회\n→ 그래도 실패 → 규칙 레인', fc=C['yellowL'], ec=C['yellow'], bsize=7.5)
    box(ax, 78, 21, 20, 12, '⑤ 사이클 계획', 'planSkimCycle:\n진입 → 스윕(J6 회전) →\n들기 → 운반 → 덤프 → 복귀', fc=C['tealL'], ec=C['teal'], bsize=7.5)
    box(ax, 52, 21, 20, 12, '⑥ IK + 경로 계획', 'TCP 목표 → J1~J6\nRRT-Connect·Shortcut\n궤적 시간 맞춤', fc=C['tealL'], ec=C['teal'], bsize=7.5)
    box(ax, 26, 21, 20, 12, '⑦ 안전 게이트', '매 틱 적용 전 검사:\n자기 충돌·설비 충돌·\n다른 로봇·특이점', fc=C['redL'], ec=C['red'], bsize=7.5)
    box(ax, 2, 21, 18, 12, '⑧ 물리 (Rapier)', '60 Hz, 드로스 입자\n부력·마찰·스쿱 접촉\n→ 박스에 들어간 개수', fc=C['gray'], ec=C['grayD'], bsize=7.5)
    box(ax, 2, 3, 44, 11, '⑨ 점수(보상)\n회수 +10/개 · 벽 띠 +5 · 헛질 −20 · 흘림 −5/개\n1 s −0.2 · 계획 불가 −10 · 목표 도달 +200', fc=C['greenL'], ec=C['green'], tsize=8.2, bold=False)
    for (x0, y0, x1, y1) in [(20, 46, 26, 46), (46, 46, 52, 46), (72, 46, 78, 46), (88, 40, 88, 33), (78, 27, 72, 27), (52, 27, 46, 27), (26, 27, 20, 27), (11, 21, 11, 14)]:
        arrow(ax, x0, y0, x1, y1, color=C['ink'])
    arrow(ax, 46, 8.5, 60, 8.5, color=C['green'])
    box(ax, 60, 3, 38, 11, '학습: 점수가 높았던 행동이 더 자주 나오도록 ②의 가중치를 고침 (PPO)\n실행: 학습된 ②는 고정, ①→⑧만 반복', fc='white', ec=C['green'], tsize=7.8, bold=False)
    ax.text(50, 54.5, '계층형 B: 한 번의 결정(스트로크)이 실제 관절 움직임이 되기까지', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    ax.text(62, 36.5, '상위 = AI가 결정', fontsize=7.5, color=C['blue'], ha='center')
    ax.text(62, 17.5, '하위 = 기존 검증된 계획·안전 모듈', fontsize=7.5, color=C['teal'], ha='center')
    save(fig, 'f04-b-flow')


# ---------------------------------------------------------------- 5. 스트로크 9변수
def fig_stroke():
    fig = plt.figure(figsize=(10, 4.6), dpi=200)
    ax = fig.add_axes([0.03, 0.06, 0.55, 0.86]); ax.set_aspect('equal'); ax.axis('off')
    ax.add_patch(Rectangle((1100, -900), 1200, 1800, fc='#F5F7FA', ec=C['ink'], lw=1))
    ax.add_patch(Rectangle((2300, -900), 120, 1800, fc='#52606D'))
    ax.add_patch(Rectangle((1330, -670), 740, 1340, fc='none', ec=C['green'], lw=1.2, ls='--'))
    s = np.array([1950, 300]); h = math.radians(205); L = 650
    e = s + L * np.array([math.cos(h), math.sin(h)])
    W = dict(fc='white', ec='none', alpha=0.9, pad=1)

    def scoop(c, dirdeg, yawdeg, col):
        d = math.radians(dirdeg + yawdeg)
        u = np.array([math.cos(d), math.sin(d)]); v = np.array([-u[1], u[0]])
        a = 120
        corners = [c + a * (u + v), c + a * (-u + v), c + a * (-u - v), c + a * (u - v)]
        ax.add_patch(Polygon(corners, closed=True, fc=col + '33', ec=col, lw=1.2, zorder=2))
        ax.plot([corners[0][0], corners[3][0]], [corners[0][1], corners[3][1]], color='white', lw=3.2, zorder=3)
        ax.plot([corners[0][0], corners[3][0]], [corners[0][1], corners[3][1]], color=col, lw=1.4, ls=(0, (2, 2)), zorder=3)
        ax.annotate('', xy=c + 230 * u, xytext=c + 120 * u, arrowprops=dict(arrowstyle='-|>', color=col, lw=1.2), zorder=3)
        return c + 230 * u
    t0 = scoop(s, 205, -40, C['orange'])
    t1 = scoop(e, 205, 35, C['purple'])
    ax.annotate('', xy=e, xytext=s, arrowprops=dict(arrowstyle='-|>', lw=2.2, color=C['blue'], mutation_scale=16), zorder=4)
    ax.plot(*s, 'o', color=C['blue'], ms=6, zorder=5)
    ax.plot([s[0], s[0] + 300], [s[1], s[1]], color=C['grayD'], lw=0.8, ls=':')
    ax.add_patch(Wedge(tuple(s), 300, 0, 205, fc='none', ec=C['blue'], lw=0.8, ls='--'))
    ax.annotate('①② 시작점 (x0, y0)', xy=s, xytext=(1980, -120), fontsize=8, color=C['blue'], bbox=W, arrowprops=dict(arrowstyle='-', color=C['blue'], lw=0.7))
    ax.text(2050, 650, '③ 방향 205°\n(0° = 스나우트 쪽)', fontsize=7.5, color=C['blue'], bbox=W, ha='center')
    mid = (s + e) / 2
    ax.text(mid[0] + 60, mid[1] - 170, '④ 길이', fontsize=8, color=C['blue'], bbox=W, ha='center')
    ax.annotate('⑤ 열린 면 시작 −40°', xy=t0, xytext=(1350, 760), fontsize=7.5, color=C['orange'], bbox=W, arrowprops=dict(arrowstyle='-', color=C['orange'], lw=0.7))
    ax.annotate('⑥ 열린 면 끝 +35°', xy=t1, xytext=(1150, -620), fontsize=7.5, color=C['purple'], bbox=W, arrowprops=dict(arrowstyle='-', color=C['purple'], lw=0.7))
    fig.text(0.30, 0.015, '평면도(위에서 본 모습). 사각형 = 스쿱, 점선 변 = 열린 면, 짧은 화살표 = 열린 면이 향하는 쪽', ha='center', fontsize=7.3, color=C['sub'])
    ax.set_xlim(1050, 2500); ax.set_ylim(-950, 950)
    ax2 = fig.add_axes([0.60, 0.06, 0.39, 0.86]); ax2.axis('off')
    rows = [('①', '시작 X', '1330 ~ 2070 mm'), ('②', '시작 Y', '−670 ~ +670 mm'), ('③', '쓸어 가는 방향', '0 ~ 360°'), ('④', '스윕 길이', '250 ~ 1100 mm'),
            ('⑤', '열린 면 방향 — 시작 (J6)', '−180 ~ +180°'), ('⑥', '열린 면 방향 — 끝 (J6)', '−180 ~ +180°'), ('⑦', '스윕 중 기울임 (J4·J5)', '−15 ~ +15°'),
            ('⑧', '잠김 깊이', '20 ~ 75 mm'), ('⑨', '스윕 속도', '30 ~ 250 mm/s')]
    ax2.text(0, 0.98, '정책이 고르는 9개 값 (한 번의 스트로크)', fontsize=9.5, weight='bold', color=C['ink'], va='top')
    for i, (n, k, r) in enumerate(rows):
        y = 0.88 - i * 0.092
        ax2.add_patch(Rectangle((0, y - 0.07), 1, 0.085, fc=C['blueL'] if i % 2 == 0 else 'white', ec='none', transform=ax2.transAxes))
        ax2.text(0.02, y - 0.028, n, fontsize=8.5, va='center', color=C['blue'], weight='bold')
        ax2.text(0.09, y - 0.028, k, fontsize=8.2, va='center', color=C['ink'])
        ax2.text(0.98, y - 0.028, r, fontsize=8.2, va='center', ha='right', color=C['sub'])
    ax2.text(0, 0.02, '열린 면 방향은 "진행 방향 기준" 각도다. 0° = 열린 면이 진행 방향을 향함.\n시작→끝 값이 다르면 스윕하면서 J6가 돌아간다.', fontsize=7.3, color=C['sub'], va='bottom')
    save(fig, 'f05-stroke')


# ---------------------------------------------------------------- 6. CEM 루프
def fig_cem():
    fig, ax = canvas(10, 4.8)
    box(ax, 2, 30, 17, 13, '대형 로봇이 쉼\n(다음 스트로크 필요)', fc=C['gray'], ec=C['grayD'], tsize=8.8)
    box(ax, 25, 30, 20, 13, '후보 32개 뽑기', '1세대: 규칙 레인 + 절반은 그 근처\n+ 절반은 전체 무작위\n2세대~: 상위 후보 분포에서', fc=C['greenL'], ec=C['green'], bsize=7.2)
    box(ax, 51, 30, 21, 13, '후보마다 시뮬레이터로 시도', '지금 드로스를 복사한 물리 월드에서\n한 사이클 실행 → 점수\n(Worker 14개 병렬, 후보당 약 1.3 s)', fc=C['greenL'], ec=C['green'], bsize=7.2)
    box(ax, 78, 30, 20, 13, '상위 25% 선택', '평균·표준편차를 다시 계산\n→ 다음 세대 분포', fc=C['greenL'], ec=C['green'], bsize=7.2)
    for x0, x1 in [(19, 25), (45, 51), (72, 78)]:
        arrow(ax, x0, 36.5, x1, 36.5, color=C['ink'])
    arrow(ax, 88, 30, 35, 30, text='4세대 반복 (32 × 4 = 후보 128개 시도)', color=C['green'], rad=-0.35, toff=(0, -11))
    box(ax, 51, 3, 26, 11, '가장 점수가 높은 1개만\n실제 셀에서 실행', fc=C['blueL'], ec=C['blue'], tsize=9)
    arrow(ax, 88, 30, 72, 14, color=C['blue'])
    arrow(ax, 51, 8.5, 10, 30, color=C['grayD'], rad=-0.2, text='다음 결정', toff=(-12, -4))
    ax.text(50, 45.5, '1단계 진화 탐색(CEM): 매 결정마다 "미리 해 보고" 최선을 고른다', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    ax.text(84, 8.5, '장점: 학습 없이 바로 높은 점수\n단점: 결정마다 시뮬레이터 128회\n→ 현장에서는 쓸 수 없음', fontsize=7.4, color=C['sub'], va='center')
    save(fig, 'f06-cem')


# ---------------------------------------------------------------- 7. 신경망
def fig_net():
    fig, ax = canvas(10, 4.6)
    layers = [(10, 98, '입력 98\n(격자 96 + 2)'), (35, 64, '은닉층 1\n64 (tanh)'), (58, 64, '은닉층 2\n64 (tanh)'), (82, 9, '출력 9\n평균 μ (sigmoid)')]
    pos = []
    for x, n, lab in layers:
        k = min(n, 12); ys = np.linspace(10, 38, k)
        pos.append((x, ys))
        for i, y in enumerate(ys):
            ax.add_patch(Circle((x, y), 0.9, fc=C['blueL'] if x < 80 else C['orangeL'], ec=C['blue'] if x < 80 else C['orange'], lw=0.8, zorder=3))
        if n > 12:
            ax.text(x, 24, '⋮', ha='center', va='center', fontsize=12, color=C['sub'], zorder=4, bbox=dict(fc='white', ec='none', pad=0))
        ax.text(x, 5, lab, ha='center', va='top', fontsize=8, color=C['ink'])
    for (x0, y0s), (x1, y1s) in zip(pos[:-1], pos[1:]):
        for a in y0s[::2]:
            for b in y1s[::2]:
                ax.plot([x0 + 0.9, x1 - 0.9], [a, b], color=C['line'], lw=0.25, zorder=1)
    ax.text(93, 24, '+ σ (표준편차)\n9개, 학습되는 값\n\n→ 학습 땐\nμ ± σ 범위에서\n무작위로 시도', ha='center', va='center', fontsize=7.5, color=C['orange'])
    ax.text(50, 44, '정책 신경망 (가중치 약 1만 3천 개, 파일 약 240 KB) — 별도 가치 신경망(같은 구조, 출력 1)이 "이 상황의 기대 점수"를 추정', ha='center', fontsize=9, weight='bold', color=C['ink'])
    save(fig, 'f07-network')


# ---------------------------------------------------------------- 8. 관측 격자 예시
def fig_obs():
    fig = plt.figure(figsize=(9, 3.6), dpi=200)
    rng = np.random.default_rng(7)
    pts = np.c_[rng.uniform(1100, 2300, 160), rng.uniform(-900, 900, 160)]
    keep = ~((pts[:, 0] > 1500) & (pts[:, 0] < 2050) & (np.abs(pts[:, 1]) < 350))
    pts = pts[keep]
    ax = fig.add_axes([0.04, 0.12, 0.42, 0.78]); ax.set_aspect('equal')
    ax.add_patch(Rectangle((1100, -900), 1200, 1800, fc='#F5F7FA', ec=C['ink']))
    ax.scatter(pts[:, 0], pts[:, 1], s=8, c='#3E4C59')
    for i in range(13): ax.plot([1100 + i * 100, 1100 + i * 100], [-900, 900], color=C['line'], lw=0.5)
    for j in range(9): ax.plot([1100, 2300], [-900 + j * 225, -900 + j * 225], color=C['line'], lw=0.5)
    ax.set_title('작업 영역의 드로스 (예시)', fontsize=9); ax.tick_params(labelsize=6)
    ax2 = fig.add_axes([0.52, 0.12, 0.42, 0.78]); ax2.set_aspect('equal')
    H, _, _ = np.histogram2d(pts[:, 0], pts[:, 1], bins=[12, 8], range=[[1100, 2300], [-900, 900]])
    im = ax2.imshow(np.minimum(H.T / 4, 1), origin='lower', extent=[1100, 2300, -900, 900], cmap='Blues', vmin=0, vmax=1)
    for i in range(12):
        for j in range(8):
            ax2.text(1150 + i * 100, -787 + j * 225, f'{min(H[i, j] / 4, 1):.2f}'.rstrip('0').rstrip('.') if H[i, j] else '0', ha='center', va='center', fontsize=5.2, color='white' if H[i, j] >= 3 else C['ink'])
    ax2.set_title('정책이 보는 값: 12×8 칸, 칸당 개수 ÷ 4 (최대 1)', fontsize=9); ax2.tick_params(labelsize=6)
    fig.text(0.5, 0.02, '+ 남은 드로스 비율, 경과 시간 비율 → 숫자 98개. 지금은 시뮬레이터의 입자 위치로 만든다(2단계에서 상부 가상 카메라로 바꿈).', ha='center', fontsize=7.5, color=C['sub'])
    save(fig, 'f08-observation')


# ---------------------------------------------------------------- 9. PPO 학습 루프
def fig_ppo_loop():
    fig, ax = canvas(10, 6.2)
    ax.text(50, 59, '2단계 PPO 학습 절차 (tools/ppo-train.mjs)', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    box(ax, 2, 38, 22, 13, 'A. 모방 학습 3회', '규칙 경로가 고른 스트로크를\n신경망이 따라 하게 함\n(출발점을 0이 아닌 곳에)', fc=C['purpleL'], ec=C['purple'], bsize=7.3)
    box(ax, 30, 38, 24, 13, 'B. 롤아웃 (연습 경기)', '같은 신경망으로 에피소드 14개\nWorker 14개가 동시에\n에피소드마다 다른 드로스 배치', fc=C['blueL'], ec=C['blue'], bsize=7.3)
    box(ax, 60, 38, 22, 13, 'C. 점수 정리 (GAE)', '각 스트로크가 "평소보다\n얼마나 좋았나" = 이점(A)\nγ 0.99, λ 0.95', fc=C['blueL'], ec=C['blue'], bsize=7.3)
    box(ax, 60, 18, 22, 13, 'D. 가중치 수정 (PPO)', '이점 > 0 행동은 더 자주,\n< 0 은 덜 자주.\n한 번에 ±20% 이상 못 바꿈(클립)', fc=C['blueL'], ec=C['blue'], bsize=7.3)
    box(ax, 30, 18, 24, 13, 'E. 5회마다 시험', '고정 시드 11·12·13, 무작위 없이\n→ 점수 기록\n→ checkpoints/iter-NNN.json 저장', fc=C['yellowL'], ec=C['yellow'], bsize=7.3)
    box(ax, 2, 18, 22, 13, 'F. 최고 점수면 교체', '지금까지 시험 점수 최고 →\npolicy-best.json\n(마지막 것은 policy-last.json)', fc=C['greenL'], ec=C['green'], bsize=7.3)
    box(ax, 2, 2, 52, 10, 'G. 학습 끝 → 최고 정책을 전체 셀 10분 과제로 평가 (cell-eval-alone.md, 3D 재생 파일)', fc=C['tealL'], ec=C['teal'], tsize=8.4)
    arrow(ax, 24, 44.5, 30, 44.5, color=C['ink']); arrow(ax, 54, 44.5, 60, 44.5, color=C['ink']); arrow(ax, 71, 38, 71, 31, color=C['ink'])
    arrow(ax, 60, 24.5, 54, 24.5, color=C['ink']); arrow(ax, 30, 24.5, 24, 24.5, color=C['ink']); arrow(ax, 13, 18, 13, 12, color=C['ink'])
    arrow(ax, 82, 24.5, 88, 24.5, color=C['blue']); arrow(ax, 88, 24.5, 88, 54.5, color=C['blue'], style='-'); arrow(ax, 88, 54.5, 42, 54.5, color=C['blue'], style='-'); arrow(ax, 42, 54.5, 42, 51.2, color=C['blue'])
    ax.text(90, 37, '반복 1회\n= B → C → D\n\n40회 반복', fontsize=8, color=C['blue'], ha='left', va='center', weight='bold')
    save(fig, 'f09-ppo-loop')


# ---------------------------------------------------------------- 10. "40회"의 의미 (타임라인)
def fig_iter():
    c = json.loads(read('results/2026-11-05/1814_ppo-train_kr210-run1/train-curve.json'))
    fig, ax = canvas(10, 3.6)
    ax.text(50, 33, '"40번 학습" = 같은 신경망 1개를 40번 고쳐 쓴 것 (파일이 40개 생기는 것이 아님)', ha='center', fontsize=10, weight='bold', color=C['ink'])
    x0, x1, y = 6, 94, 18
    ax.plot([x0, x1], [y, y], color=C['ink'], lw=1.5)
    for i in range(0, 41):
        x = x0 + (x1 - x0) * i / 40
        big = i % 5 == 0
        ax.plot([x, x], [y - (1.6 if big else 0.8), y + (1.6 if big else 0.8)], color=C['ink'], lw=1 if big else 0.6)
    evals = [e for e in c if e['phase'] == 'eval']
    for e in evals:
        i = e['iter']; x = x0 + (x1 - x0) * i / 40
        best = i == 40
        ax.add_patch(Circle((x, y + 5), 1.6, fc=C['green'] if best else C['yellowL'], ec=C['green'] if best else C['yellow'], lw=1))
        ax.text(x, y + 8, f"{e['rate']:.1f}%", ha='center', fontsize=7, color=C['green'] if best else C['sub'], weight='bold' if best else 'normal')
        ax.text(x, y - 4, '모방 후' if i == 0 else f'{i}회', ha='center', fontsize=7, color=C['ink'])
    ax.text(x0, 6.5, '● 시험(5회마다): 그 순간의 신경망을 checkpoints/iter-NNN.json으로 저장(이번 run1 이후 학습부터 적용)\n● 초록 = 시험 점수 최고 → policy-best.json (이번 학습은 40회째가 최고라 policy-last.json과 같은 시점)', fontsize=7.6, color=C['sub'], va='center', linespacing=1.6)
    ax.text(x1, 27, '반복 1회 = 에피소드 14개 연습 → 가중치 수정', ha='right', fontsize=7.6, color=C['blue'])
    save(fig, 'f10-iterations')


# ---------------------------------------------------------------- 11. 학습 곡선
def fig_curve():
    c = json.loads(read('results/2026-11-05/1814_ppo-train_kr210-run1/train-curve.json'))
    ppo = [e for e in c if e['phase'] == 'ppo']; ev = [e for e in c if e['phase'] == 'eval']; bc = [e for e in c if e['phase'] == 'bc']
    fig, axs = plt.subplots(1, 2, figsize=(10, 3.6), dpi=200)
    ax = axs[0]
    ax.plot([e['iter'] for e in ppo], [e['rate'] for e in ppo], color=C['line'], lw=1, marker='.', ms=3, label='연습(롤아웃 14개 평균, 무작위 시도 포함)')
    ax.plot([e['iter'] for e in ev], [e['rate'] for e in ev], color=C['blue'], lw=2, marker='o', ms=4, label='시험(고정 시드 3개, 무작위 없음)')
    ax.axhline(bc[-1]['rate'], color=C['grayD'], ls='--', lw=1); ax.text(40.5, bc[-1]['rate'] + 0.8, f"교사(규칙) {bc[-1]['rate']:.1f}%", fontsize=7, color=C['grayD'], ha='right')
    best = max(ev, key=lambda e: e['ret'])
    ax.annotate(f"최고 {best['rate']:.1f}% (반복 {best['iter']})", xy=(best['iter'], best['rate']), xytext=(best['iter'] - 15, best['rate'] + 2), fontsize=7.5, color=C['green'], arrowprops=dict(arrowstyle='->', color=C['green']))
    ax.set_xlabel('PPO 반복', fontsize=8); ax.set_ylabel('10분 회수율 (학습 환경, %)', fontsize=8); ax.tick_params(labelsize=7)
    ax.set_ylim(30, 80); ax.grid(alpha=0.3); ax.legend(fontsize=6.6, loc='lower right')
    ax.set_title('회수율', fontsize=9)
    ax = axs[1]
    ax.plot([e['iter'] for e in ev], [e['empties'] for e in ev], color=C['red'], lw=2, marker='o', ms=4, label='헛질 (시험)')
    ax.plot([e['iter'] for e in ev], [e['repaired'] for e in ev], color=C['yellow'], lw=1.5, marker='s', ms=3, label='보정된 스트로크 (시험)')
    ax.axhline(bc[-1]['empties'], color=C['grayD'], ls='--', lw=1); ax.text(40.5, bc[-1]['empties'] + 0.15, f"교사 헛질 {bc[-1]['empties']:.1f}", fontsize=7, color=C['grayD'], ha='right')
    ax.set_xlabel('PPO 반복', fontsize=8); ax.set_ylabel('에피소드당 횟수', fontsize=8); ax.tick_params(labelsize=7); ax.grid(alpha=0.3); ax.legend(fontsize=7)
    ax.set_title('헛질·보정', fontsize=9)
    fig.tight_layout()
    save(fig, 'f11-curve')


# ---------------------------------------------------------------- 12. 정책 실행기 안전장치
def fig_runner():
    fig, ax = canvas(10, 4.8)
    ax.text(50, 45, '정책 실행기 (makePolicyChooser): 신경망 출력이 이상해도 로봇이 멈추지 않게', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    xs = [2, 22, 42, 62, 82]
    items = [('정책 출력', '9개 값 (μ)', C['blueL'], C['blue']),
             ('구역 제한', '측면 로봇 모드 1이면\n|Y| ≤ 230 안으로', C['yellowL'], C['yellow']),
             ('길이 0 방지', '경계에서 바깥을 향하면\n방향을 뒤집음', C['yellowL'], C['yellow']),
             ('사이클 계획', 'IK·충돌·도달 검사', C['tealL'], C['teal']),
             ('실행', '안전 게이트 통과 후\n물리 시뮬레이터', C['greenL'], C['green'])]
    for x, (t, b, fc, ec) in zip(xs, items):
        box(ax, x, 26, 16, 13, t, b, fc=fc, ec=ec, bsize=7.2)
    for x in xs[:-1]:
        arrow(ax, x + 16, 32.5, x + 20, 32.5, color=C['ink'])
    box(ax, 50, 3, 22, 12, '보정 k1 → k2', 'k1: 시작점을 상자 안으로,\n열린 면·기울임 절반\nk2: 열린 면·기울임 0, Y × 0.85', fc=C['orangeL'], ec=C['orange'], bsize=7)
    box(ax, 78, 3, 20, 12, '규칙 레인으로 대체', '보정도 실패하면\nv1.1.2 규칙 스트로크', fc=C['gray'], ec=C['grayD'], bsize=7)
    arrow(ax, 66, 26, 58, 15.2, text='실패', color=C['red'], toff=(-4, -1))
    arrow(ax, 72, 9, 78, 9, text='실패', color=C['red'], toff=(0, 0.8))
    arrow(ax, 64, 15, 72, 25.8, color=C['green'], text='보정 성공', toff=(6, -1))
    ax.text(2, 14, '발견해 고친 버그 (2026-11-05)\n① 덤프 뒤 복귀 자세가 매번 같아 "실패 재시도"로 오판\n    → 무작위 행동 → 대형 로봇 정지 (10분 33%로 잘못 측정)\n    → 실패 판정을 시뮬레이션 시간 기준으로 바꿈\n② 측면 로봇 구역 침범 → 안전 게이트가 정지 → 구역 제한 추가\n③ 경계에서 길이 0 스트로크 → 헛동작 → 방향 뒤집기 추가', fontsize=7.3, color=C['sub'], va='top', linespacing=1.5)
    save(fig, 'f12-runner')


# ---------------------------------------------------------------- 13. 결과 비교
def fig_results():
    a = eval_md('alone'); m = eval_md('mode1')
    base = json.loads(read('results/2026-11-05/1541_baseline_alone+mode1+mode2/data.json'))
    cem = {n: cem_md(n) for n in ['kr210-alone-s11', 'kr210-alone-s12', 'kr210-mode1-s11']}
    fig, axs = plt.subplots(1, 2, figsize=(10, 3.8), dpi=200, gridspec_kw=dict(width_ratios=[3, 2]))
    ax = axs[0]
    seeds = [r[0] for r in a]
    x = np.arange(len(seeds)); w = 0.26
    cem_by_seed = {11: cem['kr210-alone-s11'][0], 12: cem['kr210-alone-s12'][0]}
    ax.bar(x - w, [r[2] for r in a], w, color=C['grayD'], label='규칙 경로')
    ax.bar(x, [r[1] for r in a], w, color=C['blue'], label='PPO 정책')
    ax.bar(x + w, [cem_by_seed.get(s, np.nan) for s in seeds], w, color=C['green'], label='진화 탐색(CEM)')
    for i, r in enumerate(a):
        ax.text(i - w, r[2] + 1, f'{r[2]:.1f}', ha='center', fontsize=6.5); ax.text(i, r[1] + 1, f'{r[1]:.1f}', ha='center', fontsize=6.5, color=C['blue'], weight='bold')
        if seeds[i] in cem_by_seed: ax.text(i + w, cem_by_seed[seeds[i]] + 1, f'{cem_by_seed[seeds[i]]:.1f}', ha='center', fontsize=6.5, color=C['green'])
        else: ax.text(i + w, 2, 'CEM\n미측정', ha='center', fontsize=6, color=C['sub'])
    ax.axhline(80, color=C['red'], ls='--', lw=1); ax.text(-0.45, 81, '목표 80%', fontsize=7, color=C['red'], ha='left')
    ax.set_xticks(x); ax.set_xticklabels([f'시드 {s}' for s in seeds], fontsize=8); ax.set_ylim(0, 90); ax.tick_params(labelsize=7)
    ax.set_ylabel('10분 회수율 (%)', fontsize=8); ax.set_title('KR 210 단독 (전체 셀 시뮬레이터)', fontsize=9); ax.legend(fontsize=7, loc='upper center', bbox_to_anchor=(0.5, -0.1), ncol=3, frameon=False); ax.grid(axis='y', alpha=0.3)
    ax = axs[1]
    labs = ['규칙', 'PPO', 'CEM\n(시드 11)']
    vals = [np.mean([r[2] for r in m]), np.mean([r[1] for r in m]), cem['kr210-mode1-s11'][0]]
    ax.bar(range(3), vals, color=[C['grayD'], C['blue'], C['green']], width=0.55)
    for i, v in enumerate(vals): ax.text(i, v + 1, f'{v:.1f}', ha='center', fontsize=7.5)
    ax.axhline(80, color=C['red'], ls='--', lw=1)
    ax.set_xticks(range(3)); ax.set_xticklabels(labs, fontsize=8); ax.set_ylim(0, 90); ax.tick_params(labelsize=7); ax.grid(axis='y', alpha=0.3)
    ax.set_title('KR 210 + 측면 2대 (모드 1)\n규칙·PPO = 시드 3개 평균', fontsize=9)
    fig.tight_layout()
    save(fig, 'f13-results')


# ---------------------------------------------------------------- 14. 기준선
def fig_baseline():
    d = json.loads(read('results/2026-11-05/1541_baseline_alone+mode1+mode2/data.json'))
    rs = d['results']
    names = {'abb-irb6700-200-260': 'IRB 6700', 'kuka-kr210-r2700': 'KR 210', 'fanuc-r2000ic-165f': 'R-2000iC', 'nachi-sra166': 'SRA166'}
    cfgs = [('alone', '단독'), ('mode1', '3대 모드 1'), ('mode2', '3대 모드 2')]
    mains = d['mains']
    fig, ax = plt.subplots(figsize=(9, 3.4), dpi=200)
    w = 0.25
    for k, (cf, lab) in enumerate(cfgs):
        vals = []
        for mn in mains:
            v = [r['summary']['rateCount'] for r in rs if r['main'] == mn and r['config'] == cf and r.get('summary')]
            vals.append(np.mean(v) if v else 0)
        ax.bar(np.arange(len(mains)) + (k - 1) * w, vals, w, label=lab, color=[C['grayD'], C['purple'], C['teal']][k])
        for i, v in enumerate(vals): ax.text(i + (k - 1) * w, v + 1, f'{v:.0f}', ha='center', fontsize=6.5)
    ax.axhline(80, color=C['red'], ls='--', lw=1); ax.text(len(mains) - 0.5, 81, '목표 80%', fontsize=7, color=C['red'], ha='right')
    ax.set_xticks(range(len(mains))); ax.set_xticklabels([names.get(m, m) for m in mains], fontsize=8)
    ax.set_ylim(0, 90); ax.set_ylabel('10분 회수율 (%)', fontsize=8); ax.tick_params(labelsize=7); ax.legend(fontsize=7, ncol=3, loc='upper right'); ax.grid(axis='y', alpha=0.3)
    ax.set_title('0단계 기준선: 규칙 경로만 (시드 3개 평균, 36회 중 80% 도달 0회)', fontsize=9)
    fig.tight_layout()
    save(fig, 'f14-baseline')


# ---------------------------------------------------------------- 15. 현장 적용 구조
def fig_hw():
    fig, ax = canvas(10, 5.2)
    ax.text(50, 50, '현장 적용 구성 (PRD 9장) — 시뮬레이터와 같은 "격자 → 정책 → 안전 → 로봇" 흐름', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    items = [(2, '상부 카메라 1~2대', '열화상/내열 RGB\n포트 위 약 4 m', C['gray'], C['grayD']),
             (21, '드로스 인식', '영상 → 드로스 분할\n→ 12×8 격자\n(시뮬레이터와 같은 형식)', C['tealL'], C['teal']),
             (40, '정책 실행', 'policy.json → ONNX\n산업용 PC, 추론 < 1 ms', C['blueL'], C['blue']),
             (59, '디지털 트윈 + 안전 필터', '실측 보정 셀 모델\n계획·IK·충돌 검사', C['redL'], C['red']),
             (78, '로봇 어댑터', 'UR RTDE · KUKA RSI\nABB EGM · FANUC\nStream Motion', C['purpleL'], C['purple'])]
    for x, t, b, fc, ec in items:
        box(ax, x, 28, 17, 15, t, b, fc=fc, ec=ec, bsize=7.2, tsize=8.8)
    for x, *_ in items[:-1]:
        arrow(ax, x + 17, 35.5, x + 19, 35.5, color=C['ink'])
    stages = [('H0', '오프라인 재생', 'v3.0.0'), ('H1', '섀도 모드\n(제안만)', 'v3.0.0'), ('H2', '공중 시운전', 'v3.1.0'), ('H3', '상온 모의 시험대', 'v3.1.0'), ('H4', '실제 포트\n감독 운전', 'v3.1.0'), ('H5', '운영 + 재학습', 'v3.1.0~')]
    for i, (k, t, v) in enumerate(stages):
        x = 2 + i * 16.3
        fc = C['blueL'] if v == 'v3.0.0' else C['gray']
        box(ax, x, 6, 14.5, 14, f'{k}\n{t}', fc=fc, ec=C['blue'] if v == 'v3.0.0' else C['grayD'], tsize=8.3)
        ax.text(x + 7.25, 3.2, v, ha='center', fontsize=7.5, color=C['sub'])
        if i < 5: arrow(ax, x + 14.5, 13, x + 16.3, 13, color=C['ink'])
    ax.text(2, 23, '단계적 적용: 실제 로봇에서 바로 학습하지 않는다. 시뮬레이터에서 학습 → 현장은 단계마다 확인하며 올린다.', fontsize=8, color=C['ink'])
    save(fig, 'f15-hardware')


# ---------------------------------------------------------------- 16. 결과 폴더 구조
def fig_tree():
    fig, ax = canvas(10, 6.4)
    lines = [
        ('results/', '', 0, C['ink']),
        ('README.md', '폴더·파일 이름 규칙 안내', 1, C['sub']),
        ('baseline/', '0단계: 규칙 경로 기준선 (tools/baseline.mjs)', 1, C['grayD']),
        ('report.md · data.json', '표 · 전체 수치', 2, C['sub']),
        ('cem/', '1단계: 진화 탐색 (tools/train.mjs)', 1, C['green']),
        ('kr210-alone-s11/', '<로봇>-<구성>-s<시드>', 2, C['green']),
        ('report.md · log.json*', '보고서 · 모든 시도 기록', 3, C['sub']),
        ('cem-alone-s11.rsim.json.gz*', '학습 결과 3D 재생', 3, C['sub']),
        ('rule-alone-s11.rsim.json.gz*', '같은 과제의 규칙 경로 3D 재생', 3, C['sub']),
        ('ppo/', '2단계: PPO 강화학습 (tools/ppo-train.mjs)', 1, C['blue']),
        ('kr210-run1/', '<로봇>-<학습 이름>', 2, C['blue']),
        ('policy-best.json', '최종 채택 정책 ← 앱 [정책 불러오기]', 3, C['blue']),
        ('policy-last.json', '마지막 반복 정책 (이어서 학습할 때)', 3, C['sub']),
        ('checkpoints/iter-NNN.json', '5회마다 저장한 중간 정책 (다음 학습부터)', 3, C['sub']),
        ('train-report.md · train-curve.json', '학습 보고서 · 반복별 기록', 3, C['sub']),
        ('cell-eval-alone.md · cell-eval-mode1.md', '전체 셀 10분 평가 표', 3, C['sub']),
        ('ppo-alone-s11.rsim.json.gz*  rule-alone-s11…*', '평가 3D 재생 (정책 · 규칙)', 3, C['sub']),
        ('episodes/*', '단발 헤드리스 실행 (tools/episode.mjs)', 1, C['grayD']),
    ]
    y = 60
    for name, desc, lv, col in lines:
        x = 3 + lv * 5
        if lv:
            ax.plot([x - 3.2, x - 0.8], [y + 0.8, y + 0.8], color=C['line'], lw=0.8)
        ax.text(x, y + 0.8, name, fontsize=8.3, va='center', color=col, family='Consolas' if '.' in name or '/' in name else None, weight='bold' if name.endswith('/') else 'normal')
        ax.text(60, y + 0.8, desc, fontsize=7.8, va='center', color=C['sub'])
        y -= 3.3
    ax.text(3, 1.5, '* = 용량 때문에 git에 올리지 않는 파일(명령으로 다시 만듦). 3D 재생 이름 규칙: <방법>-<구성>-s<시드>.rsim.json.gz, 방법 = rule | cem | ppo, 구성 = alone | mode1 | mode2', fontsize=7.3, color=C['sub'])
    save(fig, 'f16-results-tree')


for f in [fig_cell, fig_roadmap, fig_ab, fig_b_flow, fig_stroke, fig_cem, fig_net, fig_obs, fig_ppo_loop, fig_iter, fig_curve, fig_runner, fig_results, fig_baseline, fig_hw, fig_tree]:
    f()
print('ok')


# =============================================================== 개정판(2026-11-06 11:15) 추가·교체 그림
import glob, shutil
A_DOC = 'docs/2026-11-06_1028_A단계_밀어주기_쓸기방향/images'
A_ALONE = 'results/2026-11-06/1022_baseline_kr210_alone_lane-dir/data.json'
A_PUSH = 'results/2026-11-06/1022_baseline_kr210_mode2-vs-push/data.json'


def b_runs():
    """[B] 시범 수집의 진화 탐색 실행 (시드 101~ / 201~) → [(config, seed, cem, rule, demos)]"""
    out = []
    for d in sorted(glob.glob(f'{ROOT}/results/2026-11-06/*_cem_kr210-*-s[12]0[0-9]')):
        if not os.path.exists(f'{d}/demos.json'):
            continue
        rep = open(f'{d}/report.md', encoding='utf8').read()
        m = re.search(r'회수율 \(개수 / 질량\) \| \*\*([\d.]+)%\*\* / [\d.]+% \| \*\*([\d.]+)%\*\*', rep)
        dm = json.load(open(f'{d}/demos.json', encoding='utf8'))
        out.append((dm['config'], dm['seed'], float(m.group(1)), float(m.group(2)), len(dm['demos'])))
    return out


def fig_roadmap2():
    fig, ax = canvas(10, 5.6)
    ax.text(50, 53.5, '전체 진행 흐름 — 무엇을, 어떤 순서로 (2026-11-06 기준)', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    steps = [
        ('0', '기준선', '규칙 경로만\n36회', '단독 61.3%', C['gray'], C['grayD'], '완료'),
        ('1', '진화 탐색 1차', '결정마다 128번\n미리 시도', '단독 약 75%', C['greenL'], C['green'], '완료'),
        ('2', 'PPO 1차', '규칙 경로를 교사로\n모방 + PPO 40회', '단독 65.6%', C['blueL'], C['blue'], '완료'),
        ('A', '셀·동작 개선', '측면 타이밍 밀기\n쓸기 방향 번갈아', '단독 72.9%\n측면 57.5%', C['yellowL'], C['yellow'], '완료'),
        ('B', '시범 수집', '진화 탐색이 새 셀에서\n좋은 선택을 기록', '단독 85% 안팎', C['greenL'], C['green'], '진행 중'),
        ('C', 'PPO 재학습', '진화 탐색 시범이 교사\n측면 셀 포함', '목표: 80%', C['blueL'], C['blue'], '다음'),
        ('D', '가상 카메라', '현장과 같은 입력\n전후 비교', '현장 준비', C['purpleL'], C['purple'], '그다음'),
    ]
    w, gap = 12.4, 1.6
    for i, (k, t, b, res, fc, ec, st) in enumerate(steps):
        x = 1.5 + i * (w + gap)
        box(ax, x, 12, w, 34, f'{k}. {t}', b, fc=fc, ec=ec, tsize=8.6, bsize=7)
        ax.add_patch(FancyBboxPatch((x + 1, 14), w - 2, 9, boxstyle='round,pad=0,rounding_size=0.8', fc='white', ec=ec, lw=1))
        ax.text(x + w / 2, 18.5, res, ha='center', va='center', fontsize=7.2, color=ec, weight='bold')
        col = {'완료': C['green'], '진행 중': C['orange'], '다음': C['blue'], '그다음': C['grayD']}[st]
        ax.text(x + w / 2, 8.5, st, ha='center', fontsize=8, color=col, weight='bold')
        if i < len(steps) - 1:
            arrow(ax, x + w + 0.1, 29, x + w + gap - 0.1, 29, color=C['ink'])
    ax.text(50, 3, '숫자: KR 210, 10분 회수율(시드 평균). 0~2단계는 2026-11-05, A·B는 2026-11-06. 진화 탐색은 현장에서 못 쓰므로 PPO의 교사로 쓴다.', ha='center', fontsize=7.4, color=C['sub'])
    save(fig, 'f02-roadmap')


def fig_three():
    fig, ax = canvas(10, 5.4)
    ax.text(50, 51.5, '세 가지 방법과 역할: 기준 · 교사 · 학생', ha='center', fontsize=10.5, weight='bold', color=C['ink'])
    cols = [
        ('규칙 경로 (rule)', '기준', C['gray'], C['grayD'],
         '정해진 규칙으로 결정\n(드로스가 가장 많은 레인,\n고정 방향·수평 스쿱)',
         '• 비교 기준선 (같은 시드)\n• 안전한 대체 동작\n• PPO 1차의 교사\n• 학습 후보의 출발점',
         '현장 사용: 가능\n결정 시간: 즉시\n회수율: 61~73%'),
        ('진화 탐색 (CEM)', '교사', C['greenL'], C['green'],
         '결정마다 지금 드로스를 복사한\n시뮬레이터에서 128번 시도\n→ 점수 최고 1개 실행',
         '• 시뮬레이터 안 상한 확인\n• 좋은 시범 만들기\n• 새 동작(J6 회전·반대 방향)\n  이 효과 있는지 검증',
         '현장 사용: 불가\n결정 시간: 10~15 s\n회수율: 84~89% (B 단독)'),
        ('PPO 정책 (ppo)', '학생', C['blueL'], C['blue'],
         '드로스 격자(12×8)만 보고\n신경망이 바로 결정\n(미리 연습해 둠)',
         '• 현장에서 쓸 최종 모델\n• 교사(CEM) 시범을 모방\n  → 스스로 연습해 개선\n• 카메라 격자 입력',
         '현장 사용: 가능\n결정 시간: 1 ms 미만\n회수율: 65.6% (1차)'),
    ]
    for i, (t, role, fc, ec, how, why, prop) in enumerate(cols):
        x = 2 + i * 32.5
        box(ax, x, 3, 30.5, 45, t, None, fc=fc, ec=ec, tsize=10)
        ax.patches[-1].set_height(45)
        ax.texts[-1].set_position((x + 15.25, 45)); ax.texts[-1].set_va('top')
        ax.text(x + 15.25, 40.5, f'역할: {role}', ha='center', fontsize=9, color=ec, weight='bold')
        ax.text(x + 1.5, 37, '어떻게', fontsize=7.6, weight='bold', color=C['ink']); ax.text(x + 1.5, 35, how, fontsize=7.3, va='top', color=C['sub'], linespacing=1.4)
        ax.text(x + 1.5, 25.5, '왜 하나', fontsize=7.6, weight='bold', color=C['ink']); ax.text(x + 1.5, 23.5, why, fontsize=7.3, va='top', color=C['sub'], linespacing=1.4)
        ax.add_patch(FancyBboxPatch((x + 1.2, 4.2), 28, 8, boxstyle='round,pad=0,rounding_size=0.8', fc='white', ec=ec, lw=1))
        ax.text(x + 15.25, 8.2, prop, ha='center', va='center', fontsize=7.3, color=ec, linespacing=1.35)
    arrow(ax, 64.6, 30, 67, 30, color=C['green'], text='시범', toff=(0, 1))
    save(fig, 'f17-three-methods')


def fig_compare():
    fig, ax = canvas(10, 3.6)
    ax.text(50, 33.5, '왜 같은 시드(드로스 배치)로 규칙 경로와 함께 돌리나', ha='center', fontsize=10, weight='bold', color=C['ink'])
    box(ax, 2, 6, 22, 22, '시드 = 드로스 배치', '시드마다 난이도가 다르다\n(규칙 경로로 57~77%)\n→ 숫자 하나만으로는\n좋은지 모른다', fc=C['gray'], ec=C['grayD'], bsize=7.2)
    box(ax, 28, 6, 22, 22, '같은 시드로 둘 다', '진화 탐색 86.1%\n규칙 경로 71.5%\n→ 차이 +14.6%p가\n진짜 개선', fc=C['greenL'], ec=C['green'], bsize=7.2)
    box(ax, 54, 6, 20, 22, '교사 품질 확인', '규칙보다 확실히 좋을 때만\n시범으로 쓸 가치\n(못하면 빼거나\n비중을 낮춤)', fc=C['yellowL'], ec=C['yellow'], bsize=7.2)
    box(ax, 78, 6, 20, 22, '[C]의 기준선', 'PPO가 규칙보다 나은지,\n교사에 얼마나\n가까워졌는지\n같은 시드로 줄 세움', fc=C['blueL'], ec=C['blue'], bsize=7.2)
    for x0, x1 in [(24, 28), (50, 54), (74, 78)]:
        arrow(ax, x0, 17, x1, 17, color=C['ink'])
    ax.text(50, 2, '평가용 시드(11·12·13)와 시범 수집 시드(101~, 201~)는 겹치지 않게 나눈다 — 배운 배치로 시험하면 실력을 부풀려 보게 되므로.', ha='center', fontsize=7.4, color=C['sub'])
    save(fig, 'f18-compare')


def fig_b_progress():
    rs = b_runs()
    fig, ax = plt.subplots(figsize=(10, 3.4), dpi=200)
    if not rs:
        ax.text(0.5, 0.5, '[B] 완료된 에피소드 없음', ha='center'); save(fig, 'f19-b-demos'); return
    lab = [f"{'단독' if c == 'alone' else '밀기'}\n{s}" for c, s, *_ in rs]
    x = np.arange(len(rs)); w = 0.38
    ax.bar(x - w / 2, [r[3] for r in rs], w, color=C['grayD'], label='규칙 경로 (단독 = 번갈아, 측면 셀 = 로봇 쪽)')
    ax.bar(x + w / 2, [r[2] for r in rs], w, color=C['green'], label='진화 탐색 (시범)')
    for i, r in enumerate(rs):
        ax.text(i + w / 2, r[2] + 1, f'{r[2]:.1f}', ha='center', fontsize=6.5, color=C['green'])
        ax.text(i - w / 2, r[3] + 1, f'{r[3]:.1f}', ha='center', fontsize=6.2)
    ax.axhline(80, color=C['red'], ls='--', lw=1); ax.text(-0.5, 81, '목표 80%', fontsize=7, color=C['red'])
    ax.set_xticks(x); ax.set_xticklabels(lab, fontsize=7); ax.set_ylim(0, 100); ax.set_ylabel('10분 회수율 (%)', fontsize=8); ax.tick_params(labelsize=7)
    ax.legend(fontsize=7, loc='upper right', ncol=2); ax.grid(axis='y', alpha=0.3)
    ax.set_title(f'[B] 시범 수집: 에피소드별 진화 탐색 vs 규칙 경로 (작성 시점 완료 {len(rs)}개, 시범 {sum(r[4] for r in rs)}개)', fontsize=9)
    fig.tight_layout(); save(fig, 'f19-b-demos')


def fig_tree2():
    fig, ax = canvas(10, 6.2)
    lines = [
        ('v3.0.0/results/', '', 0, C['ink']),
        ('INDEX.md', '모든 실행을 시간순으로 (도구가 자동 추가)', 1, C['sub']),
        ('2026-11-05/', '날짜', 1, C['ink']),
        ('1541_baseline_alone+mode1+mode2/', '<시각>_<종류>_<이름>', 2, C['grayD']),
        ('1552_cem_kr210-alone-s11/', '진화 탐색 1차', 2, C['green']),
        ('1814_ppo-train_kr210-run1/', 'PPO 1차 (policy-best.json …)', 2, C['blue']),
        ('2026-11-06/', '', 1, C['ink']),
        ('1022_baseline_kr210_alone_lane-dir/', '[A] 쓸기 방향', 2, C['grayD']),
        ('1048_cem_kr210-alone-s101/', '[B] 진화 탐색 + 시범', 2, C['green']),
        ('report.md · run.json · demos.json · log.json', '보고서 · 명령 기록 · 시범 · 모든 시도', 3, C['sub']),
        ('cem-alone-s101.rsim.json.gz · rule-alone-s101.rsim.json.gz', '3D 재생 (진화 탐색 · 규칙)', 3, C['sub']),
        ('<시각>_cem-demos_kr210-alone10-push6/demos.json', '[B] 시범 모음 → [C] 교사', 2, C['green']),
        ('v3.0.0/docs/', '', 0, C['ink']),
        ('README.md', '문서 목록', 1, C['sub']),
        ('<날짜>_<시각>_<제목>/', '문서(.docx) · images/ · build/(만든 스크립트)', 1, C['purple']),
    ]
    y = 56
    for name, desc, lv, col in lines:
        x = 3 + lv * 5
        if lv: ax.plot([x - 3.2, x - 0.8], [y + 0.8, y + 0.8], color=C['line'], lw=0.8)
        ax.text(x, y + 0.8, name, fontsize=8, va='center', color=col, family=['Consolas', 'Malgun Gothic'], weight='bold' if name.endswith('/') else 'normal')
        ax.text(66, y + 0.8, desc, fontsize=7.6, va='center', color=C['sub'])
        y -= 3.55
    ax.text(3, 2, '규칙: 덮어쓰지 않는다. 3D 재생·시도 기록까지 모두 git에 올린다(다른 PC에서 그대로). 커밋 메시지 앞에 [날짜 시각 KST].', fontsize=7.6, color=C['sub'])
    save(fig, 'f16-results-tree')


def copy_a():
    for n in ['a02-results', 'a03-snout-stroke', 'a04-timing', 'a05-quat']:
        shutil.copy(f'{ROOT}/{A_DOC}/{n}.png', f'{OUT}/{n}.png')
    print('   a02~a05 복사 ([A] 보고서 그림)')


for f in [fig_roadmap2, fig_three, fig_compare, fig_b_progress, fig_tree2, copy_a]:
    f()
print('ok2')
