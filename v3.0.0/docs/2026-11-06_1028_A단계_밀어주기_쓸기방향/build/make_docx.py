# RoboSim Lite v3.0.0 — [A] 단계 보고서 (Word) 생성, 2026-11-06 10:28
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


fp.add_run('RoboSim Lite v3.0.0 · [A] 단계 보고서 (2026-11-06 10:28) — ').font.size = Pt(8)
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


# =============================================================== [A] 단계 보고서 본문 (2026-11-06 10:28)
SRC = {
    'alone': 'results/2026-11-06/1022_baseline_kr210_alone_lane-dir/data.json',
    'push': 'results/2026-11-06/1022_baseline_kr210_mode2-vs-push/data.json',
    'first': 'results/2026-11-06/0952_baseline_kr210_push-test_lane-dir/data.json',
}
DATA = {k: json.loads(read(v)) for k, v in SRC.items()}


def runs(key, config, lane):
    return sorted([r for r in DATA[key]['results'] if r['config'] == config and r.get('laneDir', 'robot') == lane], key=lambda r: r['seed'])


def m(rs, k='rateCount'):
    return sum(r['summary'][k] for r in rs) / len(rs)


AR, AS, AA = runs('alone', 'alone', 'robot'), runs('alone', 'alone', 'snout'), runs('alone', 'alone', 'alternate')
M2, M3 = runs('push', 'mode2', 'robot'), runs('push', 'push', 'robot')

doc.add_paragraph().paragraph_format.space_after = Pt(40)
t = doc.add_paragraph('RoboSim Lite v3.0.0', style='Title'); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('[A] 단계 보고서\n측면 로봇 밀어 주기 · 대형 스쿱 반대 방향 회수'); r.font.size = Pt(15); r.bold = True
doc.add_paragraph().paragraph_format.space_after = Pt(18)
T([['항목', '내용'],
   ['작성', '2026-11-06 10:28 (이 문서는 덮어쓰지 않는다. 다음 결과는 새 날짜·시각 폴더)'],
   ['이전 문서', 'docs/2026-11-06_0845_AI학습_기술문서 (학습 구조 전체)'],
   ['사용자 요청', '① 측면 로봇은 회수하지 않고 가운데로 밀어 주기만, 대형 로봇만 회수\n② 스쿱 열린 면이 로봇이 아니라 반대(스나우트) 쪽을 보게 쓸어 스나우트 앞 드로스까지 회수, 들고 오는 동작까지 최적화\n③ 결과·문서를 날짜·시각별로 남기고 git도 시각별로 기록'],
   ['범위', '규칙 경로(학습 없음)로 셀 동작을 먼저 만들고 측정. 학습([B] CEM 시범, [C] PPO)은 다음 단계'],
   ['결과 폴더', 'results/2026-11-06/1022_baseline_kr210_alone_lane-dir, 1022_baseline_kr210_mode2-vs-push (처음 설계: 0952_…, NOTE.md)'],
   ['코드 커밋', 'd1708ee [2026-11-06 09:56 KST] 이후 이 보고서와 함께 커밋']], widths=[3, 14])
NOTE(f'• 대형 단독 셀에서 쓸기 방향을 번갈아(alternate) 하면 10분 회수율 {pct(m(AA))} — 기존(로봇 쪽) {pct(m(AR))}보다 {m(AA) - m(AR):+.1f}%p. 시드 11은 78.1%로 목표 80%에 가장 가깝다.\n'
     f'• 스나우트 쪽으로만 쓸면 {pct(m(AS))}로 오히려 낮다(운반 전 물러나기·돌리기로 사이클이 길어짐: 사이클 {m(AS, "mainCycles"):.1f}회 vs {m(AR, "mainCycles"):.1f}회).\n'
     f'• 측면 로봇 2대가 밀어 주기만 하는 셀: 새 타이밍 밀기(모드 3) {pct(m(M3))} — 기존 잠금 밀기(모드 2) {pct(m(M2))}보다 {m(M3) - m(M2):+.1f}%p. 아직 대형 단독({pct(m(AR))})보다는 낮다.\n'
     '• 물리 엔진 버그 1건 수정(쿼터니언 부호) — 스쿱을 돌리는 동작에서 드로스가 튕겨 나가던 원인. 기존 결과는 그대로 재현된다.',
     fill='EAF3FB', title='요약')
doc.add_page_break()

H('1. 실험 설계')
IMGP('a01-design.png', '[A] 단계 실험 조건')
B(['모든 실행: KR 210 R2700, 10분(600 s), 작업 영역 드로스 160개, 시드 11·12·13, 대형은 규칙 경로(학습 없음).',
   '회수율 = 모든 박스에 들어간 드로스 ÷ 작업 영역 초기 드로스(개수). 시뮬레이터(구형 입자 근사) 결과다.',
   '명령: node tools/baseline.mjs --mains kuka-kr210-r2700 --configs alone --lane-dir robot,snout,alternate / --configs mode2,push'])

H('2. 결과')
IMGP('a02-results.png', '쓸기 방향(왼쪽)과 측면 로봇 역할(오른쪽)별 10분 회수율')
rows = [['조건', '시드 11', '시드 12', '시드 13', '평균', '대형 사이클', '흘림']]
for lab, rs in [('단독 · 로봇 쪽 (기존)', AR), ('단독 · 스나우트 쪽만', AS), ('단독 · 번갈아', AA), ('측면 2대 모드 2 (잠금 밀기)', M2), ('측면 2대 모드 3 (타이밍 밀기)', M3)]:
    rows.append([lab] + [f"{r['summary']['rateCount']:.1f}%" for r in rs] + [f'**{pct(m(rs))}**', f"{m(rs, 'mainCycles'):.1f}", f"{m(rs, 'spilled'):.1f}"])
T(rows, widths=[5.2, 1.9, 1.9, 1.9, 2, 2.1, 1.6], font=8.5)
H('2.1 해석', 2)
B([('번갈아가 가장 좋은 이유(추정): ', '로봇 쪽으로 쓸면 스나우트 앞 띠(스쿱이 처음 내려가는 자리 뒤쪽)가 남고, 스나우트 쪽으로 쓸면 앞벽 쪽 띠가 남는다. 번갈아 쓰면 두 끝을 모두 훑는다. 스나우트 쪽 사이클은 길지만(물러나기·돌리기 약 12 s 추가) 번갈아 쓰면 사이클당 회수가 늘어난다(대형 단독 평균 사이클당 회수: 번갈아 9.7개, 스나우트 쪽만 7.9개, 로봇 쪽 7.0개).'),
   ('스나우트 쪽만 쓰면 낮은 이유: ', '사이클이 14회 → 10회로 줄고, 앞벽 쪽 띠를 쓸지 못한다.'),
   ('모드 3이 모드 2보다 좋은 이유: ', '측면 로봇이 대형이 돌아오기 전에 끝낼 수 있는 밀기만 시작해 대형이 덜 기다린다. 흘림도 줄었다(11.3 → 8.0).'),
   ('모드 3이 아직 단독보다 낮은 이유: ', '대형 사이클이 14회 → 11.3회. 측면 로봇이 포트에 있으면 대형이 여전히 기다리는 경우가 있고(안전), 측면은 각 8회만 밀고 "밀어 줄 드로스 없음"으로 쉰다. 밀어 준 드로스가 모이는 자리와 대형의 레인 선택이 맞지 않을 수 있다 → 학습([C])에서 대형이 측면이 밀어 준 자리를 고르도록.')])
doc.add_page_break()

H('3. 스쿱 반대 방향(스나우트 쪽) 회수 동작')
IMGP('a03-snout-stroke.png', '스나우트 쪽 쓸기 사이클: 스윕 → 들어 올림 → 물러나기 → 천천히 돌리기 → 운반')
T([['단계', '내용', '이전 동작과 차이'],
   ['① 스윕', '앞벽 쪽(x 1330)에서 스나우트 쪽(x 2070)으로, 열린 면이 스나우트를 봄', '방향 반대'],
   ['② 들어 올림', '스나우트 앞에서 들어 올리고 뒤로 12° 기울임(앞쪽이 위)', '같음'],
   ['③ 물러나기', '담은 채 로봇 쪽으로 450 mm, 가운데 쪽(|Y| ≤ 400)으로', '새 단계'],
   ['④ 돌리기', 'J6로 180° 회전, 30°/s, 30°씩 6구간. 시계·반시계 중 J6가 덜 감기는 쪽', '새 단계'],
   ['⑤ 운반·덤프', '열린 면이 로봇 쪽을 보는 자세로 박스까지 → 기존과 같은 덤프', '같음']], widths=[2.5, 10, 4.5], font=8.5)
H('3.1 만들면서 겪은 문제와 해결', 2)
T([['#', '증상', '원인', '해결'],
   ['1', '박스로 옮기는 중 2사이클에 드로스 26~33개가 포트 밖으로 튕김', '열린 면이 바깥을 본 채 운반하며 손목이 크게 돌았다', '들어 올린 뒤 돌려서 운반(③④)'],
   ['2', '돌리기 계획 실패 (스나우트 충돌)', '스나우트(높이 1200 mm) 옆에서 회전', '450 mm 물러난 뒤 돌림'],
   ['3', '몇 사이클 뒤 도달 불가', 'J6가 같은 쪽으로 계속 감김', '두 방향 계산, 덜 감기는 쪽'],
   ['4', '30°/s로 늦춰도 튕김', '물리 엔진 쿼터니언 부호 버그(4장)', 'continuousRot'],
   ['5', '측면 로봇 셀에서 대형이 막힘(19 mm)', '스나우트 쪽 경로가 측면 로봇과 가까움', '규칙 경로는 단독 셀에서만(6장)']], widths=[0.7, 5.3, 5.5, 5.5], font=8.3)

H('4. 물리 엔진 수정: 회전 부호')
IMGP('a05-quat.png', '쿼터니언 부호가 뒤집히면 한 스텝에 360° 회전으로 계산되던 문제')
B(['로봇 링크·툴은 운동학 바디로 매 스텝 다음 자세를 받는다. 자세를 회전 행렬에서 쿼터니언으로 바꾸는 계산의 분기가 바뀌면 같은 자세라도 부호가 뒤집힌 값(−q)이 나온다.',
   '이때 물리 엔진은 1/60 s에 한 바퀴 돈 것으로 보고 큰 각속도를 주어, 스쿱 안 드로스를 멀리(최대 5 m) 튕겨 냈다. 스쿱을 크게 돌리는 동작에서만 드러났다.',
   '수정: 직전 회전과 내적이 음수면 부호를 뒤집어 넘긴다(js/physics.js continuousRot). 로봇 쪽 쓸기 기준선 61.3%는 수정 전후 같다(재현 확인). 진화 탐색·PPO에서 스쿱을 돌리는 후보의 흘림도 줄어들 수 있다.'])
doc.add_page_break()

H('5. 측면 로봇 모드 3: 타이밍 밀기')
IMGP('a04-timing.png', '모드 2(잠금)와 모드 3(타이밍)의 밀기 시점 (개념도)')
H('5.1 처음 설계(구역 분리)를 바꾼 이유', 2)
B(['처음에는 공간을 나눠 동시에 작업하게 했다: 대형은 가운데(스쿱 중심 |Y| ≤ 230), 측면은 벽에서 |Y| 440까지 밀기, 잠금 없음.',
   '측정(0952 실행): 대형 스쿱과 밀대 사이가 30 mm 안팎이라 안전 게이트가 대형을 세우고, 측면 로봇도 기다리다 20 s 뒤 오류로 멈추는 교착이 시드 13에서 생겼다(회수율 0%). 3회 평균 33.8%.',
   '그래서 시간을 나누는 방식으로 바꿨다: 측면은 대형이 포트 밖(운반·덤프·복귀)에 있고, 대형이 돌아오기 전(etaS)에 밀기 전체 + 1.5 s를 끝낼 수 있을 때만 시작한다. 6 s 미만이면 시작하지 않는다. 대형은 포트 전체 폭을 쓴다.',
   '대형은 측면이 포트에서 나간 뒤에 다음 사이클을 계획하고, 대기 중인 측면 로봇(링크 + 밀대)을 상자 장애물로 계획에 넣는다.'])
H('5.2 실행 기록', 2)
T([['실행 폴더', '내용', '상태'],
   ['0952_baseline_kr210_push-test_lane-dir', '모드 3 구역 분리 + 측면 셀의 스나우트 쪽 쓸기 포함 27회', '설계 변경 전 기록 (NOTE.md)'],
   ['1022_baseline_kr210_alone_lane-dir', '단독 · 쓸기 방향 3가지 × 시드 3', '이 보고서 결과'],
   ['1022_baseline_kr210_mode2-vs-push', '모드 2 vs 모드 3(타이밍) × 시드 3', '이 보고서 결과']], widths=[6.5, 6.5, 4], font=8.5)

H('6. 한계')
B(['측면 로봇이 있는 셀에서는 규칙 경로의 스나우트 쪽 쓸기를 쓰지 않는다. 시작점·운반 경로가 대기 중인 측면 로봇과 19 mm까지 가까워져 안전 게이트에 막혔고(가운데 레인만 써도 같음), 원인을 끝까지 좁히지 못했다. 이 조합은 학습 단계에서 충돌 검사를 통과한 후보만 채택하는 방식으로 다룬다.',
   '측면 로봇의 밀기 대상·순서는 규칙(드로스가 가장 많은 레인)이다. 대형이 회수하기 좋은 자리로 모아 주는 최적화는 아직 없다.',
   '시드 3개 평균이다. 단독 번갈아의 시드별 편차가 크다(66.3~78.1%).',
   '앱(브라우저) 화면의 측면 로봇 모드 선택에는 모드 3이 아직 없다. 헤드리스 실행과 3D 재생으로 확인한다.'])

H('7. 다음 단계 제안')
T([['#', '내용', '기대'],
   ['B', '진화 탐색(CEM) 시범 수집: 단독 셀 + 모드 3 셀, 후보에 스나우트 쪽·번갈아·열린 면 회전 포함', '좋은 교사 데이터 (규칙 번갈아 72.9%보다 높은 시범)'],
   ['C', 'PPO 재학습: 학습 환경에 모드 3 측면 로봇, 운반 동작(물러나기·돌리기)까지 포함, 교사 = B', '단독 80% 근접, 3대 셀에서 규칙 이상'],
   ['D', '상부 가상 카메라 관측 → 전후 비교 → 최종 재학습', '현장과 같은 입력'],
   ['(앱)', '측면 로봇 모드 3·쓸기 방향을 앱 화면에서도 선택', '눈으로 확인']], widths=[1, 9.5, 6.5], font=8.5)

doc.save(OUT)
print('saved', OUT, 'figures', FIG[0])
