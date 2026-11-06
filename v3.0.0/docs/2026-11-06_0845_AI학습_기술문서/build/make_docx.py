# RoboSim Lite v3.0.0 — 드로스 제거 AI 학습 구조 기술 문서 (Word) 생성
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


fp.add_run('RoboSim Lite v3.0.0 · 드로스 제거 AI 학습 구조 — ').font.size = Pt(8)
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

# =============================================================== 표지
doc.add_paragraph().paragraph_format.space_after = Pt(50)
t = doc.add_paragraph('RoboSim Lite v3.0.0', style='Title'); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('드로스 제거 AI 학습 구조 기술 문서\n— 진화 탐색(CEM)과 PPO 강화학습, 계층형 B 방식 —'); r.font.size = Pt(15); r.bold = True
doc.add_paragraph().paragraph_format.space_after = Pt(24)
T([['항목', '내용'],
   ['대상', '로봇 시뮬레이션/v3.0.0 (개발 중, 포트 8300) — 뼈대 v1.1.2'],
   ['작성일', '2026-11-06'],
   ['기준 문서', 'v3.0.0/PRD_v.3.0.0.md (요구사항·결정 D1~D14), v3.0.0/PROMPTS.md (진행표), results/README.md (결과 파일 규칙)'],
   ['다루는 범위', '0단계 기준선 → 1단계 진화 탐색 → 2단계 PPO 1차 학습(KR 210, 40회) → 현장 적용 준비 구조'],
   ['상태', '시뮬레이터 안 학습·평가 1차 완료. 목표 80%는 아직 미달. 실제 로봇 적용 전'],
   ['수치 출처', 'results/baseline/report.md, results/cem/*/report.md, results/ppo/kr210-run1/train-report.md · cell-eval-*.md']],
  widths=[3.2, 13.8])
P('이 문서는 "AI가 무엇을 배우는지, 왜 그런 구조로 배우게 했는지, 결과 파일이 무엇을 뜻하는지"를 처음 보는 사람도 따라갈 수 있게 그림 위주로 정리했다. 모든 숫자는 시뮬레이터(구형 입자 근사) 결과이며 실제 포트 결과가 아니다.', size=9.5)
doc.add_page_break()

# =============================================================== 목차
H('목차')
p = doc.add_paragraph(); field(p, 'TOC \\o "1-2" \\h \\z \\u')
P('(Word에서 목차가 비어 보이면 목차를 오른쪽 클릭 → "필드 업데이트"를 누른다.)', size=8.5)
doc.add_page_break()

# =============================================================== 0. 요약
H('0. 한 장 요약')
NOTE(
    '• 목표: 포트 스나우트 앞 작업 영역의 드로스를 10분 안에 80% 이상 회수하는 로봇 동작을 AI로 찾는다. 목표 회수율·시간·AI 로봇은 설정값이다.\n'
    '• AI가 정하는 것: 관절 값 하나하나가 아니라 "한 번의 쓸기(스트로크)"를 9개 숫자로 정한다(시작점·방향·길이·스쿱 열린 면 방향(J6)·기울임·깊이·속도). '
    'J1~J6 관절 궤적은 기존에 검증된 IK·경로 계획·안전 게이트가 만든다. 이것이 계층형 B 방식이다.\n'
    '• 두 가지 학습:\n'
    '   ① 진화 탐색(CEM): 결정할 때마다 후보 128개를 시뮬레이터로 미리 해 보고 최선만 실행한다. 점수는 높지만 현장에서는 쓸 수 없다.\n'
    '   ② PPO 강화학습: 연습 경기를 수백 번 치르며 신경망을 고친다. 결과 신경망은 드로스 분포만 보고 1 ms 안에 바로 결정하므로 현장에 가져갈 수 있다.\n'
    f'• 결과(KR 210 단독, 10분): 규칙 경로 {pct(A_RULE)} → PPO {pct(A_PPO)} (시드 3개 평균), 진화 탐색 약 75%. '
    f'측면 로봇 2대가 있는 셀에서는 PPO {pct(M_PPO)}로 규칙 {pct(M_RULE)}보다 아직 낮다(단독 셀에서만 학습했기 때문).\n'
    '• 80%에는 아직 못 미친다. 다음 개선: 진화 탐색의 최선을 교사로 쓰기, 측면 로봇이 있는 셀에서 학습하기, 학습량 늘리기.',
    fill='EAF3FB', title='요약')
IMGP('f02-roadmap.png', '전체 진행 단계와 단계별 결과')

H('0.1 용어', 2)
T([['용어', '뜻 (이 문서에서)'],
   ['드로스', '용융 아연 위에 뜨는 산화물 찌꺼기. 시뮬레이터에서는 지름 40~90 mm 구형 입자 160개'],
   ['회수율', '(모든 드로스 박스에 들어간 개수) ÷ (작업 영역 초기 드로스 개수). 셀 전체 합계(D7)'],
   ['스트로크', '스쿱을 욕면에 담가 한 번 쓸고 → 들어 → 박스에 쏟고 → 돌아오는 한 사이클. 10분에 약 15번'],
   ['헛질', '드로스를 하나도 담지 못한 스트로크'],
   ['에피소드', '10분 과제 1회 (드로스 배치 1개로 시작해 시간이 끝날 때까지)'],
   ['시드', '드로스 배치를 만드는 난수 번호. 같은 시드 = 같은 시작 배치 → 공정 비교'],
   ['보상(점수)', '스트로크 결과에 매기는 점수. 회수 +, 헛질 −, 흘림 − 등 (4장)'],
   ['정책', '관측(드로스 분포) → 행동(스트로크 9개 값)을 내는 신경망'],
   ['롤아웃', '정책으로 연습 에피소드를 실제로 돌려 보는 것'],
   ['반복(iteration)', 'PPO 1회 = 롤아웃 14개 → 점수 정리 → 신경망 가중치 수정'],
   ['체크포인트', '학습 중 어느 시점의 신경망을 파일로 저장한 것'],
   ['헤드리스', '화면 없이 Node로 빠르게 돌리는 시뮬레이션 (결과는 3D 재생 파일로 다시 볼 수 있음)'],
   ['규칙 경로', 'v1.1.2의 기존 경로: X축 평행 레인 6개 중 드로스가 가장 많은 레인을 스쿱 수평·고정 방향으로 쓸기']],
  widths=[3.2, 13.8], bold_first_col=True)
doc.add_page_break()

# =============================================================== 1. 문제
H('1. 풀려는 문제')
H('1.1 작업 셀과 기준 영역', 2)
IMGP('f01-cell.png', '셀 평면도 — 회수율 기준 영역(파랑), 스트로크 상자(초록 점선), 측면 로봇 모드 1일 때 대형 구역(주황)')
B([('작업 영역(WORK_ZONE): ', 'X 1100~2300, Y ±900 mm. 대형·좌·우 로봇 3대가 작업하는 스나우트 앞 영역. 회수율은 여기 있던 드로스로만 계산한다(D4).'),
   ('FAR_ZONE: ', '스나우트 너머. 로봇이 닿지 않아 회수율에서 제외한다.'),
   ('AI 로봇: ', '학습할 때 3대 중 1대를 고른다(D6). 1차 학습은 대형 로봇(KR 210)이다. 나머지 로봇은 기존(v1.1.2) 경로 그대로 함께 일한다.'),
   ('목표·시간: ', '기본 80%, 600 s(시뮬레이션 시간). 둘 다 앱과 명령에서 바꿀 수 있다(D3·D5).')])

H('1.2 기존 규칙 경로로는 왜 안 되나 — 0단계 기준선', 2)
IMGP('f14-baseline.png', '기준선: 규칙 경로만으로 10분 회수율 (results/baseline/report.md)', 16)
B(['대형 로봇 4종 × 셀 구성 3가지 × 시드 3개 = 36회 중 80%에 도달한 경우는 0회다. 가장 좋은 것은 대형 단독(약 60~62%)이다.',
   '측면 로봇을 붙이면 오히려 낮아진다. 모드 1에서는 대형 레인이 가운데(|Y| ≤ 230)로 줄고, 측면 로봇은 대부분 헛질한다.',
   '규칙 경로의 한계: 스쿱이 늘 수평·같은 방향이라 손목(J4~J6)을 거의 쓰지 않고, 벽 띠·모서리 드로스가 남으며, 드로스가 줄면 헛질이 늘어난다.',
   '그래서 AI가 바꿀 수 있는 곳은 ① 헛질을 줄이는 위치·방향 선택 ② 열린 면 방향(J6)을 돌려 벽·모서리 회수 ③ 흘림 감소 ④ 측면 로봇과의 협업이다.'])
doc.add_page_break()

# =============================================================== 2. 구조
H('2. AI가 무엇을 결정하나 — 계층형 B 방식')
H('2.1 두 가지 개념 A·B와 B를 먼저 고른 이유', 2)
IMGP('f03-a-vs-b.png', '개념 A(순수 관절 직접)와 개념 B(계층형 + 관절 직접)')
T([['비교', 'A. 순수 관절 직접', 'B. 계층형 + 관절 직접 (채택)'],
   ['AI 출력', '0.05 s마다 J1~J6 변화량', '스트로크 1번마다 9개 값'],
   ['10분 동안 결정 수', '약 12,000번', '약 15번'],
   ['학습 속도', '매우 느림 (보상이 늦게 옴)', '빠름 (결정 1번 = 결과 1번)'],
   ['안전', 'AI가 충돌 자세를 자주 냄 → 걸러야 함', '기존 계획·안전 게이트를 그대로 통과'],
   ['관절 활용', '모든 관절 자유', 'J1~J6 모두 움직임. 열린 면(J6)·기울임(J4·J5)·위치(J1~J3)를 스트로크 값으로 지정'],
   ['현장 검증', '동작을 사람이 해석하기 어려움', '스트로크 단위로 사람이 보고 판단 가능'],
   ['상태', '문서화, 비교 실험 후보(P3)', '개발·시험 중']], widths=[3, 6.5, 7.5], bold_first_col=True)
P('결정: 사용자 지시(2026-11-05)에 따라 B로 먼저 시험하고 A는 개념과 인터페이스만 문서로 남겼다(PRD D2, 4.2~4.4).', size=9.5)

H('2.2 한 번의 결정이 관절 움직임이 되기까지', 2)
IMGP('f04-b-flow.png', '계층형 B의 데이터 흐름 (①~⑨)')
B([('상위(AI): ', '①관측 → ②정책 → ③스트로크 9개 값. 학습하는 부분은 ②뿐이다.'),
   ('실행기 안전장치(④): ', '정책 값이 측면 로봇 구역을 침범하거나 계획이 불가능하면 보정하고, 그래도 안 되면 규칙 레인으로 대체한다(5.8절).'),
   ('하위(기존 모듈): ', '⑤ planSkimCycle이 스트로크를 진입·스윕·들기·운반·덤프·복귀 자세로 나누고, ⑥ IK와 경로 계획이 J1~J6 궤적으로 바꾸고, ⑦ 안전 게이트가 매 틱 적용 전에 충돌을 검사한다.'),
   ('결과(⑧⑨): ', '물리 엔진(Rapier, 60 Hz)이 드로스를 움직이고 박스에 들어간 개수로 점수를 매긴다.')])

H('2.3 스트로크 9개 값', 2)
IMGP('f05-stroke.png', '스트로크 변수 — 시작점·방향·길이와 열린 면 방향(J6)의 시작·끝 값')
P('스쿱은 네 면 중 한 면만 열려 있다. 규칙 경로는 항상 열린 면이 진행 방향을 향한 채(0°) 수평으로 쓸었다. '
  '열린 면 방향(⑤⑥)을 바꾸면 J6가 돌아가 같은 위치에서도 드로스를 받는 각도가 달라지고, 시작과 끝 값이 다르면 쓸면서 스쿱이 회전한다. '
  '사용자 아이디어("열린 면을 크게 다른 방향으로 바꾸면 회수율이 높아질 것")를 시험할 수 있게 넣은 값이다. 진화 탐색에서 드로스가 줄어든 중반 이후 '
  '"대각선 방향 + 스윕 중 열린 면 회전(예: −47° → +46°)"이 규칙 레인보다 점수가 크게 높게 나와 가설이 확인됐다(4장).')
doc.add_page_break()

# =============================================================== 3. 보상
H('3. 점수(보상) 규칙 — 무엇을 잘했다고 볼 것인가')
T([['항목', '기본값', '이유'],
   ['드로스 1개 회수', '+10', '목표 자체'],
   ['벽 띠(벽에서 250 mm 안) 드로스 회수', '+5 추가', '규칙 경로가 못 치우는 벽·모서리를 우대'],
   ['헛질 (회수 0개)', '−20', '시간 낭비. 사용자 요청: "헛질을 많이 하면 −"'],
   ['흘림 (포트 밖·바닥으로 떨어짐) 1개', '−5', '현장 안전·청소 부담'],
   ['경과 시간 1 s', '−0.2', '같은 회수면 빠른 쪽이 낫게'],
   ['계획 불가 (IK·충돌로 실행 못 함)', '−10', '불가능한 행동을 피하게'],
   ['목표 회수율 도달', '+200', '목표를 넘기도록 유도']], widths=[6.5, 2.3, 8.2], bold_first_col=True)
B(['모든 값은 앱 "학습 (Trial & Error)" 패널에서 바꿀 수 있고, [설정 내보내기] 파일로 헤드리스 학습에도 그대로 쓴다(D14).',
   '점수는 "학습 방향"을 정할 뿐이다. 최종 비교는 항상 10분 회수율(%)로 한다.'])

# =============================================================== 4. CEM
H('4. 1단계 — 진화 탐색(CEM): "미리 해 보고 최선만"')
IMGP('f06-cem.png', '진화 탐색 한 번의 결정 (후보 32개 × 4세대 = 128번 시도)')
B([('방법: ', '대형 로봇이 다음 스트로크를 고를 때마다, 지금 드로스 상태를 복사한 별도 물리 월드에서 후보를 한 사이클씩 실제로 돌려 점수를 매긴다. '
           '점수 상위 25%의 평균·분산으로 다음 세대 후보를 뽑는다(Cross-Entropy Method).'),
   ('규칙 레인 포함: ', '첫 세대에 규칙 레인을 넣어, 최소한 규칙 경로보다 나빠지지 않게 했다.'),
   ('속도: ', 'Worker 14개 병렬, 후보 1개 약 1.3 s → 10분 과제 1회에 약 3.5분.'),
   ('한계: ', '결정마다 시뮬레이터가 필요하다. 실제 포트에서는 "복사한 세상에서 미리 해 보기"가 불가능하므로 현장용이 아니다. 대신 "이 상황의 좋은 스트로크"를 알려 주는 교사로 쓸 수 있다.')])
T([['조건 (10분)', '진화 탐색', '규칙 경로', '차이', '헛질'],
   ['KR 210 단독, 시드 11', '**75.0%**', '61.9%', '+13.1%p', '1'],
   ['KR 210 단독, 시드 12', '**75.6%**', '56.9%', '+18.7%p', '0'],
   ['KR 210 + 좌 UR10e · 우 IRB 1200 (모드 1), 시드 11', '**52.5%**', '38.8%', '+13.7%p', '0']], widths=[7.5, 2.5, 2.5, 2.3, 1.5])
P('주의: 진화 탐색 결과는 2026-11-05 당시 코드로 잰 값이다. 이후 PPO 단계에서 스트로크 상자를 규칙 레인 여유(X 1330~2070, Y ±670)로 좁혔으므로 지금 다시 돌리면 조금 다를 수 있다. '
  '후보 평가는 측면 로봇 없이 복사한 드로스 위에서 하므로 측면 로봇 셀에서는 예상과 실제가 다를 수 있다.', size=9)
doc.add_page_break()

# =============================================================== 5. PPO
H('5. 2단계 — PPO 강화학습: "연습해서 바로 결정"')
H('5.1 PPO란', 2)
P('PPO(Proximal Policy Optimization, 근접 정책 최적화)는 가장 널리 쓰이는 강화학습 방법이다. 아래 순서를 계속 반복한다.')
B(['지금 신경망으로 여러 번 해 본다. 이때 일부러 조금씩 다르게 시도한다(탐험).',
   '각 시도가 "평소 기대보다 좋았는지 나빴는지"(이점, Advantage)를 계산한다.',
   '좋았던 행동은 더 자주, 나빴던 행동은 덜 자주 나오도록 신경망을 고친다.',
   '"근접(Proximal)": 한 번에 너무 많이 바꾸면 학습이 무너지므로, 행동 확률이 한 번에 ±20% 넘게 바뀌지 않게 자른다(클립).'], style='List Number')
P('비유: 운동선수가 연습 경기 14번을 뛰고, 잘된 플레이는 늘리고 실수는 줄이되, 폼을 한 번에 확 바꾸지 않고 조금씩 고치는 것과 같다.', size=9.5)

H('5.2 정책이 보는 것 (관측)', 2)
IMGP('f08-observation.png', '관측: 작업 영역을 12×8 칸으로 나눈 드로스 밀도 + 남은 비율 + 경과 시간 = 숫자 98개')
B(['칸 하나는 100 × 225 mm다. 칸 안 드로스 개수를 4로 나눠 0~1로 만든다.',
   '정책은 이 격자만 본다. 정답 입자 위치는 점수 계산에만 쓴다. 현장에서도 카메라 → 같은 격자를 만들면 같은 정책을 그대로 쓸 수 있게 하려는 설계다(PRD 5장).',
   '지금(1차)은 시뮬레이터 입자 위치로 격자를 만든다. 다음 단계(PROMPTS 2단계)에서 상부 가상 카메라(가림·잡음 포함)로 바꾼다.'])

H('5.3 신경망 구조', 2)
IMGP('f07-network.png', '정책 신경망 MLP 98 → 64 → 64 → 9 (+ 학습되는 표준편차 9개)')
B(['출력 9개는 0~1 사이 값(sigmoid)이고, 각 스트로크 변수의 범위(2.3절 표)로 늘려 쓴다.',
   '학습 중에는 출력(평균 μ) 주변에서 표준편차 σ만큼 무작위로 흔들어 새로운 스트로크를 시도한다. 실제 실행·평가에서는 무작위 없이 μ만 쓴다(결정적).',
   '가치 신경망(같은 구조, 출력 1개)은 "이 상황이면 앞으로 받을 점수"를 추정한다. 이점 계산의 기준선 역할이다.',
   '순수 JavaScript로 구현했다(js/ppo.js). 이 PC에 PyTorch가 없고, 같은 코드가 Node 학습과 브라우저 앱 실행에서 그대로 돌기 때문이다(D13). 현장용 ONNX 변환은 이후 작업이다.'])
doc.add_page_break()

H('5.4 학습 절차', 2)
IMGP('f09-ppo-loop.png', 'PPO 학습 절차 A~G')
T([['단계', '하는 일', '이번 설정 (kr210-run1)'],
   ['A. 모방 학습', '규칙 경로가 고른 스트로크를 따라 하게 해서 출발점을 잡는다 (Behavior Cloning)', '3회 × 에피소드 14개, 30 epoch'],
   ['B. 롤아웃', '같은 신경망으로 연습 에피소드를 동시에 돌린다. 에피소드마다 드로스 배치(시드)가 달라 "다양한 상황"을 겪는다', '반복당 14개, Worker 14개'],
   ['C. 점수 정리', 'GAE로 스트로크별 이점 계산', 'γ = 0.99, λ = 0.95'],
   ['D. 가중치 수정', 'PPO 클립 목적함수 + Adam', '클립 0.2, 8 epoch, 미니배치 32, 학습률 3e-4'],
   ['E. 시험', '고정 시드 11·12·13에서 무작위 없이 실행해 점수 기록', '5회마다'],
   ['F. 최고 교체', '시험 점수(보상)가 지금까지 최고면 policy-best.json으로 저장', '최고 = 반복 ' + str(BEST['iter'])],
   ['G. 최종 평가', '최고 정책을 전체 셀 10분 과제로 실행, 규칙 경로와 비교', '대형 단독 + 측면 2대(모드 1)']], widths=[2.8, 9.2, 5], bold_first_col=True)
P(f'걸린 시간: 약 {TRAIN_S / 3600:.1f}시간(이 PC, Worker 14개). 연습 에피소드 수 = 모방 42 + PPO 560 + 시험 27.', size=9.5)

H('5.5 "40번 학습"이 파일 40개가 아닌 이유', 2)
IMGP('f10-iterations.png', '40회 반복과 시험 시점, 최고 체크포인트')
B(['40번 학습 = 같은 신경망 1개를 40번 고친 것이다. 매 반복이 끝나면 이전 가중치는 새 가중치로 덮인다.',
   'run1을 학습할 때는 최고(policy-best.json)와 마지막(policy-last.json)만 저장하게 만들었다. 이번에는 40회째가 최고라 두 파일이 같은 시점이다.',
   '중간 시점을 비교할 수 있게, 다음 학습부터는 시험할 때마다(5회마다) checkpoints/iter-NNN.json을 저장한다(iter-000 = 모방 직후). run1의 중간 정책은 저장되지 않아 되살릴 수 없다.',
   '40회 동안의 기록(반복별 회수율·보상·헛질·KL·표준편차 등)은 모두 train-curve.json에 있다.'])

H('5.6 학습 곡선', 2)
IMGP('f11-curve.png', '학습 곡선 — 연습(회색)과 시험(파랑) 회수율, 헛질·보정 횟수')
rows = [['시점', '시험 회수율', '보상', '헛질', '보정']]
rows.append(['교사(규칙 경로)', pct(BC[-1]['rate']), f"{BC[-1]['ret']:.0f}", f"{BC[-1]['empties']:.1f}", f"{BC[-1]['repaired']:.1f}"])
for e in EV:
    lab = '모방 직후' if e['iter'] == 0 else f"PPO {e['iter']}"
    best = e['iter'] == BEST['iter']
    rows.append([f'**{lab} (채택)**' if best else lab, f"**{pct(e['rate'])}**" if best else pct(e['rate']), f"{e['ret']:.0f}", f"{e['empties']:.1f}", f"{e['repaired']:.1f}"])
T(rows, widths=[4.5, 3, 2.5, 2.5, 2.5], font=8.5)
B(['모방 직후에는 오히려 39%로 떨어졌다. 규칙 경로는 레인을 좌·우 끝(Y ±670)에서 번갈아 고르는데, 신경망이 이를 평균 내 가운데(Y ≈ 0)를 고르게 됐기 때문이다(여러 정답이 있는 문제를 평균으로 배우는 모방 학습의 약점).',
   'PPO 5회 만에 57%로 회복하고 헛질이 2.3회로 줄었다. 15회 63%, 이후 56~60%를 오가다 40회에 72%(헛질 2.3)가 나왔다.',
   '곡선이 들쭉날쭉하다. 시험이 시드 3개뿐이라 운의 영향이 크다. 학습량을 늘리고 시험 시드를 늘려야 한다(8.2절).'])
doc.add_page_break()

H('5.7 학습 환경과 평가 환경은 다르다', 2)
T([['', '학습 환경 (StrokeEnv)', '평가 환경 (전체 셀 시뮬레이터 runEpisode)'],
   ['용도', 'PPO 연습·시험 (빠르게 많이)', '최종 성능 확인, 3D 재생 파일'],
   ['로봇', '대형 로봇만', '대형 + 측면 로봇(구성에 따라), 측면은 기존 경로'],
   ['시간 진행', '스트로크 단위로 바로 다음 결정', '60 Hz 실제 셀 루프(측면 → 안전 게이트 → 물리)'],
   ['측면 로봇 구역', '없음', '모드 1이면 대형은 |Y| ≤ 230만'],
   ['보고서의 숫자', 'train-report.md 학습 곡선 (예: 71.9%)', 'cell-eval-*.md (예: 단독 평균 ' + pct(A_PPO) + ')']], widths=[3, 6.5, 7.5], bold_first_col=True)
P('그래서 학습 곡선의 최고값(71.9%)과 전체 셀 평가값이 다르다. 실제 성능은 오른쪽 평가값으로 판단한다.', size=9.5)

H('5.8 정책 실행기와 평가 중 고친 버그', 2)
IMGP('f12-runner.png', '정책 실행기 안전장치와 발견한 버그 3건')
NOTE('학습 직후 자동 평가에서 시드 11·12·13이 50.6% / 33.1% / 43.1%로 나왔다. 정책이 나빠서가 아니라 실행기 버그 ①이 원인이었다. '
     '덤프 뒤 복귀 자세가 매번 같은데, 실행기가 "같은 자세 = 계획 실패 후 재시도"로 판단해 무작위 행동으로 바꿨고, 6번 뒤 대형 로봇이 작업을 멈췄다. '
     '고친 뒤 다시 잰 값이 5.9절이다. 이때 만든 3D 재생 파일(eval-s11~13)은 잘못된 결과라 삭제했다.', fill='FBE0E0', title='정정 기록')

H('5.9 결과 — 전체 셀 10분 과제', 2)
IMGP('f13-results.png', '규칙 경로 · PPO 정책 · 진화 탐색 비교 (10분 회수율)')
rows = [['구성', '시드', 'PPO 정책', '규칙 경로', '차이', '스트로크', '보정', '규칙 대체']]
for cfg, rs in [('대형 단독', EA), ('측면 2대 모드 1', EM)]:
    for r in rs:
        rows.append([cfg, str(r['seed']), f"**{pct(r['ppo'])}**", pct(r['rule']), dp(r['ppo'], r['rule']), str(r['strokes']), str(r['repaired']), str(r['fallback'])])
rows.append(['대형 단독', '평균', f'**{pct(A_PPO)}**', pct(A_RULE), dp(A_PPO, A_RULE), '', '', ''])
rows.append(['측면 2대 모드 1', '평균', f'**{pct(M_PPO)}**', pct(M_RULE), dp(M_PPO, M_RULE), '', '', ''])
T(rows, widths=[3.4, 1.3, 2.2, 2.2, 2, 1.8, 1.4, 1.9], font=8.5)
B([f'대형 단독: 평균으로 규칙 경로보다 {A_PPO - A_RULE:+.1f}%p. 시드 12·13은 크게 높고 시드 11은 낮다. 아직 상황마다 고르지 않다.',
   f'측면 2대(모드 1): 규칙보다 {M_PPO - M_RULE:+.1f}%p. 정책을 대형 단독 셀에서만 학습해서, Y ±670 범위로 배운 행동이 |Y| ≤ 230으로 잘리기 때문이다.',
   '진화 탐색(약 75%)에는 못 미친다. 진화 탐색은 결정마다 128번 미리 해 보는 반면, 정책은 한 번에 결정하기 때문이다. 정책은 현장에서 쓸 수 있다는 점이 다르다.',
   '"보정" 열: 정책 값이 그대로는 계획이 안 돼 실행기가 고친 스트로크 수. 15개 중 5~8개로 많다. 학습 환경에도 보정 규칙이 있어 정책이 "보정될 것"을 전제로 배운 영향이다. 줄여야 할 지표다.'])
doc.add_page_break()

# =============================================================== 6. 결과 파일
H('6. 결과 파일 구조와 이름 규칙')
IMGP('f16-results-tree.png', 'results/ 폴더 구조 (2026-11-06 정리)')
P('이름 규칙: 3D 재생 파일 = <방법>-<구성>-s<시드>.rsim.json.gz. 방법은 rule(규칙 경로) · cem(진화 탐색) · ppo(PPO 정책), 구성은 alone(대형 단독) · mode1 · mode2(측면 2대)다. '
  '폴더 이름은 단계(baseline · cem · ppo) / <로봇>-<구성>-s<시드> 또는 <로봇>-<학습 이름>이다.')
H('6.1 이전 이름 → 새 이름', 2)
T([['이전', '새 이름', '비고'],
   ['results/baseline.md · baseline.json', 'results/baseline/report.md · data.json', '단계별 폴더로'],
   ['results/lab/alone-s11/', 'results/cem/kr210-alone-s11/', '방법(cem)·로봇 이름을 경로에'],
   ['…/episode.rsim.json.gz · rule.rsim.json.gz', '…/cem-alone-s11.rsim.json.gz · rule-alone-s11.rsim.json.gz', '파일만 봐도 조건을 알 수 있게'],
   ['ppo/kr210-run1/policy.json', 'policy-best.json', '"최고 체크포인트"임을 이름에'],
   ['curve.json · report.md', 'train-curve.json · train-report.md', '학습 기록임을 이름에'],
   ['eval-alone.md · eval-mode1.md', 'cell-eval-alone.md · cell-eval-mode1.md', '전체 셀 평가임을 이름에'],
   ['eval-alone-s11.rsim.json.gz 등', 'ppo-alone-s11.rsim.json.gz', 'rule-alone-s11과 짝'],
   ['eval-s11~13.rsim.json.gz', '(삭제)', '버그 있던 실행기로 만든 잘못된 결과'],
   ['episodes/kr210-ur10e1-irb12001-s11-600s', 'episodes/rule-kr210-L-ur10e-m1_R-irb1200-m1-s11-600s', '왼쪽·오른쪽·모드를 구분'],
   ['(없음)', 'ppo/<이름>/checkpoints/iter-NNN.json', '다음 학습부터 5회마다 저장']], widths=[6, 7, 4], font=8.5)
P('3D 재생 파일과 log.json은 용량 때문에 git에 올리지 않는다. 같은 명령을 다시 실행하면 같은 결과가 나온다(시드 고정, 결정적 실행).', size=9)

# =============================================================== 7. 사용법
H('7. 직접 해 보기')
H('7.1 앱에서', 2)
B(['v3.0.0/start.bat 실행 → http://localhost:8300',
   '학습 정책 실행: 오른쪽 "학습 (Trial & Error)" → [정책 불러오기 (PPO)] → results/ppo/kr210-run1/policy-best.json → ▶ 학습 시작 → 끝나면 [학습 결과 3D 재생]',
   '진화 탐색: 같은 패널에서 방법 "진화 탐색(CEM)", 점수 규칙·시도 범위를 정하고 ▶ 학습 시작 (브라우저 Worker)',
   '헤드리스 결과 보기: "에피소드 재생" → [에피소드 불러오기] → *.rsim.json.gz (재생·일시정지·배속 0.25~20×·시간 이동)'])
IMGP('app-policy-replay.png','앱에서 PPO 정책 실행 결과를 3D로 재생하는 화면', 16)
H('7.2 명령으로 (v3.0.0 폴더에서)', 2)
T([['목적', '명령', '결과 위치'],
   ['기준선', 'node tools/baseline.mjs', 'results/baseline/'],
   ['진화 탐색', 'node tools/train.mjs --config alone --seed 11 --population 32 --iterations 4', 'results/cem/kr210-alone-s11/'],
   ['PPO 학습', 'node tools/ppo-train.mjs --iterations 40 --bc 3 --workers 14 --out results/ppo/kr210-run2', 'results/ppo/kr210-run2/'],
   ['PPO 이어서 학습', 'node tools/ppo-train.mjs --resume results/ppo/kr210-run1/policy-last.json --bc 0 …', '새 폴더'],
   ['정책 평가', 'node tools/ppo-eval.mjs --policy results/ppo/kr210-run1/policy-best.json --config mode1', '같은 폴더 cell-eval-mode1.md'],
   ['단발 실행', 'node tools/episode.mjs --config mode1 --seed 11', 'results/episodes/']], widths=[2.8, 9.7, 4.5], font=8)
doc.add_page_break()

# =============================================================== 8. 다음
H('8. 한계와 다음 단계')
H('8.1 지금의 한계', 2)
B(['80% 목표 미달(최고: 진화 탐색 75.6%, PPO 시드 13 71.9%).',
   '모든 숫자는 구형 입자 근사 시뮬레이터 결과다. 실제 드로스는 점착·덩어리가 있어 차이가 가장 크다(sim-to-real).',
   '시험 시드가 3개뿐이라 숫자 편차가 크다. 학습에 안 쓴 시험 세트·분포가 필요하다(PRD 4.5).',
   'PPO는 대형 단독 셀에서만 학습했다. 측면 로봇 셀에서는 규칙보다 낮다.',
   '관측은 아직 정답 입자 위치 기반이다(가상 카메라 전).'])
H('8.2 개선안 (우선순위 제안)', 2)
T([['#', '개선', '기대 효과', '근거'],
   ['①', '진화 탐색의 최선 스트로크를 모방 교사로', '출발점 39% → 70%대, 학습 시간 단축', '지금 교사(규칙, 60%)보다 CEM(75%)이 좋은 교사'],
   ['②', '측면 로봇·구역 제약을 학습 환경에', '3대 셀에서도 규칙 이상', '모드 1 결과가 규칙보다 낮음'],
   ['③', '학습량 늘리기 + 시험 시드 늘리기 + 모집단 학습(PBT)', '시드 간 편차 감소, 안정적 최고 선택', '곡선이 들쭉날쭉'],
   ['④', '보정 횟수에 벌점 / 학습 환경에서 보정 끄기', '정책이 처음부터 가능한 스트로크를 냄', '보정 5~8/15'],
   ['⑤', 'PROMPTS 2단계: 상부 가상 카메라 관측', '현장과 같은 입력', 'PRD 5장']], widths=[0.8, 5.6, 5, 5.6], font=8.5)
H('8.3 현장 적용 구조', 2)
IMGP('f15-hardware.png', '현장 적용 구성과 단계 H0~H5 (PRD 9장)')
B(['정책은 시뮬레이터와 같은 격자를 입력으로 받으므로, 카메라 인식이 같은 격자를 만들면 정책을 바꾸지 않고 쓸 수 있다.',
   '정책이 고른 스트로크도 현장에서는 디지털 트윈(실측 보정 셀 모델)의 계획·안전 필터를 통과해야 로봇에 간다.',
   '실제 로봇에서는 학습하지 않는다. H0(오프라인 재생) → H1(섀도 모드: 제안만 하고 사람이 비교) → … 순서로 올린다. v3.0.0은 H0·H1 준비까지, 실제 시범은 v3.1.0이다.'])

# =============================================================== 부록
H('부록 A. 코드 지도 (v3.0.0)')
T([['파일', '역할'],
   ['js/task-eval.js', '작업 설정(목표·시간·영역·AI 로봇) 검증, 회수율 평가기'],
   ['js/cell-sim.js', '헤드리스 셀 시뮬레이터 runEpisode (60 Hz: 측면 → 안전 게이트 → 물리), 규칙 드라이버, mainChooser 연결점'],
   ['js/dross.js', '셀 상수, planSkimCycle (스트로크 → 진입·스윕(J6 회전)·들기·운반·덤프 자세)'],
   ['js/stroke-lab.js', '스트로크 9변수·점수 규칙·후보 평가·진화 탐색·StrokeEnv(학습 환경)·정책 실행기(makePolicyChooser)'],
   ['js/ppo.js', '순수 JS 신경망·Adam·PPO·GAE·모방 학습·정책 파일(robosim-policy/1)'],
   ['js/replay.js · replay-panel.js', '에피소드 기록(0.1 s 프레임)과 3D 재생'],
   ['js/lab-panel.js · lab.worker.js · lab-eval.worker.js', '앱 학습 창과 브라우저 Worker'],
   ['tools/baseline.mjs · train.mjs · ppo-train.mjs · ppo-eval.mjs · episode.mjs', '헤드리스 명령 도구 (7.2절)'],
   ['tools/lib/policy-eval.mjs', '정책 vs 규칙 전체 셀 평가 공용 모듈'],
   ['docs/build/figures.py · make_docx.py', '이 문서의 그림·Word 생성 스크립트']], widths=[6.5, 10.5], font=8.5)
H('부록 B. 결정 기록 (PRD 0장 발췌)')
T([['#', '결정'],
   ['D1', '학습 대상 자유도 = J1~J6 전 관절'],
   ['D2', '행동 방식 = B(계층형 + 관절 직접) 먼저, A는 비교 후보'],
   ['D3·D5', '목표 회수율·제한 시간 = 설정값 (기본 80%, 600 s)'],
   ['D4', '기준 영역 = 스나우트 앞 작업 영역'],
   ['D6', 'AI 로봇 = 3대 중 선택, 나머지는 기존 경로'],
   ['D7', '회수율 = 셀 전체 합계 (사용자 확인)'],
   ['D8', '센서 = 상부 카메라 1~2대, 시뮬레이터에 같은 가상 카메라'],
   ['D11', '강화학습 기반, 다양한 상황에서 탐색하고 최선만 채택'],
   ['D12', '헤드리스 결과 3D 재생'],
   ['D13', '학습 엔진 = 순수 JS (Python·PyTorch 대신)'],
   ['D14', '학습 설정 창 (점수 규칙 +/−, 시도 범위, 방법)']], widths=[1.6, 15.4], font=8.5)

doc.save(OUT)
print('saved', OUT, 'figures', FIG[0])
