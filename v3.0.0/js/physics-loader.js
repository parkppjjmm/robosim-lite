// 브라우저용 Rapier 로더 (PRD_v.1.1.0 FR-17, NFR-11).
// Rapier(WASM 내장, 약 4 MB)는 물리 모드를 처음 켤 때만 불러온다 → 고정 모드 화면은 기다리지 않는다.
// 모듈 주소와 버전은 index.html의 importmap("@dimforge/rapier3d-compat")에서 고정한다.
let pending = null;
let failures = 0;

/**
 * 모듈 주소: 처음엔 importmap 이름 그대로, 실패한 뒤에는 실제 주소에 ?retry=n을 붙인다 (v1.1.1, m-4).
 * 브라우저는 한 번 실패한 모듈 주소를 기억해서 같은 주소로는 새로고침 전까지 다시 받지 않기 때문이다.
 */
function moduleUrl() {
  const name = '@dimforge/rapier3d-compat';
  if (!failures) return name;
  let url;
  try {
    url = import.meta.resolve(name);
  } catch {
    return name;
  }
  return `${url}${url.includes('?') ? '&' : '?'}retry=${failures}`;
}

/** init()까지 끝난 RAPIER 모듈. 실패하면 다음 호출 때 다른 주소(?retry=n)로 다시 시도한다. */
export function loadRapier() {
  pending ??= import(/* @vite-ignore */ moduleUrl())
    .then(async (mod) => {
      const RAPIER = mod.default ?? mod;
      await RAPIER.init();
      return RAPIER;
    })
    .catch((err) => {
      pending = null;
      failures++;
      throw err;
    });
  return pending;
}
