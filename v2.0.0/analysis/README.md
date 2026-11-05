# analysis/ — Python 분석 파이프라인 (오프라인)

> PRD_v.2.0.0.md FR-48~50, PROMPTS.md 6·8단계. 앱(브라우저)은 결과 `thresholds.json`만 읽는다.
> 전류·토크는 시뮬레이터의 **근사 동역학 추정값**이다. 여기서 구한 threshold 절대값을 실제 로봇에 그대로 쓰지 않는다(PRD 7.4).

## 환경 준비 (전역 설치 금지 — 이 폴더의 가상환경만)
```
cd v2.0.0/analysis
python -m venv .venv
.venv\Scripts\activate          (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
```

## 스크립트 (6단계에서 작성)
| 순서 | 파일 | 역할 |
|---|---|---|
| 1 | `to_parquet.py` | `out/<run>/samples/*.csv.gz` → Parquet, 품질 검사 |
| 2 | `features.py` | 샘플·창(1~2 s) 특징. 자세는 쿼터니언·sin/cos |
| 3 | `split.py` | 에피소드 단위 분할 + 대형 로봇 1종 시험 전용(일반화) |
| 4 | `baseline_fixed.py` | 고정 threshold(정격 70·80·90%), 단계별 고정 |
| 5 | `band_model.py` | 상황 조건부 정상 밴드(분위수 회귀 + conformal 보정) |
| 6 | `risk_model.py` | `pre_anomaly_3s` 분류 + 결정 트리 가이드라인 규칙 + SHAP |
| 7 | `risk_map.py` | 작업 공간 위험 지도 |
| 8 | `evaluate.py` | 검출률@오경보 1%, AUROC/AUPRC, 선행 시간, 시간당 오경보 |
| 9 | `export_thresholds.py` | 앱용 `thresholds.json` (`robosim-thresholds/1`) |
| 10 | `report.py` | `report.md` 자동 작성 |
| (P2) | `propose.py` | 적응 샘플링: 경계 근처 다음 시나리오 → `proposals.json` |
| (P3) | `import_rtde.py` | UR RTDE 실제 로그 → 데이터 스키마 v2 |

## 주의
- 분할은 반드시 에피소드 단위로 한다(행 단위 무작위 분할 금지 — 데이터 누수).
- `t_to_anomaly_s`, `pre_anomaly_*`는 미래 정보다. 정답으로만 쓰고 특징에는 넣지 않는다.
- `.venv/`, `*.parquet`, 결과 그림은 git에 넣지 않는다(루트 `.gitignore`).
