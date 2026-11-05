# results/ — v3.0.0 실행·학습 결과

그림으로 된 설명은 `../docs/RoboSim_v3.0.0_AI학습_기술문서.docx` 6장에 있습니다.

## 폴더 = 단계
| 폴더 | 단계 | 만드는 명령 |
|---|---|---|
| `baseline/` | 0단계: 규칙 경로(v1.1.2)만으로 잰 기준선 | `node tools/baseline.mjs` |
| `cem/<로봇>-<구성>-s<시드>/` | 1단계: 진화 탐색(CEM). 결정마다 후보를 미리 시도해 최선만 실행 | `node tools/train.mjs --config <구성> --seed <시드>` |
| `ppo/<로봇>-<학습 이름>/` | 2단계: PPO 강화학습. 연습으로 만든 신경망 정책 | `node tools/ppo-train.mjs --out results/ppo/<이름>` |
| `episodes/` | 단발 헤드리스 실행 (git 제외) | `node tools/episode.mjs` |

## 이름 규칙
- **구성**: `alone` = 대형 단독, `mode1` = 대형 + 좌 UR10e · 우 IRB 1200 (측면 로봇이 각자 박스에 담음), `mode2` = 대형 + 좌·우 UR10e (측면 로봇이 대형 레인으로 밀어 줌)
- **시드**: 드로스 배치를 만드는 난수 번호. 같은 시드끼리 비교하면 시작 배치가 같다.
- **3D 재생 파일**: `<방법>-<구성>-s<시드>.rsim.json.gz`. 방법은 `rule`(규칙 경로) · `cem`(진화 탐색) · `ppo`(PPO 정책)이다. 앱 '에피소드 재생'에서 연다.
- **episodes/**: `<대형 제어>-<대형>-<구성>-s<시드>-<시간>s.rsim.json.gz`. 측면 로봇이 있으면 구성 자리에 `L-<왼쪽>-m<모드>_R-<오른쪽>-m<모드>`를 쓴다.

## 폴더별 파일
**baseline/**
- `report.md`: 대형 4종 × 구성 3 × 시드 3 표
- `data.json`: 실행별 전체 수치

**cem/<로봇>-<구성>-s<시드>/**
- `report.md`: 학습 vs 규칙 비교, 결정별 최선 스트로크
- `cem-<구성>-s<시드>.rsim.json.gz` · `rule-<구성>-s<시드>.rsim.json.gz`: 3D 재생 (git 제외)
- `log.json`: 모든 후보 시도 (git 제외)

**ppo/<로봇>-<학습 이름>/**
| 파일 | 뜻 |
|---|---|
| `policy-best.json` | **최종 채택 정책.** 5회마다 고정 시드로 시험해 점수가 가장 높았던 시점. 앱 [정책 불러오기 (PPO)]로 쓰는 파일 |
| `policy-last.json` | 마지막 반복의 정책. `--resume`으로 이어서 학습할 때 |
| `checkpoints/iter-NNN.json` | 시험할 때마다 저장한 중간 정책. `iter-000`은 모방 직후. `kr210-run1`에는 없다(이 기능 추가 전 학습) |
| `train-curve.json` | 반복마다 기록: 회수율·보상·헛질·KL·표준편차·경과 시간 |
| `train-report.md` | 학습 설정, 학습 곡선 표 |
| `cell-eval-<구성>.md` | 전체 셀 10분 과제에서 정책 vs 규칙 (시드별 표) |
| `ppo-<구성>-s<시드>.rsim.json.gz` · `rule-<구성>-s<시드>.rsim.json.gz` | 위 평가의 3D 재생 (git 제외) |

- **"40번 학습"의 뜻**: 신경망 하나를 40번 고쳐 쓴 것이다. 반복마다 파일이 생기지 않는다.
- **용량 큰 파일**: `.rsim.json.gz`와 `log.json`은 git에 올리지 않는다(`.gitignore`). 같은 명령을 다시 실행하면 같은 결과가 나온다(시드 고정, 결정적 실행).
