// 브라우저용 Rapier 로더 (PRD_v.1.1.0 FR-17, NFR-11).
// Rapier(WASM 내장, 약 4 MB)는 물리 모드를 처음 켤 때만 불러온다 → 고정 모드 화면은 기다리지 않는다.
// 모듈 주소와 버전은 index.html의 importmap("@dimforge/rapier3d-compat")에서 고정한다.
let pending = null;

/** init()까지 끝난 RAPIER 모듈. 실패하면 다음 호출 때 다시 시도한다. */
export function loadRapier() {
  pending ??= import('@dimforge/rapier3d-compat')
    .then(async (mod) => {
      const RAPIER = mod.default ?? mod;
      await RAPIER.init();
      return RAPIER;
    })
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}
