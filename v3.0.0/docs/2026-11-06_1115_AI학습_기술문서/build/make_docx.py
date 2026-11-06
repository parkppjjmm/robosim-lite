# RoboSim Lite v3.0.0 — AI 학습 기술 문서 개정판 (Word) 생성, 2026-11-06 11:15 (이전 판 0845의 스크립트를 바탕으로)
# 실행: python docs/build/make_docx.py <v3.0.0 폴더> <그림 폴더> <출력 .docx>
# 필요: python-docx. 그림은 docs/build/figures.py로 먼저 만든다. 수치는 results/ 파일에서 읽는다.
import json, os, re, sys
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# 이 문서가 쓴 결과 (2026-11-06 날짜·시각별 폴더로 옮긴 경로)
EVAL = {'alone': 'results/2026-11-06/0836_ppo-eval_kr210-run1-alone/cell-eval-alone.md', 'mode1': 'results/2026-11-06/0842_ppo-eval_kr210-run1-mode1/cell-eval-mode1.md'}
CEM = {'kr210-alone-s11': 'results/2026-11-05/1552_cem_kr210-alone-s11/report.md', 'kr210-alone-s12': 'results/2026-11-05/1602_cem_kr210-alone-s12/report.md', 'kr210-mode1-s11': 'results/2026-11-05/1609_cem_kr210-mode1-s11/report.md'}
ROOT, IMG, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
read = lambda p: open(f'{ROOT}/{p}', encoding='utf8').read()


def eval_md(cfg):
    rows = []
    for m in re.finditer(r'^\| (\d+) \| \*\*([\d.]+)%\*\* \| ([\d.]+)% \| [^|]+ \| (\d+) \| (\d+) \| (\d+) \|', read(EVAL[cfg]), re.M):
        rows.append(dict(seed=int(m.group(1)), ppo=float(m.group(2)), rule=float(m.group(3)), strokes=int(m.group(4)), repaired=int(m.group(5)), fallback=int(m.group(6))))
    return rows


EA, EM = eval_md('alone'), eval_md('mode1')
mean = lambda a: sum(a) / len(a)
A_PPO, A_RULE = mean([r['ppo'] for r in EA]), mean([r['rule'] for r in EA])
M_PPO, M_RULE = mean([r['ppo'] for r in EM]), mean([r['rule'] for r in EM])
CURVE = json.loads(read('results/2026-11-05/1814_ppo-train_kr210-run1/train-curve.json'))
EV = [e for e in CURVE if e['phase'] == 'eval']
BC = [e for e in CURVE if e['phase'] == 'bc']
BEST = max(EV, key=lambda e: e['ret'])
TRAIN_S = max(e['s'] for e in CURVE)

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21), Cm(29.7)
sec.left_margin = sec.right_margin = Cm(2)
sec.top_margin = sec.bottom_margin = Cm(2)
FONT = '맑은 고딕'


def set_font(style, size=None, bold=None, color=None):
    style.font.name = FONT
    rpr = style.element.get_or_add_rPr()
    rpr.get_or_add_rFonts().set(qn('w:eastAsia'), FONT)
    if size: style.font.size = Pt(size)
    if bold is not None: style.font.bold = bold
    if color: style.font.color.rgb = RGBColor.from_string(color)


set_font(doc.styles['Normal'], 10)
for name, size, color in [('Title', 24, '1F3B57'), ('Heading 1', 16, '1F3B57'), ('Heading 2', 13, '2B5F8A'), ('Heading 3', 11, '2B5F8A')]:
    set_font(doc.styles[name], size, True, color)
for name in ['List Bullet', 'List Number', 'Caption']:
    set_font(doc.styles[name], 10 if name != 'Caption' else 9)

# 쪽 번호 (바닥글)
fp = sec.footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER


def field(par, instr):
    r = par.add_run()
    for tag, text in [('begin', None), (None, instr), ('separate', None), ('end', None)]:
        if tag:
            e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), tag); r._r.append(e)
        else:
            t = OxmlElement('w:instrText'); t.set(qn('xml:space'), 'preserve'); t.text = text; r._r.append(t)
    return r


fp.add_run('RoboSim Lite v3.0.0 · AI 학습 기술 문서 개정판 (2026-11-06 11:15) — ').font.size = Pt(8)
field(fp, 'PAGE')


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd'); shd.set(qn('w:val'), 'clear'); shd.set(qn('w:color'), 'auto'); shd.set(qn('w:fill'), hexcolor)
    tcPr.append(shd)


def H(text, level=1): doc.add_heading(text, level)


def P(text, bold_prefix=None, size=None, after=4):
    p = doc.add_paragraph()
    if bold_prefix:
        r = p.add_run(bold_prefix); r.bold = True
        if size: r.font.size = Pt(size)
    r = p.add_run(text)
    if size: r.font.size = Pt(size)
    p.paragraph_format.space_after = Pt(after)
    return p


def B(items, style='List Bullet'):
    for it in items:
        p = doc.add_paragraph(style=style)
        if isinstance(it, tuple):
            r = p.add_run(it[0]); r.bold = True
            p.add_run(it[1])
        else:
            p.add_run(it)
        p.paragraph_format.space_after = Pt(2)


def T(rows, widths=None, header=True, font=9, bold_first_col=False):
    t = doc.add_table(rows=len(rows), cols=len(rows[0]))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            c = t.cell(i, j)
            c.text = ''
            s = str(val)
            bold = s.startswith('**') and s.endswith('**')
            run = c.paragraphs[0].add_run(s.strip('*') if bold else s)
            run.font.size = Pt(font)
            if bold or (bold_first_col and j == 0 and i > 0): run.bold = True
            if header and i == 0:
                run.bold = True
                shade(c, 'DCE6F0')
            if widths: c.width = Cm(widths[j])
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


FIG = [0]


def IMGP(name, caption, width=17):
    path = os.path.join(IMG, name)
    if not os.path.exists(path):
        P(f'[그림 없음: {name}]'); return
    doc.add_picture(path, width=Cm(width))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    FIG[0] += 1
    c = doc.add_paragraph(f'그림 {FIG[0]}. {caption}', style='Caption'); c.alignment = WD_ALIGN_PARAGRAPH.CENTER


def NOTE(text, fill='FFF6DD', title=None):
    t = doc.add_table(rows=1, cols=1); t.style = 'Table Grid'
    c = t.cell(0, 0); c.text = ''; shade(c, fill)
    p = c.paragraphs[0]
    if title:
        r = p.add_run(title + '\n'); r.bold = True; r.font.size = Pt(10)
    r = p.add_run(text); r.font.size = Pt(9.5)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


pct = lambda v: f'{v:.1f}%'
dp = lambda a, b: f'{a - b:+.1f}%p'

# =============================================================== 개정판 본문 (2026-11-06 11:15)
import glob as _glob
DOC_TIME = '2026-11-06 11:15'
A_ALONE = json.loads(read('results/2026-11-06/1022_baseline_kr210_alone_lane-dir/data.json'))
A_PUSH = json.loads(read('results/2026-11-06/1022_baseline_kr210_mode2-vs-push/data.json'))


def a_runs(d, config, lane):
    return sorted([r for r in d['results'] if r['config'] == config and r.get('laneDir', 'robot') == lane], key=lambda r: r['seed'])


def am(rs, k='rateCount'):
    return sum(r['summary'][k] for r in rs) / len(rs)


AR, AS, AA = a_runs(A_ALONE, 'alone', 'robot'), a_runs(A_ALONE, 'alone', 'snout'), a_runs(A_ALONE, 'alone', 'alternate')
M2, M3 = a_runs(A_PUSH, 'mode2', 'robot'), a_runs(A_PUSH, 'push', 'robot')


def b_runs():
    out = []
    for d in sorted(_glob.glob(f'{ROOT}/results/2026-11-06/*_cem_kr210-*-s[12]0[0-9]')):
        if not os.path.exists(f'{d}/demos.json'):
            continue
        rep = open(f'{d}/report.md', encoding='utf8').read()
        m = re.search(r'회수율 \(개수 / 질량\) \| \*\*([\d.]+)%\*\* / [\d.]+% \| \*\*([\d.]+)%\*\*', rep)
        dm = json.load(open(f'{d}/demos.json', encoding='utf8'))
        out.append(dict(config=dm['config'], seed=dm['seed'], cem=float(m.group(1)), rule=float(m.group(2)), n=len(dm['demos']), dir=os.path.basename(d)))
    return out


BR = b_runs()
BA = [r for r in BR if r['config'] == 'alone']
BP = [r for r in BR if r['config'] == 'push']
bmean = lambda rs, k: sum(r[k] for r in rs) / len(rs) if rs else float('nan')

# ---------------- 표지
doc.add_paragraph().paragraph_format.space_after = Pt(46)
t = doc.add_paragraph('RoboSim Lite v3.0.0', style='Title'); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('드로스 제거 AI 학습 기술 문서 (개정판)\n— 규칙 경로 · 진화 탐색 · PPO, 왜 하고 어떻게 연결되나 —'); r.font.size = Pt(15); r.bold = True
doc.add_paragraph().paragraph_format.space_after = Pt(20)
T([['항목', '내용'],
   ['판', f'개정판 {DOC_TIME} (이전 판 2026-11-06 08:45는 docs/2026-11-06_0845_AI학습_기술문서에 그대로 보존)'],
   ['바뀐 점', '세 방법(규칙 경로·진화 탐색·PPO)의 역할과 이유를 중심으로 다시 구성 / [A] 단계(측면 밀어 주기·쓸기 방향) 결과 / [B] 단계(시범 수집) 진행 상황 / 날짜·시각별 기록과 다른 PC 재현'],
   ['대상', '로봇 시뮬레이션/v3.0.0 (개발 중, 포트 8300) — 뼈대 v1.1.2'],
   ['기준 문서', 'PRD_v.3.0.0.md(결정 D1~D14, 1.1~1.4장), PROMPTS.md, results/README.md·INDEX.md, docs/README.md, SETUP.md 4-1장'],
   ['상태', f'[A] 완료. [B] 진행 중 — 작성 시점 {len(BR)}/16 에피소드 완료. [C]·[D] 예정. 목표 80%: 진화 탐색(시뮬레이터 안)은 도달, 현장용 정책은 미달'],
   ['주의', '모든 수치는 시뮬레이터(구형 입자 근사) 결과다. 실제 포트 결과가 아니다.']], widths=[3, 14])
doc.add_page_break()
H('목차')
p = doc.add_paragraph(); field(p, 'TOC \\o "1-2" \\h \\z \\u')
P('(Word에서 목차가 비어 보이면 목차를 오른쪽 클릭 → "필드 업데이트")', size=8.5)
doc.add_page_break()

# ---------------- 0. 요약
H('0. 한 장 요약')
NOTE(
    '• 목표: 스나우트 앞 작업 영역의 드로스를 10분 안에 80% 이상 회수하는 로봇 동작을 AI로 만들고, 실제 로봇에 적용할 수 있게 한다.\n'
    '• AI가 정하는 것: 한 번의 쓸기(스트로크)를 9개 값으로 — 시작점·방향·길이·스쿱 열린 면 방향(J6, 시작·끝)·기울임·깊이·속도. J1~J6 궤적은 기존 IK·경로 계획·안전 게이트가 만든다(계층형 B).\n'
    '• 세 가지 방법을 함께 쓴다:\n'
    '   ① 규칙 경로 = 기준. 정해진 규칙. 같은 조건에서 다른 방법이 정말 나은지 재는 잣대이자 안전한 대체 동작.\n'
    '   ② 진화 탐색(CEM) = 교사. 결정마다 시뮬레이터로 128번 미리 해 보고 최선만 실행. 시뮬레이터 안에서 가장 잘하지만 현장에서는 못 쓴다.\n'
    '   ③ PPO 정책 = 학생. 교사의 시범을 따라 배운 뒤 스스로 연습해 개선. 드로스 격자만 보고 1 ms 안에 결정 → 현장용.\n'
    f'• 지금까지(KR 210, 10분): 규칙 경로 61.3% → [A] 쓸기 방향 번갈아 {pct(am(AA))}, 측면 타이밍 밀기 {pct(am(M3))}. 진화 탐색은 [B] 단독 평균 {pct(bmean(BA, "cem"))} (작성 시점 {len(BA)}개). PPO 1차(규칙 교사) {pct(A_PPO)}.\n'
    '• 다음: [B] 시범 수집을 마치고 → [C] 진화 탐색 시범을 교사로 PPO 재학습(측면 셀 포함) → [D] 상부 가상 카메라.',
    fill='EAF3FB', title='요약')
IMGP('f02-roadmap.png', '전체 진행 흐름과 단계별 결과')
H('0.1 용어', 2)
T([['용어', '뜻'],
   ['드로스 · 회수율', '아연 위 찌꺼기(시뮬레이터: 지름 40~90 mm 구 160개) · 모든 박스에 들어간 개수 ÷ 작업 영역 초기 개수'],
   ['스트로크 · 사이클', '스쿱을 담가 한 번 쓸기 → 들기 → 박스에 쏟기 → 복귀. 10분에 11~15번'],
   ['에피소드 · 시드', '10분 과제 1회 · 드로스 배치를 만드는 난수 번호(같은 시드 = 같은 시작 배치)'],
   ['규칙 경로 (rule)', 'v1.1.2 방식: 드로스가 가장 많은 레인을 고정 방향·수평 스쿱으로 쓸기. [A]에서 쓸기 방향 옵션 추가'],
   ['진화 탐색 (CEM)', 'Cross-Entropy Method. 후보 32개 시도 → 상위 25%로 분포 갱신 × 4세대 → 최선 1개 실행'],
   ['PPO', 'Proximal Policy Optimization. 연습 경기 → 잘된 행동은 더 자주, 한 번에 조금씩 고치는 강화학습'],
   ['정책 · 체크포인트', '관측 → 행동을 내는 신경망 · 학습 중 저장한 신경망 파일'],
   ['시범 · 교사 · 모방 학습', '교사(진화 탐색)가 "이 분포면 이 스트로크"라고 남긴 기록 · 그 기록을 신경망이 따라 하게 하는 학습'],
   ['모드 1 · 2 · 3', '측면 로봇 역할: 각자 회수 · 잠금 밀기 · 타이밍 밀기(대형이 나가 있는 동안만 밀기, 대형만 회수)'],
   ['쓸기 방향', 'robot(열린 면이 로봇 쪽, 기존) · snout(열린 면이 스나우트 쪽) · alternate(번갈아)']], widths=[3.8, 13.2], font=8.5, bold_first_col=True)
doc.add_page_break()

# ---------------- 1. 문제
H('1. 풀려는 문제')
IMGP('f01-cell.png', '셀 평면도 — 회수율 기준 영역(파랑), 스트로크 상자(초록 점선), 측면 로봇 모드 1일 때 대형 구역(주황)')
B(['작업 영역(WORK_ZONE): X 1100~2300, Y ±900 mm. 스나우트 너머는 회수율에서 제외(D4).',
   'AI 로봇: 3대 중 1대 선택(D6). 지금은 대형(KR 210). 나머지는 규칙대로 함께 일한다.',
   '목표·시간: 기본 80%·600 s, 설정값(D3·D5).'])
IMGP('f14-baseline.png', '0단계 기준선: 규칙 경로만 (36회 중 80% 도달 0회)', 16)
doc.add_page_break()

# ---------------- 2. 세 방법
H('2. 세 가지 방법 — 무엇을, 왜 하나')
IMGP('f17-three-methods.png', '규칙 경로(기준) · 진화 탐색(교사) · PPO(학생)')
H('2.1 규칙 경로는 왜 하나', 2)
B([('비교 기준(가장 중요): ', '드로스 배치마다 난이도가 다르다(같은 규칙 경로가 시드에 따라 57~77%). 새 방법의 숫자만 보면 쉬운 배치라서인지 잘해서인지 모른다. 같은 시드로 규칙 경로를 함께 돌려 그 차이를 본다.'),
   ('안전한 대체 동작: ', 'PPO 정책이 낸 스트로크가 계획 불가능하면 실행기가 보정하고, 그래도 안 되면 규칙 레인으로 대신한다. 로봇이 멈추지 않게 하는 안전망이다.'),
   ('학습의 출발점: ', '진화 탐색 첫 세대 후보에 규칙 레인(과 [B]부터 반대 방향 규칙 레인)을 넣어 "최소한 규칙보다 나쁘지 않게" 한다. PPO 1차에서는 모방 학습의 교사였다.'),
   ('개선 실험의 대상: ', '[A] 단계에서 측면 로봇 역할과 쓸기 방향을 규칙으로 먼저 바꿔 보고 효과를 쟀다(번갈아 쓰기 +11.6%p). 학습 없이 확인할 수 있는 것은 규칙으로 먼저 확인한다.')])
H('2.2 진화 탐색은 왜 하나', 2)
B([('시뮬레이터 안의 상한 확인: ', '"이 셀·이 동작 자유도로 80%가 가능한가?"를 먼저 안다. [B]에서 단독 셀 85% 안팎 → 가능하다.'),
   ('좋은 시범 만들기(교사): ', '결정마다 "그때의 드로스 분포(관측)와 최선 스트로크"를 짝으로 남긴다. 이것을 PPO가 따라 배운다([C]).'),
   ('새 동작의 효과 검증: ', '열린 면을 돌리며 쓸기(J6), 스나우트 쪽으로 쓸기, 대각선 방향이 실제로 회수율을 올리는지 후보 시도로 확인한다.')])
H('2.3 진화 탐색은 왜 현장에서 못 쓰나', 2)
T([['이유', '설명'],
   ['포트 상태를 복사할 수 없다', '시뮬레이터는 드로스 160개의 정확한 위치·크기를 알아 복사본 세계를 만든다. 현장 카메라는 대략의 분포만 안다.'],
   ['실제 드로스는 다르게 움직인다', '시뮬레이터는 공 모양 근사. 실제는 점착·덩어리 → "미리 해 본 결과"가 실제와 어긋난다.'],
   ['너무 느리다', '결정 1번에 128번 시도 = Worker 14개로 10~15 s. 10분에 15번이면 기다림만 2~4분.'],
   ['실제 포트로는 미리 해 볼 수 없다', '실제 로봇으로 시도하면 그 자체가 작업이 된다.']], widths=[5, 12], font=8.5, bold_first_col=True)
H('2.4 PPO는 왜 하나', 2)
B(['카메라로 만들 수 있는 입력(드로스 격자 12×8 + 남은 비율 + 시간)만 보고 결정한다 → 현장에서 같은 입력을 만들면 그대로 쓴다.',
   '결정 시간 1 ms 미만, 파일 약 240 KB → 산업용 PC에서 ONNX로 실행 가능.',
   '교사를 따라 하는 데서 그치지 않고 스스로 연습(PPO)해 교사가 못 본 상황에도 대응하도록 다듬는다.'])
H('2.5 왜 같은 시드로 비교하고, 시드를 나누나', 2)
IMGP('f18-compare.png', '같은 시드로 비교하는 이유')
B(['평가용 시드 11·12·13은 학습·시범 수집에 쓰지 않는다. 배운 배치로 시험하면 실력을 부풀려 보게 되기 때문이다.',
   '시범 수집 시드: 단독 101~110, 측면 셀 201~206. PPO 연습 시드: 1000번대(에피소드마다 다름).'])
doc.add_page_break()

# ---------------- 3. 계층형 B
H('3. AI가 결정하는 것 — 계층형 B')
IMGP('f03-a-vs-b.png', '개념 A(순수 관절 직접)와 개념 B(계층형 + 관절 직접, 채택)')
IMGP('f04-b-flow.png', '한 번의 결정이 J1~J6 움직임이 되기까지 (①~⑨)')
IMGP('f05-stroke.png', '스트로크 9개 값 — 시작점·방향·길이·열린 면 방향(J6) 시작·끝·기울임·깊이·속도')
T([['항목', '기본값', '이유'],
   ['드로스 1개 회수', '+10', '목표 자체'],
   ['벽 띠(250 mm 안) 회수', '+5 추가', '규칙 경로가 못 치우는 벽·모서리 우대'],
   ['헛질 (0개)', '−20', '시간 낭비 (사용자: "헛질을 많이 하면 −")'],
   ['흘림 1개', '−5', '현장 안전·청소 부담'],
   ['경과 1 s', '−0.2', '같은 회수면 빠른 쪽'],
   ['계획 불가', '−10', '불가능한 행동 회피'],
   ['목표 도달', '+200', '목표를 넘기도록']], widths=[5.5, 2.3, 9.2], font=8.5, bold_first_col=True)
P('점수 규칙(보상)은 진화 탐색의 후보 순위와 PPO 학습의 방향을 정한다. 최종 비교는 항상 10분 회수율로 한다. 앱 "학습 (Trial & Error)" 패널에서 바꿀 수 있다(D14).', size=9.5)
doc.add_page_break()

# ---------------- 4. 규칙 경로 + [A]
H('4. 규칙 경로와 [A] 단계 개선 (2026-11-06)')
P('사용자 제안: ① 측면 로봇은 회수하지 않고 가운데로 밀어 주기만, 대형만 회수 ② 스쿱 열린 면이 스나우트 쪽을 보게 쓸어 스나우트 앞까지 회수하고, 들고 오는 동작까지 최적화.')
IMGP('a02-results.png', '[A] 결과: 쓸기 방향(왼쪽), 측면 로봇 역할(오른쪽) — 규칙 경로, 시드 11·12·13')
rows = [['조건', '평균 회수율', '대형 사이클', '흘림']]
for lab_, rs in [('단독 · 로봇 쪽 (기존)', AR), ('단독 · 스나우트 쪽만', AS), ('단독 · 번갈아', AA), ('측면 2대 · 모드 2 잠금 밀기', M2), ('측면 2대 · 모드 3 타이밍 밀기', M3)]:
    rows.append([lab_, f'**{pct(am(rs))}**', f"{am(rs, 'mainCycles'):.1f}", f"{am(rs, 'spilled'):.1f}"])
T(rows, widths=[7, 3.5, 3, 2.5], font=8.5)
H('4.1 스나우트 쪽 쓸기와 운반 동작', 2)
IMGP('a03-snout-stroke.png', '스윕 → 들어 올림 → 물러나기 → 천천히 돌리기(J6) → 운반')
B(['그대로 운반하면 손목이 크게 돌아 드로스가 튕겨 나갔다(2사이클 26~33개). 들어 올린 뒤 450 mm 물러나 30°/s로 180° 돌리고 운반한다. J6가 덜 감기는 회전 방향을 고른다.',
   '스나우트 쪽만 쓰면 사이클이 길어져 51.0%로 낮고, 번갈아 쓰면 두 끝을 모두 훑어 72.9%. 측면 로봇이 있는 셀에서는 규칙 경로의 이 동작이 측면 로봇과 19 mm까지 가까워져 쓰지 않는다 → 학습 단계에서 다룬다.'])
IMGP('a05-quat.png', '물리 엔진 회전 부호 버그 수정 — 스쿱을 돌릴 때 드로스가 튕기던 마지막 원인')
H('4.2 측면 로봇 모드 3: 타이밍 밀기', 2)
IMGP('a04-timing.png', '모드 2(잠금)와 모드 3(타이밍) — 측면은 대형이 돌아오기 전에 끝낼 수 있는 밀기만')
B(['처음 설계(공간 분리 동시 작업)는 대형 스쿱과 밀대 간격 30 mm로 서로 기다리다 멈추는 교착이 생겨 폐기했다(기록 0952 실행, NOTE.md).',
   '모드 3은 모드 2보다 4.2%p 높지만 대형 단독보다는 낮다. 대형이 밀어 준 자리를 골라 퍼 가는 것은 학습([C])의 몫이다.'])
doc.add_page_break()

# ---------------- 5. 진화 탐색 + [B]
H('5. 진화 탐색과 [B] 단계 시범 수집')
IMGP('f06-cem.png', '진화 탐색 한 번의 결정 (후보 32개 × 4세대 = 128번)')
B(['후보 평가: 지금 드로스를 복사한 물리 월드에서 한 사이클을 실제로 실행해 점수를 매긴다(후보당 약 1.3 s, Worker 14개 병렬).',
   '첫 세대: 규칙 레인 + 같은 레인을 스나우트 쪽으로 쓰는 후보([B]부터, 측면 로봇 없는 셀) + 절반은 그 근처 변형, 절반은 전체 무작위.',
   '1차(2026-11-05) 결과: KR 210 단독 시드 11·12에서 75.0%·75.6%(규칙 61.9%·56.9%), 측면 모드 1에서 52.5%(규칙 38.8%).'])
H('5.1 [B] 시범 수집 (진행 중)', 2)
P(f'목적: [C] PPO의 모방 학습 교사 데이터. 단독 셀 10개(시드 101~110) + 측면 타이밍 밀기 셀 6개(시드 201~206). 각 결정에서 관측(98개 숫자)과 최선 스트로크(9개 값, 0~1)를 짝으로 저장한다(demos.json). 비교 규칙 경로: 단독 = 번갈아([A] 최고), 측면 셀 = 로봇 쪽. 대형이 막히면 그 사이클만 버린다(--no-stop).')
IMGP('f19-b-demos.png', f'[B] 에피소드별 진화 탐색 vs 규칙 경로 (작성 시점 {len(BR)}/16)')
rows = [['구성', '시드', '진화 탐색', '규칙 경로', '차이', '시범 수', '결과 폴더 (results/2026-11-06/)']]
for r_ in BR:
    rows.append(['단독' if r_['config'] == 'alone' else '측면 밀기', str(r_['seed']), f"**{r_['cem']:.1f}%**", f"{r_['rule']:.1f}%", f"{r_['cem'] - r_['rule']:+.1f}%p", str(r_['n']), r_['dir']])
if BA:
    rows.append(['단독 평균', f'{len(BA)}개', f'**{pct(bmean(BA, "cem"))}**', pct(bmean(BA, 'rule')), f'{bmean(BA, "cem") - bmean(BA, "rule"):+.1f}%p', str(sum(r_['n'] for r_ in BA)), ''])
T(rows, widths=[2.2, 1.2, 2.2, 2.2, 1.8, 1.6, 5.8], font=8)
P('작성 시점에 끝난 에피소드만 표에 있다. 수집이 끝나면 전체 결과로 이 문서의 새 판을 만든다(덮어쓰지 않음).', size=9)
doc.add_page_break()

# ---------------- 6. PPO
H('6. PPO 강화학습')
H('6.1 PPO란', 2)
B(['지금 신경망으로 여러 번 해 본다(일부러 조금씩 다르게 = 탐험).',
   '각 시도가 평소 기대보다 좋았는지(이점, Advantage)를 계산한다.',
   '좋았던 행동은 더 자주, 나빴던 행동은 덜 자주 나오게 고친다. 한 번에 ±20% 넘게 바꾸지 않는다(클립 = "근접").'], style='List Number')
IMGP('f08-observation.png', '관측: 12×8 드로스 격자 + 남은 비율 + 시간 = 98개 숫자')
IMGP('f07-network.png', '정책 신경망 MLP 98 → 64 → 64 → 9')
IMGP('f09-ppo-loop.png', 'PPO 학습 절차 A~G')
IMGP('f10-iterations.png', '"40번 학습" = 같은 신경망을 40번 고쳐 쓴 것')
H('6.2 1차 학습 결과 (2026-11-05, 교사 = 규칙 경로)', 2)
IMGP('f11-curve.png', '학습 곡선 — 모방 직후 39.4% → PPO 40회 71.9%(학습 환경)')
IMGP('f12-runner.png', '정책 실행기 안전장치와 고친 버그')
IMGP('f13-results.png', '전체 셀 10분 과제: 규칙 · PPO 1차 · 진화 탐색 1차')
rows = [['구성', 'PPO 1차 평균', '규칙 경로 평균', '차이']]
rows.append(['대형 단독', f'**{pct(A_PPO)}**', pct(A_RULE), dp(A_PPO, A_RULE)])
rows.append(['측면 모드 1', f'**{pct(M_PPO)}**', pct(M_RULE), dp(M_PPO, M_RULE)])
rows.append(['측면 모드 2 (2026-11-06 측정)', '**56.7%**', '53.3%', '+3.4%p'])
T(rows, widths=[6, 3.5, 3.5, 3], font=8.5)
B(['1차의 약점: 교사가 규칙 경로(60%)라 모방 직후 39%로 오히려 낮게 출발했다(규칙이 레인을 좌·우 끝에서 번갈아 골라, 평균을 배운 신경망이 가운데를 고름). 측면 셀에서는 학습한 적 없는 상황이라 약하다.'])
H('6.3 [C] 재학습 계획', 2)
T([['바꾸는 것', '1차', '[C]'],
   ['교사', '규칙 경로 (약 60%)', '진화 탐색 시범 ([B], 단독 85% 안팎)'],
   ['연습 셀', '대형 단독만', '단독 + 측면 타이밍 밀기 (에피소드마다 섞음)'],
   ['동작', '로봇 쪽 위주', '스나우트 쪽 쓸기·담은 채 돌리기 포함 (충돌 검사 통과한 것만)'],
   ['중간 저장', '최고·마지막만', '5회마다 checkpoints/iter-NNN.json'],
   ['평가', '시드 11·12·13', '같은 시드로 규칙 · 진화 탐색 · PPO 나란히']], widths=[3.5, 5.5, 8], font=8.5, bold_first_col=True)
doc.add_page_break()

# ---------------- 7. 결과 종합
H('7. 결과 종합 (KR 210, 10분, 작성 시점)')
T([['방법', '조건', '회수율', '현장 사용', '근거 폴더 (results/)'],
   ['규칙 경로 (기존)', '단독', '61.3%', '가능', '2026-11-05/1541_baseline_… · 2026-11-06/1022_…'],
   ['규칙 경로 (번갈아)', '단독', f'{pct(am(AA))}', '가능', '2026-11-06/1022_baseline_kr210_alone_lane-dir'],
   ['규칙 경로 + 모드 3', '측면 2대', f'{pct(am(M3))}', '가능', '2026-11-06/1022_baseline_kr210_mode2-vs-push'],
   ['진화 탐색 1차', '단독 (시드 11·12)', '75.0~75.6%', '불가', '2026-11-05/1552·1602_cem_…'],
   ['진화 탐색 [B]', f'단독 (시드 101~, {len(BA)}개)', pct(bmean(BA, 'cem')) if BA else '—', '불가', '2026-11-06/*_cem_kr210-alone-s1xx'],
   ['PPO 1차', '단독 (시드 11·12·13)', pct(A_PPO), '가능', '2026-11-05/1814_ppo-train_kr210-run1 · 2026-11-06/0836_…']], widths=[3.6, 3.6, 2.2, 1.8, 5.8], font=8)
P('해석: 시뮬레이터 안에서는 80%가 가능하다(진화 탐색). 남은 과제는 그 수준을 현장에서 쓸 수 있는 PPO 정책으로 옮기는 것이다.', size=9.5)

# ---------------- 8. 기록·재현
H('8. 결과·문서 기록과 다른 PC에서 재현')
IMGP('f16-results-tree.png', '날짜·시각별 기록 구조')
B([('덮어쓰지 않는다: ', '명령을 실행할 때마다 results/<날짜>/<시각>_<종류>_<이름>/ 새 폴더 + run.json(명령·시각·git 커밋·Node 버전) + results/INDEX.md 한 줄(자동).'),
   ('문서도 판마다 새 폴더: ', 'docs/<날짜>_<시각>_<제목>/ 안에 docx · images · build(그 문서를 만든 스크립트). 이 문서도 이전 판을 그대로 두고 새로 만들었다.'),
   ('git: ', '커밋 메시지 앞에 [날짜 시각 KST]. 3D 재생 파일(.rsim.json.gz)·진화 탐색 시도 기록(log.json)까지 모두 저장소에 있다(2026-11-06부터).'),
   ('다른 PC: ', 'git clone → Node 18+ · Python 3.8+ → v3.0.0에서 node tests/run-all.mjs(13종) → start.bat → 에피소드 재생으로 모든 결과를 3D로 확인. 문서 다시 만들기: pip install -r v3.0.0/docs/requirements.txt (SETUP.md 4-1장).')])
T([['하고 싶은 것', '명령 (v3.0.0 폴더)'],
   ['규칙 경로 측정', 'node tools/baseline.mjs --mains kuka-kr210-r2700 --configs alone,push --lane-dir robot,alternate'],
   ['진화 탐색 10분 1회', 'node tools/train.mjs --config alone --seed 11 --population 32 --iterations 4'],
   ['[B] 시범 수집', 'node tools/cem-demos.mjs --alone 101-110 --push 201-206'],
   ['PPO 학습', 'node tools/ppo-train.mjs --iterations 40 --bc 3 --workers 14 --name run2'],
   ['정책 평가', 'node tools/ppo-eval.mjs --policy results/2026-11-05/1814_ppo-train_kr210-run1/policy-best.json --config push'],
   ['3D 재생 파일 1개', 'node tools/episode.mjs --config push --seed 11']], widths=[3.5, 13.5], font=8)
doc.add_page_break()

# ---------------- 9. 한계·다음·현장
H('9. 한계와 다음 단계')
B(['80%는 아직 시뮬레이터 안 진화 탐색만 도달. 현장용 정책(PPO)은 미달.',
   '시뮬레이터 드로스는 구형 입자 근사 — 실제(점착·덩어리)와 차이가 가장 크다(sim-to-real).',
   '측면 로봇 셀에서 규칙 경로의 스나우트 쪽 쓸기는 측면 로봇과 가까워 막힌다(원인 미확정) → 학습 단계에서 충돌 검사로 거른다.',
   '관측은 아직 시뮬레이터 정답 입자 위치 기반 → [D]에서 상부 가상 카메라(가림·잡음)로 바꾸고 전후 차이를 측정한다.',
   '앱 화면의 측면 로봇 모드 선택에는 모드 3이 아직 없다(헤드리스·3D 재생으로 확인).'])
IMGP('f15-hardware.png', '현장 적용 구성과 단계 H0~H5 (PRD 9장)')

H('부록 A. 코드 지도 (v3.0.0)')
T([['파일', '역할'],
   ['js/cell-sim.js', '헤드리스 셀 시뮬레이터 runEpisode, 규칙 운전기(쓸기 방향, 측면 대기 장애물), mainChooser'],
   ['js/cell-robot.js', '측면 로봇 모드 1·2·3, 조정기(잠금·타이밍 밀기 etaS)'],
   ['js/dross.js', '셀 상수, planSkimCycle(스나우트 쪽 쓸기의 물러나기·돌리기 포함), PUSH_ASSIST'],
   ['js/physics.js', 'Rapier 래퍼, continuousRot(회전 부호 연속성)'],
   ['js/stroke-lab.js', '스트로크 변수·점수·후보 평가·진화 탐색(반대 방향 규칙 후보)·StrokeEnv·정책 실행기·시범 기록'],
   ['js/ppo.js', '순수 JS 신경망·PPO·GAE·모방 학습·정책 파일'],
   ['tools/baseline · train · cem-demos · ppo-train · ppo-eval · episode .mjs', '헤드리스 도구 (8장 표)'],
   ['tools/lib/run-dir.mjs · policy-eval.mjs', '날짜·시각 실행 폴더·INDEX · 정책 전체 셀 평가'],
   ['tests/run-all.mjs (13종), tests/push-lane.mjs, tests/cell-robots.mjs', '검증']], widths=[6.5, 10.5], font=8.5)
H('부록 B. 결정 기록')
T([['#', '결정'],
   ['D1·D2', 'J1~J6 전 관절, 계층형 B 먼저 (A는 비교 후보)'],
   ['D3~D7', '목표·시간 설정값(80%·600 s), 작업 영역 기준, AI 로봇 선택, 회수율 = 셀 합계'],
   ['D11~D14', '강화학습 기반·최선만 채택, 3D 재생, 순수 JS 학습 엔진, 학습 설정 창'],
   ['2026-11-06', '측면 로봇은 밀어 주기만·대형만 회수 / 스쿱 열린 면 반대 방향 회수 / 결과·문서 날짜·시각별 기록 / 3D 재생 파일까지 git (다른 PC 재현)']], widths=[2.4, 14.6], font=8.5)

doc.save(OUT)
print('saved', OUT, 'figures', FIG[0], 'B runs', len(BR))
