// Node 테스트용 Rapier 로더. npm 설치 없이, 앱과 같은 CDN·같은 버전의 모듈을 받아 tests/.cache/에 저장해 둔다.
// (첫 실행에만 인터넷 필요, 약 4 MB). 버전을 바꾸면 index.html의 importmap과 함께 바꾼다.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAPIER_VERSION = '0.21.0';
const URL_ = `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@${RAPIER_VERSION}/dist/rapier.mjs`;
const cacheDir = fileURLToPath(new URL('../.cache/', import.meta.url));
const cacheFile = `${cacheDir}rapier3d-compat-${RAPIER_VERSION}.mjs`;

/** init()까지 끝난 RAPIER 모듈을 돌려준다 */
export async function loadRapier() {
  if (!existsSync(cacheFile)) {
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`Rapier 다운로드 실패: HTTP ${res.status} (${URL_})`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, Buffer.from(await res.arrayBuffer()));
  }
  const mod = await import(pathToFileURL(cacheFile));
  const RAPIER = mod.default ?? mod;
  await RAPIER.init();
  return RAPIER;
}
