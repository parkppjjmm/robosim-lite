# RoboSim Lite v3.0.0 — AI 학습 기술 문서 개정 4판 (Word) 생성, 2026-11-06 15:29 (13:59 개정 3판 스크립트 + 11장 앱·train.bat 사용법 usage.py)
# 스크린샷 images/s01~s11 = build/capture/shots.mjs(앱)·term.mjs(train.bat 콘솔)로 촬영. figures.py는 f*.png만 만든다.
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


fp.add_run('RoboSim Lite v3.0.0 · AI 학습 기술 문서 개정 4판 (2026-11-06 15:29) — ').font.size = Pt(8)
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

DOC_STAMP = '2026-11-06 15:29'
# =============================================================== 개정 3판 본문 ([C] 결과·질문 답변 보강)
import glob as _g2
_cands = sorted(_g2.glob(f'{ROOT}/results/2026-11-0*/*_pipeline_kr210-run2/run.json'))
CRUN = json.load(open(_cands[-1], encoding='utf8')) if _cands else None
CDIR = os.path.dirname(_cands[-1]).replace(chr(92), '/').split('/results/')[-1] if _cands else '—'
CTRAIN = CRUN['train'] if CRUN else '—'
C_CURVE = json.loads(read(f'{CTRAIN}/train-curve.json')) if CRUN else []
C_BEST = json.loads(read(f'{CTRAIN}/policy-best.json')) if CRUN else {}
C_PPO = CRUN.get('ppo', []) if CRUN else []
C_CEM = CRUN.get('cem', []) if CRUN else []
cm = lambda rs, k: sum(r[k] for r in rs) / len(rs) if rs else float('nan')
C_EV = [e for e in C_CURVE if e['phase'] == 'eval']

import glob as _glob
DOC_TIME = DOC_STAMP  # 빌드 시각 (make_docx.py 인자)
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
    for d in sorted(_glob.glob(f'{ROOT}/results/2026-11-06/*_cem_kr210-*-s[12][0-9][0-9]')):
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
r = p.add_run('드로스 제거 AI 학습 기술 문서 (개정 4판)\n— 규칙 경로 · 진화 탐색 · PPO, 원리와 결과 —'); r.font.size = Pt(15); r.bold = True
doc.add_paragraph().paragraph_format.space_after = Pt(20)
T([['항목', '내용'],
   ['판', f'개정 4판 {DOC_TIME} (이전 판: 08:45 첫 판, 11:15 개정판, 13:59 개정 3판 — docs/ 아래 그대로 보존)'],
   ['4판에서 바뀐 점', '11장 신설: 앱(start.bat)과 train.bat으로 학습·평가하고 결과 보기 — 실제 화면 스크린샷 11장, 버튼별로 무엇이 어디에 생기는지, 결과 폴더 파일 설명, 막힐 때. 10장 한계 갱신(앱 모드 3 반영됨), 자주 묻는 질문은 12장'],
   ['3판에서 바뀐 점', '[B] 완료(시범 138개) / [C] 2차 PPO 10회 결과(규칙·진화 탐색·PPO 같은 시드 비교) / 진화 탐색 후보 시험 순서·설계값과 궤적 / 모방 직후의 뜻·학습 구조 / 1차 vs 2차 PPO와 행동 형식 변경 이유 / 학습 파이프라인 도구 / 평가(테스트) 과정과 시드 11·12·13의 의미(7장) / 자주 묻는 질문(12장)'],
   ['대상', '로봇 시뮬레이션/v3.0.0 (릴리스 준비, 포트 8300) — 뼈대 v1.1.2. 검토 REVIEW_v3.0.0.md, 현황 STATUS.md'],
   ['기준 문서', 'PRD_v.3.0.0.md(결정 D1~D14, 1.1~1.4장), PROMPTS.md, results/README.md·INDEX.md, docs/README.md, SETUP.md 4-1장'],
   ['상태', f'[A]·[B]·[C(10회)] 완료. 측면 로봇 셀 학습은 사용자 결정으로 다음 단계. 2차 PPO 실제 셀 평균 {pct(cm(C_PPO, "ppo"))} (목표 80%)'],
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
    f'• 지금까지(KR 210 단독, 10분): 규칙 경로 61.3% → [A] 번갈아 쓰기 {pct(am(AA))}. 진화 탐색 [B] 평균 {pct(bmean(BA, "cem"))}(10개). PPO 1차(규칙 교사) {pct(A_PPO)} → '
    f'2차(진화 탐색 교사, 10회) 실제 셀 {pct(cm(C_PPO, "ppo"))} — 같은 시드에서 규칙 경로 {pct(cm(C_PPO, "rule"))}, 진화 탐색 {pct(cm(C_CEM, "cem"))}.\n'
    '• 다음: 결과를 보고 2차 PPO를 더 학습할지 결정 → 측면 로봇 셀 → [D] 상부 가상 카메라.',
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
H('5.0 원리 — 후보를 많이 만들어 미리 해 보고, 잘된 것 근처에서 다시', 2)
P('진화 탐색(CEM, Cross-Entropy Method)은 대형 로봇이 다음 스트로크를 정할 때마다, 지금 포트 상태를 그대로 복사한 가상 세계에서 후보를 여러 개 실제로 돌려 보고 '
  '점수가 좋은 후보들 근처에서 다시 후보를 뽑기를 반복해 최선을 찾는다. 좋은 개체만 살아남아 다음 세대를 만드는 생물 진화와 닮아 "진화 탐색"이라 부른다. '
  '정식 이름은 "상위 후보를 가장 잘 설명하는 확률 분포로 고쳐 맞추는 계산"(교차 엔트로피를 줄이는 것과 같음)에서 왔다.')
IMGP('f20-cem-candidate.png', '후보 하나를 시험하는 순서: 설계값 → 경로 계획 → 안전 검사 → 복사한 세계에서 실행 → 점수')
H('5.0.1 후보는 궤적(trajectory)이 아니라 설계값 9개다', 2)
T([['', '설계값 9개를 뽑음 (채택)', '궤적을 직접 뽑으면'],
   ['뽑는 대상', '시작 X·Y, 방향, 길이, 열린 면 시작·끝(J6), 기울임, 깊이, 속도', 'J1~J6 6개 관절 × 수백 시점'],
   ['궤적', '기존 경로 계획기(IK·RRT)가 설계값에서 만든다', '탐색이 직접 만든다'],
   ['물리적 가능성', '계획기가 충돌·도달·특이점을 검사 → 불가능하면 감점하고 다음 후보', '무작위로 뽑으면 거의 다 충돌·불가능'],
   ['탐색 공간', '작다 → 128번 시도로 좋은 영역에 도달', '너무 크다 → 수만 번 시도해도 어려움'],
   ['안전', '실행 전에 기존 안전 게이트를 반드시 통과 (계층형 B)', '별도 안전 필터가 필요']], widths=[3, 7.5, 6.5], font=8.3, bold_first_col=True)
P('그래서 "후보 32개를 시뮬레이터로 해 본다" = 설계값 32개를 각각 궤적으로 만들어 복사한 물리 세계에서 실행해 본다는 뜻이다. '
  '상위 8개 설계값의 평균·퍼진 정도로 다음 세대 32개를 뽑고, 4세대(128번) 뒤 최고 1개만 실제로 실행한다. 10분 과제 동안 이 결정을 약 14번 한다.', size=9.5)
B(['후보 평가: 지금 드로스를 복사한 물리 월드에서 한 사이클을 실제로 실행해 점수를 매긴다(후보당 약 1.3 s, Worker 14개 병렬).',
   '첫 세대: 규칙 레인 + 같은 레인을 스나우트 쪽으로 쓰는 후보([B]부터, 측면 로봇 없는 셀) + 절반은 그 근처 변형, 절반은 전체 무작위.',
   '1차(2026-11-05) 결과: KR 210 단독 시드 11·12에서 75.0%·75.6%(규칙 61.9%·56.9%), 측면 모드 1에서 52.5%(규칙 38.8%).'])
H('5.1 [B] 시범 수집 (완료)', 2)
P(f'목적: [C] PPO의 모방 학습 교사 데이터. 대형 단독 셀 10개(시드 101~110). 각 결정에서 관측(98개 숫자)과 최선 스트로크(9개 값, 0~1)를 짝으로 저장한다(demos.json). 비교 규칙 경로: 단독 = 번갈아([A] 최고), 측면 셀 = 로봇 쪽. 대형이 막히면 그 사이클만 버린다(--no-stop).')
IMGP('f19-b-demos.png', f'[B] 에피소드별 진화 탐색 vs 규칙 경로 (대형 단독 {len(BR)}개)')
rows = [['구성', '시드', '진화 탐색', '규칙 경로', '차이', '시범 수', '결과 폴더 (results/2026-11-06/)']]
for r_ in BR:
    rows.append(['단독' if r_['config'] == 'alone' else '측면 밀기', str(r_['seed']), f"**{r_['cem']:.1f}%**", f"{r_['rule']:.1f}%", f"{r_['cem'] - r_['rule']:+.1f}%p", str(r_['n']), r_['dir']])
if BA:
    rows.append(['단독 평균', f'{len(BA)}개', f'**{pct(bmean(BA, "cem"))}**', pct(bmean(BA, 'rule')), f'{bmean(BA, "cem") - bmean(BA, "rule"):+.1f}%p', str(sum(r_['n'] for r_ in BA)), ''])
T(rows, widths=[2.2, 1.2, 2.2, 2.2, 1.8, 1.6, 5.8], font=8)
P('측면 로봇 셀(시드 201~206) 수집은 사용자 결정(2026-11-06: 대형 단독 먼저)으로 단독 10개 뒤 멈췄다. 시범 모음: results/2026-11-06/1251_cem-demos_kr210-alone10/demos.json (138개, 기준 레인을 찾을 수 있는 135개를 학습에 사용).', size=9)
doc.add_page_break()

# ---------------- 6. PPO
H('6. PPO 강화학습')
H('6.0 PPO 학습 한 번의 구조 — "모방 직후"란', 2)
IMGP('f21-learning-structure.png', '교사 시범 → ① 모방 학습 → 모방 직후 시험 → ② PPO 반복 → 5회마다 시험 → 최고 모델')
B([('모방 학습: ', '교사의 시범("이 드로스 분포 → 이 스트로크")을 정답으로 두고 신경망이 그대로 따라 하게 한다. 시뮬레이터에서 시도하지 않고 기록만 보고 배운다(몇 초).'),
   ('모방 직후: ', '모방 학습만 끝나고 강화학습을 한 번도 하지 않은 상태. 이때 평가 시드 11·12·13에서 무작위 없이 돌린 성적이 "모방 직후 시험" = PPO의 시작점이다.'),
   ('강화학습(PPO): ', '시작점에서 연습 경기를 직접 치르며 점수가 오른 행동은 더 자주, 떨어진 행동은 덜 자주 나오게 고친다. 반복 1회 = 연습 경기 14개 → 수정(약 2.5분).'),
   ('시험: ', '5회마다 같은 방법(평가 시드, 무작위 없음)으로 성적을 재고 지금까지 최고면 policy-best.json으로 저장. 연습 경기는 일부러 흔들어 시도하므로 시험보다 낮게 나온다.')])
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
H('6.3 2차 PPO: 무엇을 바꿨나 — 교사와 행동 형식', 2)
T([['', '1차 (2026-11-05)', '2차 [C] (2026-11-06)'],
   ['교사', '규칙 경로 (약 60%)', '진화 탐색 시범 135개 (수집 평균 84.9%)'],
   ['정책이 고르는 것', '스트로크 9개 값을 처음부터 전부', '규칙 레인 기준: 반대 방향 여부 + 조정 4개 + 열린 면·기울임·깊이·속도 = 10개'],
   ['정책이 보는 것', '드로스 격자 + 남은 비율 + 시간 (98)', '+ 직전 스트로크 방향·시작 위치 (102)'],
   ['모방 직후 시험', '39.4%', f"{C_EV[0]['rate']:.1f}%" if C_EV else '—'],
   ['강화학습 후 (연습장 시험 최고)', '71.9% (40회째)', (f"{max(C_EV, key=lambda e: e['ret'])['rate']:.1f}% (" + str(max(C_EV, key=lambda e: e['ret'])['iter']) + '회째)') if C_EV else '—'],
   ['실제 셀 10분 (시드 11·12·13)', pct(A_PPO), pct(cm(C_PPO, 'ppo'))]], widths=[4.2, 5.4, 7.4], font=8.3, bold_first_col=True)
IMGP('f22-residual.png', '2차 PPO의 행동: 규칙 레인을 기준으로 반대 방향 여부와 조정량을 고른다')
H('6.3.1 왜 행동 형식을 바꿨나 (시행착오 기록)', 2)
T([['시도', '모방 직후 (연습장, 시드 11·12·13)', '문제'],
   ['9개 값 직접 + 진화 탐색 교사', '33% / 20% / — (계획 불가 다수)', '진화 탐색은 같은 분포에서 정반대 답(로봇 쪽 2070→ / 스나우트 쪽 1330→)을 자주 낸다 → 평균(대각선, 앞벽 충돌)을 배움'],
   ['+ 직전 스트로크 입력', '37.5% / 8.1% / 0%', '"번갈아" 정보는 생겼지만 9개 값을 처음부터 맞추기에는 시범 135개가 적다'],
   ['규칙 레인 기준 조정 (채택)', '68.8% / 62.5% / 70.6%, 계획 불가 0', '조정 0이면 규칙 경로 → 크게 망가지지 않음. 시범의 47%가 규칙 레인 또는 그 반대 그대로라 배우기 쉬움']], widths=[4.5, 5, 7.5], font=8.2)
P('미리 점검한 신경망과 실제 학습의 신경망은 초기값·학습 순서가 달라 모방 직후 값이 조금 다르다(점검 평균 67%, 실제 학습 61.9%). 같은 설정이면 같은 결과가 나온다(재실행으로 확인).', size=9)
H('6.3.2 2차가 5회 만에 1차 40회 수준에 온 이유', 2)
B(['더 좋은 교사: 규칙 경로(약 60%) 대신 진화 탐색(약 85%)을 따라 했다 → 시작점이 높다.',
   '덜 망가지는 출발점: 1차는 모방 직후 39%로 교사(60%)보다도 낮아 PPO가 40회 동안 회복에 시간을 썼다. 2차는 규칙 레인 기준이라 출발부터 규칙 수준 이상이다.',
   '번갈아 쓰기를 배울 수 있음: 직전 스트로크를 입력으로 받는다.',
   '남은 약점이 작음: 모방 직후의 계획 불가(평균 11.3회)는 −10점 감점이라 PPO가 빨리 고쳤다(5회째 0회).'])
H('6.4 [C] 결과 — 2차 PPO 10회', 2)
IMGP('f23-run1-vs-run2.png', '1차 PPO(40회)와 2차 PPO(10회)의 시험 회수율 (연습장)')
rows = [['시점', '시험 회수율', '헛질', '보정', '계획 불가']]
for e in C_EV:
    rows.append(['모방 직후' if e['iter'] == 0 else f"PPO {e['iter']}", f"{e['rate']:.1f}%", f"{e['empties']:.1f}", f"{e['repaired']:.1f}", f"{e['infeasible']:.1f}"])
T(rows, widths=[4, 3.5, 2.5, 2.5, 3], font=8.5)
IMGP('f24-c-results.png', '실제 셀 시뮬레이터 10분 과제: 규칙 경로 · 진화 탐색 · 2차 PPO (같은 시드)')
rows = [['시드', '규칙 경로 (번갈아)', '진화 탐색 (교사)', 'PPO 2차', 'PPO − 규칙']]
for r_ in C_PPO:
    cc = next((x for x in C_CEM if x['seed'] == r_['seed']), None)
    rows.append([str(r_['seed']), pct(r_['rule']), pct(cc['cem']) if cc else '—', f"**{pct(r_['ppo'])}**", dp(r_['ppo'], r_['rule'])])
if C_PPO:
    rows.append(['평균', pct(cm(C_PPO, 'rule')), pct(cm(C_CEM, 'cem')), f"**{pct(cm(C_PPO, 'ppo'))}**", dp(cm(C_PPO, 'ppo'), cm(C_PPO, 'rule'))])
T(rows, widths=[2, 3.8, 3.8, 3.2, 3.2], font=8.5)
B([f'결과 폴더: results/{CDIR} (비교 보고서), {CTRAIN} (정책 policy-best.json, 학습 기록, 3D 재생 ppo-alone-s<시드>·rule-alone-s<시드>)',
   '연습장 시험 값과 실제 셀 값은 다르다. 연습장은 대형 로봇과 드로스만 있고 스트로크 단위로 바로 다음 결정을 하며, 실제 셀은 60 Hz 셀 루프와 정책 실행기 안전장치(보정·규칙 대체)를 거친다.'])
H('6.5 다음 학습을 정할 때 볼 것', 2)
B(['더 학습(반복 추가): 이번 정책(policy-last.json)에서 이어서 학습할 수 있다. 시험 곡선이 아직 오르는 중이면 효과가 있다.',
   '시범 늘리기: 진화 탐색 시드를 더 돌려(예: 111~130) 시범을 늘리면 모방 직후 성적과 안정성이 오른다.',
   '측면 로봇 셀: 대형 단독 결과를 확인한 뒤 진행(사용자 결정).'])
doc.add_page_break()

# ---------------- 7. 평가(테스트) 과정
doc.add_page_break()
H('7. 평가(테스트) 과정 — 무엇을, 어떤 조건에서, 어떻게 쟀나')
H('7.1 시드(seed)와 평가 시드 11·12·13', 2)
P('시드는 드로스를 포트에 뿌리는 배치를 정하는 난수 번호다. 번호 자체에 의미는 없고, 번호마다 서로 다른 초기 배치(= 시험 문제) 하나가 만들어진다. '
  '시드가 정하는 것: 드로스 160개 각각의 위치(X·Y), 크기(지름 40~90 mm)와 무게, 벽 근처 띠(벽에서 350 mm 안)에 60%를 몰아 둘 때 어느 벽에 얼마나 몰릴지, 표시 색. '
  '같은 시드면 몇 번을 돌려도, 어느 PC에서 돌려도 같은 배치가 나온다(결정적 실행). 그래서 같은 시드끼리 방법을 비교하면 배치 난이도의 영향을 빼고 방법의 차이만 볼 수 있다.')
IMGP('f25-seeds.png', '평가 시드 11·12·13의 초기 드로스 배치 (위에서 본 모습)')
_ar = {r['seed']: r['summary']['rateCount'] for r in AR}
_aa = {r['seed']: r['summary']['rateCount'] for r in AA}
_p1 = {r['seed']: r['ppo'] for r in EA}
_ce = {r['seed']: r['cem'] for r in C_CEM}
_p2 = {r['seed']: r['ppo'] for r in C_PPO}
rows = [['시드', '규칙 경로 (기존, 로봇 쪽)', '규칙 경로 (번갈아)', '진화 탐색', 'PPO 1차', 'PPO 2차', '배치 성격 (결과로 본 난이도)']]
_desc = {11: '벽 띠 드로스 98개. 규칙 번갈아가 특히 잘 맞음(78%)', 12: '벽 띠 드로스 104개(가장 많음). 규칙·PPO는 낮고 진화 탐색만 84%', 13: '벽 띠 드로스 94개(가장 적음). 비교적 쉬움'}
for sd in [11, 12, 13]:
    g = lambda dct: pct(dct[sd]) if sd in dct else '—'
    rows.append([str(sd), g(_ar), g(_aa), g(_ce), g(_p1), f'**{g(_p2)}**', _desc[sd]])
T(rows, widths=[1.2, 2.6, 2.3, 2.0, 1.8, 1.8, 5.3], font=8)
T([['시드', '용도', '이유'],
   ['11 · 12 · 13', '평가 전용 (학습·시범에 절대 쓰지 않음)', '학습에 쓴 배치로 시험하면 문제를 미리 본 셈 → 실력이 부풀려 보인다'],
   ['101 ~ 110', '[B] 진화 탐색 시범 수집', 'PPO 교사 데이터. 평가 시드와 겹치지 않게'],
   ['1000번대', 'PPO 연습 경기 (반복마다 새 배치 14개)', '다양한 배치를 겪어야 처음 보는 배치에도 맞춘다'],
   ['201 ~ 206', '측면 로봇 셀 시범 (미실행, 다음 단계)', '사용자 결정으로 대형 단독 먼저']], widths=[2.6, 6, 8.4], font=8.3, bold_first_col=True)
P('한계: 평가 시드가 3개라 숫자가 크게 출렁인다(예: 2차 PPO 연습장 시험 5회째 71.3% → 10회째 62.3%). 더 정확히 보려면 평가 시드를 10개 안팎으로 늘린다(다음 학습 때 결정).', size=9)

H('7.2 공통 조건', 2)
T([['항목', '값'],
   ['로봇·셀', 'KUKA KR 210 R2700 (대형) 단독, 측면 로봇 없음'],
   ['과제', '10분(시뮬레이션 600 s), 목표 80%, 작업 영역(스나우트 앞 X 1100~2300, Y ±900) 드로스 160개, 추가 발생 없음'],
   ['회수율', '모든 박스에 들어간 드로스 개수 ÷ 작업 영역 초기 드로스 개수 (셀 합계, PRD D7). 스나우트 너머 드로스는 제외'],
   ['물리', 'Rapier, 60 Hz. 드로스는 구형 입자 근사 + 부력·점성 (실제 점착·덩어리와 다름)'],
   ['안전', '모든 로봇 움직임은 실행 전에 안전 게이트(자기 충돌·설비 충돌·특이점) 통과'],
   ['결정성', '같은 시드·같은 모델·같은 명령이면 같은 결과 (경로 계획 후처리는 반복 횟수 고정). 재실행으로 확인']], widths=[2.6, 14.4], font=8.3, bold_first_col=True)

H('7.3 시험 1 — 연습장 시험 (PPO 학습 중, 5회마다)', 2)
B(['어디서: 연습장(StrokeEnv). 대형 로봇과 드로스만 있는 단순화된 셀. 스트로크 하나를 실행하면 바로 다음 결정으로 넘어간다(빠름).',
   '어떻게: 그 시점의 신경망을 무작위 흔들림 없이(평균 행동) 시드 11·12·13에서 10분씩 실행. 결정 최대 40번.',
   '무엇을: 회수율, 보상, 스트로크 수, 헛질(0개 회수), 보정(그대로는 계획 불가라 실행기가 고친 수), 계획 불가.',
   '용도: 학습이 잘 되는지 보고, 시험 보상이 가장 높은 시점의 신경망을 policy-best.json으로 고른다(최종 채택 모델 선택).',
   '주의: 연습 경기(학습용)의 회수율은 일부러 흔들어 시도하므로 시험보다 낮게 나온다 — 실력은 시험 값으로 본다.'])

H('7.4 시험 2 — 실제 셀 10분 평가 (최종 성적)', 2)
B(['어디서: 전체 셀 시뮬레이터(runEpisode). 앱과 같은 60 Hz 셀 루프 — 대형 로봇 안전 게이트 → 물리, 사이클 동작(접근·하강·스윕·들기·물러나 돌리기·운반·덤프·복귀)을 실제 시간대로 실행.',
   '모델: policy-best.json (2차는 5회째). 결정적 행동.',
   '정책 실행기 안전장치: 정책이 낸 스트로크가 계획 불가면 보정(k1: 시작점을 상자 안으로·회전 절반, k2: 회전 0), 그래도 안 되면 그 결정만 규칙 레인으로 대체(표의 "규칙 대체").',
   '비교: 같은 시드·같은 셀에서 대형 로봇만 규칙 경로(쓸기 방향 번갈아 = [A] 최고)로 바꿔 한 번 더 실행.',
   '결과물: cell-eval-alone.md(표), ppo-alone-s<시드>.rsim.json.gz·rule-alone-s<시드>.rsim.json.gz(3D 재생).'])

H('7.5 시험 3 — 같은 시드의 진화 탐색 (교사의 상한)', 2)
B(['어디서: 실제 셀 시뮬레이터. 대형 로봇이 결정할 때마다 후보 32개 × 4세대 = 128번을 복사한 세계에서 시도하고 최고 1개를 실행(5장).',
   '용도: "같은 배치에서 시뮬레이터로 미리 해 보면 어디까지 가능한가" = PPO가 따라잡을 목표. 현장에서는 쓸 수 없다.',
   '결과물: results/<날짜>/<시각>_cem_kr210-alone-s1x/ (report.md, log.json, cem-·rule-…rsim.json.gz).'])

H('7.6 지표와 읽는 법', 2)
T([['지표', '뜻', '좋은 방향'],
   ['회수율', '박스에 넣은 개수 ÷ 초기 개수 (개수 기준, 질량 기준도 기록)', '높을수록'],
   ['스트로크 수', '10분 동안 쓸기 사이클 수', '많을수록 빠름 (단 헛질이면 소용 없음)'],
   ['헛질', '0개 회수 스트로크', '적을수록'],
   ['보정 · 규칙 대체', '정책 출력이 그대로는 계획 불가라 실행기가 고치거나 규칙 레인으로 바꾼 횟수', '적을수록 (정책이 가능한 동작을 냄)'],
   ['흘림', '포트 밖·바닥으로 떨어진 드로스', '적을수록'],
   ['같은 시드 차이', 'PPO − 규칙 경로 (%p)', '+이면 규칙보다 나음']], widths=[3, 9.5, 4.5], font=8.3, bold_first_col=True)

H('7.7 재현 방법 (다른 PC 포함)', 2)
T([['재현할 것', '명령 (v3.0.0 폴더)'],
   ['[C] 전체 (시범 → PPO → 평가 → 진화 탐색 → 보고서)', 'node tools/pipeline.mjs --demos results/2026-11-06/1251_cem-demos_kr210-alone10/demos.json --name run2 --iterations 10 --bc 3 --workers 14 --rule-lane-dir alternate'],
   ['실제 셀 평가만 (모델 하나)', f'node tools/ppo-eval.mjs --policy {CTRAIN}/policy-best.json --config alone --rule-lane-dir alternate'],
   ['진화 탐색 한 시드', 'node tools/train.mjs --config alone --seed 11 --population 32 --iterations 4 --lane-dir alternate --no-stop'],
   ['규칙 경로 기준선', 'node tools/baseline.mjs --mains kuka-kr210-r2700 --configs alone --lane-dir robot,alternate']], widths=[5, 12], font=8)
P('각 실행 폴더의 run.json에 실제로 실행한 명령·시각·git 커밋이 그대로 있다. 같은 명령은 새 날짜·시각 폴더에 같은 결과를 만든다.', size=9)

H('7.8 어제(2026-11-05)와 오늘(2026-11-06), 무엇이 달라졌나', 2)
P('같은 시드 11·12·13이라도 어제와 오늘은 코드와 조건이 달라 숫자를 그대로 비교하면 안 된다. 바뀐 조건을 방법별로 정리한다.')
T([['구분', '어제 (2026-11-05)', '오늘 (2026-11-06)', '영향'],
   ['물리 엔진', '운동학 바디 회전을 쿼터니언으로 넘길 때 부호가 뒤집히면 한 스텝 360° 회전으로 계산(버그)', '직전 회전과 같은 부호로 맞춤 (physics.js continuousRot)', '스쿱을 크게 돌리는 동작(J6 회전·스나우트 쪽 쓸기)에서 드로스가 튕겨 나가던 문제 해결. 기존 로봇 쪽 쓸기 결과는 같음(61.3%)'],
   ['스나우트 쪽 쓸기 동작', '스나우트 쪽으로 쓸면 열린 면이 바깥을 본 채 운반 → 대량 흘림', '들어 올린 뒤 450 mm 물러나 30°/s로 180° 돌린 다음 운반 (J6 덜 감기는 쪽)', '스나우트 쪽 스트로크가 실제로 쓸 만해짐'],
   ['스트로크 범위', '시작 X 1300~ (앞벽에 너무 가까운 값 허용)', '규칙 레인 여유와 같게: X 1330~2070, Y ±670 (11/05 PPO 1차 중에 바꿈)', '계획 불가 후보 감소'],
   ['규칙 경로 (비교 기준)', '로봇 쪽으로만 쓸기 (v1.1.2)', '[A] 쓸기 방향 옵션 — 비교 기준을 번갈아(alternate)로', '기준이 61.3% → 72.9%로 높아짐. 어제 숫자와 차이(%p)를 직접 비교하지 말 것'],
   ['진화 탐색 첫 세대 후보', '규칙 레인 1개 + 근처 절반 + 무작위 절반', '+ 같은 레인을 스나우트 쪽으로 쓰는 후보 1개 (측면 로봇 없는 셀)', '진화 탐색이 스나우트 쪽 쓸기를 고르기 시작(시범의 28%)'],
   ['진화 탐색 막힘 처리', '대형이 안전 게이트에 막히면 대형 작업 정지(앱과 같음)', '시범·평가용 실행은 그 사이클만 버리고 계속(--no-stop)', '긴 실행이 한 번의 막힘으로 망가지지 않음'],
   ['진화 탐색 예산', '후보 32 × 세대 4 = 128번', '같음', '—'],
   ['PPO 교사', '규칙 경로 (약 60%)', '진화 탐색 시범 135개 (평균 84.9%, 시드 101~110)', '모방 직후 39.4% → 61.9%'],
   ['PPO 행동 형식', '스트로크 9개 값 직접', '규칙 레인 기준 조정 10개 (반대 방향 여부 + 조정 + 열린 면·기울임·깊이·속도)', '평균을 배워 망가지는 문제 해결'],
   ['PPO 관측', '드로스 격자 + 남은 비율 + 시간 (98)', '+ 직전 스트로크 방향·시작 위치 (102)', '번갈아 쓰기를 배울 수 있음'],
   ['PPO 학습량', '모방 3회 + PPO 40회 (약 2시간)', '모방 3회 + PPO 10회 (약 27분, 사용자 결정)', '최고 모델 = 5회째'],
   ['PPO 중간 저장', '최고·마지막만', '5회마다 checkpoints/iter-NNN.json', '중간 모델 비교 가능'],
   ['기록', 'results/ppo/… 등 덮어쓰기 가능 구조', '날짜·시각 폴더, run.json, INDEX.md, 단계마다 자동 커밋·push', '모든 실행 추적·재현 가능']], widths=[2.8, 4.4, 5.2, 4.6], font=7.6, bold_first_col=True)
P('같은 조건으로 다시 잰 값: 규칙 경로(로봇 쪽)는 어제와 오늘 같은 61.3%(물리 수정 전후 재현). 진화 탐색 시드 11은 어제 75.0%(어제 코드·조건) → 오늘 80.6%(위 변경 반영) — 차이는 진화 탐색 자체가 아니라 위 조건 변경에서 온다.', size=9)
P('각주: [C] 파이프라인에서는 규칙 경로를 시드마다 두 번 실행했다 — ② PPO 평가의 비교용과 ③ 진화 탐색 도구(train.mjs)의 비교용. 두 값은 항상 같다(결정적 실행, 예: 시드 11 두 번 다 78.1%).', size=8.8)

# ---------------- 8. 결과 종합
H('8. 결과 종합 (KR 210, 10분)')
T([['방법', '조건', '회수율', '현장 사용', '근거 폴더 (results/)'],
   ['규칙 경로 (기존)', '단독', '61.3%', '가능', '2026-11-05/1541_baseline_… · 2026-11-06/1022_…'],
   ['규칙 경로 (번갈아)', '단독', f'{pct(am(AA))}', '가능', '2026-11-06/1022_baseline_kr210_alone_lane-dir'],
   ['규칙 경로 + 모드 3', '측면 2대', f'{pct(am(M3))}', '가능', '2026-11-06/1022_baseline_kr210_mode2-vs-push'],
   ['진화 탐색 1차', '단독 (시드 11·12)', '75.0~75.6%', '불가', '2026-11-05/1552·1602_cem_…'],
   ['진화 탐색 [B]', f'단독 (시드 101~, {len(BA)}개)', pct(bmean(BA, 'cem')) if BA else '—', '불가', '2026-11-06/*_cem_kr210-alone-s1xx'],
   ['PPO 1차', '단독 (시드 11·12·13)', pct(A_PPO), '가능', '2026-11-05/1814_ppo-train_kr210-run1 · 2026-11-06/0836_…'],
   ['진화 탐색 (평가 시드)', '단독 (시드 11·12·13)', pct(cm(C_CEM, 'cem')), '불가', CDIR],
   ['PPO 2차 [C] 10회', '단독 (시드 11·12·13)', pct(cm(C_PPO, 'ppo')), '가능', CTRAIN.replace('results/', '')]], widths=[3.6, 3.6, 2.2, 1.8, 5.8], font=8)
P(f'해석: 시뮬레이터 안에서는 80%가 가능하다(진화 탐색 {pct(cm(C_CEM, "cem"))}). 2차 PPO는 {pct(cm(C_PPO, "ppo"))}로 1차({pct(A_PPO)})보다 {cm(C_PPO, "ppo") - A_PPO:+.1f}%p. 교사와의 차이 {cm(C_CEM, "cem") - cm(C_PPO, "ppo"):.1f}%p를 줄이는 것이 다음 과제다.', size=9.5)

# ---------------- 8. 기록·재현
H('9. 결과·문서 기록과 다른 PC에서 재현')
IMGP('f16-results-tree.png', '날짜·시각별 기록 구조')
B([('덮어쓰지 않는다: ', '명령을 실행할 때마다 results/<날짜>/<시각>_<종류>_<이름>/ 새 폴더 + run.json(명령·시각·git 커밋·Node 버전) + results/INDEX.md 한 줄(자동).'),
   ('문서도 판마다 새 폴더: ', 'docs/<날짜>_<시각>_<제목>/ 안에 docx · images · build(그 문서를 만든 스크립트). 이 문서도 이전 판을 그대로 두고 새로 만들었다.'),
   ('git: ', '커밋 메시지 앞에 [날짜 시각 KST]. 3D 재생 파일(.rsim.json.gz)·진화 탐색 시도 기록(log.json)까지 모두 저장소에 있다(2026-11-06부터).'),
   ('다른 PC: ', 'git clone → Node 18+ · Python 3.8+ → v3.0.0에서 node tests/run-all.mjs(13종) → start.bat → 에피소드 재생으로 모든 결과를 3D로 확인. 문서 다시 만들기: pip install -r v3.0.0/docs/requirements.txt (SETUP.md 4-1장).')])
T([['하고 싶은 것', '명령 (v3.0.0 폴더)'],
   ['규칙 경로 측정', 'node tools/baseline.mjs --mains kuka-kr210-r2700 --configs alone,push --lane-dir robot,alternate'],
   ['진화 탐색 10분 1회', 'node tools/train.mjs --config alone --seed 11 --population 32 --iterations 4'],
   ['[B] 시범 수집', 'node tools/cem-demos.mjs --alone 101-110 --push 201-206'],
   ['**학습 파이프라인 (권장)**', 'node tools/pipeline.mjs --demos <demos.json> --name run3 --iterations 10  (시범 → PPO → 평가 → 보고서, 단계마다 git 커밋·push)'],
   ['시범부터 자동', 'node tools/pipeline.mjs --alone 111-130 --name run3  (진화 탐색 시범 수집부터)'],
   ['PPO만', 'node tools/ppo-train.mjs --demos <demos.json> --iterations 10 --name run3  (--resume policy-last.json 으로 이어서)'],
   ['정책 평가', 'node tools/ppo-eval.mjs --policy results/2026-11-05/1814_ppo-train_kr210-run1/policy-best.json --config push'],
   ['3D 재생 파일 1개', 'node tools/episode.mjs --config push --seed 11']], widths=[3.5, 13.5], font=8)
doc.add_page_break()

# ---------------- 9. 한계·다음·현장
H('10. 한계와 다음 단계')
B(['80%는 아직 시뮬레이터 안 진화 탐색만 도달. 현장용 정책(PPO)은 미달.',
   '시뮬레이터 드로스는 구형 입자 근사 — 실제(점착·덩어리)와 차이가 가장 크다(sim-to-real).',
   '측면 로봇 셀에서 규칙 경로의 스나우트 쪽 쓸기는 측면 로봇과 가까워 막힌다(원인 미확정) → 학습 단계에서 충돌 검사로 거른다.',
   '관측은 아직 시뮬레이터 정답 입자 위치 기반 → [D]에서 상부 가상 카메라(가림·잡음)로 바꾸고 전후 차이를 측정한다.',
   '측면 로봇 셀 학습과 상부 가상 카메라는 v3.0.1에서 한다(사용자 결정). 앱 드로스 셀 패널에는 모드 3·쓸기 방향 선택이 들어갔다(11장).'])
IMGP('f15-hardware.png', '현장 적용 구성과 단계 H0~H5 (PRD 9장)')

# ---------------- 10. 자주 묻는 질문 (2026-11-06 대화에서)
doc.add_page_break()
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'usage.py'), encoding='utf8').read())
doc.add_page_break()
H('12. 자주 묻는 질문')
QA = [
    ('진화 탐색 파일 이름이 왜 cem인가?', 'CEM = Cross-Entropy Method(교차 엔트로피 방법). 진화 탐색의 정식 이름이다. 결과 파일 이름은 방법 기준: 진화 탐색 cem, PPO ppo, 규칙 경로 rule.'),
    ('진화 탐색은 왜 현장에 못 쓰나?', '결정마다 지금 포트를 정확히 복사한 가상 세계에서 128번 미리 해 봐야 하는데, 현장 카메라로는 드로스 위치·크기·물성을 정확히 알 수 없어 복사본을 못 만든다. 실제 드로스는 공 모양 근사와 달리 움직이고, 결정 1번에 10~15 s 걸린다. 그래서 PPO의 교사로만 쓴다(2.3절).'),
    ('진화 탐색은 무엇을 반복하나? 궤적을 많이 뽑는 것인가?', '후보는 궤적이 아니라 설계값 9개다. 설계값마다 기존 경로 계획기가 J1~J6 궤적을 만들고, 복사한 세계에서 실행해 점수를 매긴다. 상위 8개 근처에서 다시 32개를 뽑기를 4세대 반복해 최선 1개를 실행한다(5.0절).'),
    ('진화 탐색을 하면서 규칙 경로와 왜 비교하나?', '드로스 배치(시드)마다 난이도가 달라 숫자 하나로는 좋은지 알 수 없다. 같은 시드로 규칙 경로를 돌려 차이를 보고, 교사가 규칙보다 확실히 좋은지(시범으로 쓸 가치) 확인하며, 다음 PPO의 기준선으로 쓴다(2.5절).'),
    ('규칙 경로·진화 탐색·PPO 세 가지를 동시에 수행하나?', '[B]에서는 진화 탐색과 같은 시드의 규칙 경로만 돌았다. PPO는 [B] 시범으로 [C]에서 학습했다. 역할: 규칙 = 기준, 진화 탐색 = 교사, PPO = 학생(현장용).'),
    ('"모방 직후"는 무엇인가?', '교사 시범을 따라 하는 모방 학습만 끝내고 강화학습을 한 번도 하지 않은 상태의 시험 성적. PPO의 시작점이다. 1차 39.4%(교사 = 규칙), 2차 61.9%(교사 = 진화 탐색)(6.0절).'),
    ('2차 PPO는 왜 5회 만에 1차 40회 수준에 왔나?', '더 좋은 교사, 규칙 레인 기준 조정 형식(출발점이 망가지지 않음), 직전 스트로크 입력, 남은 약점(계획 불가)이 감점으로 빨리 고쳐짐(6.3.2절).'),
    ('"40번 학습"인데 파일이 왜 40개가 아닌가?', '신경망 하나를 40번 고쳐 쓴 것이다. 최고·마지막 정책과 5회마다의 중간 정책(checkpoints/iter-NNN.json, 2차부터)만 저장한다.'),
    ('1차 PPO는 왜 측면 로봇 셀에서 학습하지 않았나?', '연습장이 대형 단독이었고, 범위를 줄인 결정을 학습 전에 알리지 않았다(PRD D6는 3대 셀 기준). 사용자 결정(2026-11-06)으로 대형 단독을 먼저 완성하고 측면 셀은 다음 단계에서 한다.'),
    ('학습된 PPO 모델은 어디 있나? 앱에서 어떻게 보나?', f'1차: results/2026-11-05/1814_ppo-train_kr210-run1/policy-best.json, 2차: {CTRAIN}/policy-best.json. 앱 학습 (Trial & Error) → 정책 불러오기 (PPO) → ▶ → 학습 결과 3D 재생.'),
    ('진화 탐색·PPO 결과를 3D로 보려면?', 'start.bat → 에피소드 재생 → 실행 결과 목록에서 열기 → 실행·파일(cem-·ppo-·rule-…-s<시드>) 고르고 ▶ 열기(11.9절). 다운로드한 파일은 [에피소드 불러오기]. 재생·일시정지·배속·시간 이동, J1~J6 관절각 표시.'),
    ('Claude 없이 혼자 학습하려면?', 'v3.0.0\\train.bat 더블클릭 → 메뉴 1(전체)·2(PPO만)·3(평가)·4(기준선)·5(목록). 질문에 Enter면 기본값. 결과는 results/<날짜>/<시각>_…/ 에 쌓이고 앱 실행 결과 목록에 나온다(11.7절).'),
    ('진화 탐색 시범(CEM)은 어떻게 만드나?', 'node tools/cem-demos.mjs --alone 101-110 --push none → results/<날짜>/<시각>_cem-demos_…/demos.json. 시드는 평가 시드(11·12·13)와 겹치지 않게, 많을수록 좋다. 시드 1개 약 7분(Worker 14). 이미 돌린 결과는 --collect로 모은다. 보고서에서 규칙보다 낮은 에피소드는 학습에서 자동 제외(--demo-filter better).'),
    ('시범이 있으면 PPO 학습을 직접 어떻게 하나?', 'node tools/pipeline.mjs --demos <demos.json> --name run3 --iterations 10. 모방 → PPO → 시험 → 실제 셀 평가 → 같은 시드 진화 탐색 → 비교 보고서까지 자동, 단계마다 git 커밋·push.'),
    ('측면 로봇 밀어 주기는 언제 하나?', '[A]에서 모드 3(타이밍 밀기)를 만들어 규칙 경로로 57.5%를 확인했다. 학습(시범·PPO)은 대형 단독을 완성한 뒤 진행한다(사용자 결정).'),
    ('가상 카메라를 붙이면 결과가 달라지나?', '달라진다. 정확한 입자 위치로 배운 정책에 카메라 입력(가림·잡음·지연)을 주면 성능이 떨어질 수 있고, 카메라 입력으로 다시 학습하면 대부분 회복된다. [D]에서 같은 정책을 두 입력으로 돌려 차이를 잰다. 측면 로봇이 포트 위에 있을 때 가림이 커지므로 카메라 2대가 유리하다.'),
]
for q, a in QA:
    P(a, bold_prefix=f'Q. {q}\nA. ', size=9.3, after=6)

H('부록 A. 코드 지도 (v3.0.0)')
T([['파일', '역할'],
   ['js/cell-sim.js', '헤드리스 셀 시뮬레이터 runEpisode, 규칙 운전기(쓸기 방향, 측면 대기 장애물), mainChooser'],
   ['js/cell-robot.js', '측면 로봇 모드 1·2·3, 조정기(잠금·타이밍 밀기 etaS)'],
   ['js/dross.js', '셀 상수, planSkimCycle(스나우트 쪽 쓸기의 물러나기·돌리기 포함), PUSH_ASSIST'],
   ['js/physics.js', 'Rapier 래퍼, continuousRot(회전 부호 연속성)'],
   ['js/stroke-lab.js', '스트로크 변수·점수·후보 평가·진화 탐색(반대 방향 규칙 후보)·StrokeEnv·정책 실행기·시범 기록'],
   ['js/ppo.js', '순수 JS 신경망·PPO·GAE·모방 학습·정책 파일, 관측 98/102(직전 스트로크)'],
   ['tools/pipeline.mjs', '학습 파이프라인: 시범 → PPO → 평가 시드 진화 탐색 → 비교 보고서, 단계마다 git 커밋·push'],
   ['tools/baseline · train · cem-demos · ppo-train · ppo-eval · episode .mjs', '헤드리스 도구 (8장 표). ppo-train --demos(진화 탐색 교사) --action residual(규칙 레인 기준 조정)'],
   ['tools/lib/run-dir.mjs · policy-eval.mjs', '날짜·시각 실행 폴더·INDEX · 정책 전체 셀 평가'],
   ['tests/run-all.mjs (13종), tests/push-lane.mjs, tests/cell-robots.mjs', '검증']], widths=[6.5, 10.5], font=8.5)
H('부록 B. 결정 기록')
T([['#', '결정'],
   ['D1·D2', 'J1~J6 전 관절, 계층형 B 먼저 (A는 비교 후보)'],
   ['D3~D7', '목표·시간 설정값(80%·600 s), 작업 영역 기준, AI 로봇 선택, 회수율 = 셀 합계'],
   ['D11~D14', '강화학습 기반·최선만 채택, 3D 재생, 순수 JS 학습 엔진, 학습 설정 창'],
   ['2026-11-06', '측면 로봇은 밀어 주기만·대형만 회수 / 스쿱 열린 면 반대 방향 회수 / 결과·문서 날짜·시각별 기록 / 3D 재생 파일까지 git (다른 PC 재현)']], widths=[2.4, 14.6], font=8.5)

doc.save(OUT)
print('saved', OUT, 'figures', FIG[0], 'B runs', len(BR), 'C', bool(CRUN))
