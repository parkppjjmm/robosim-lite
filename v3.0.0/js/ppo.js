// PPO 강화학습 코어 (PRD_v.3.0.0 4.3 B-2·4.5, FR-60·62). 순수 JS, DOM 비의존 — Node(헤드리스 학습)와 브라우저(정책 실행)에서 같은 코드.
// 정책 = 작은 MLP(관측 → 스트로크 변수 9개의 평균, 0~1) + 학습되는 표준편차(대각 가우시안). 가치 = 같은 구조의 MLP(→ 1).
// 행동 1번 = 스트로크 1개(시작점·방향·길이·열린 면 방향(J6)·회전·기울임·깊이·속도). 관절값은 IK·안전 게이트가 만든다(계층형 B).
// 관측 = 작업 영역 드로스 격자(12 × 8 칸, 칸당 개수/4, 최대 1) + 남은 드로스 비율 + 시간 비율.

export const OBS_GRID = { nx: 12, ny: 8, x0: 1100, x1: 2300, y0: -900, y1: 900, perCell: 4 };
export const OBS_DIM = OBS_GRID.nx * OBS_GRID.ny + 2;
export const POLICY_SCHEMA = 'robosim-policy/1';

/** 관측 벡터: 욕면 드로스 [x, y, z, r, …](snapshotParticles 형식) → 격자 + 남은 비율 + 시간 비율 */
export function observe(particles, { initialCount, tFrac }) {
  const G = OBS_GRID;
  const o = new Float64Array(OBS_DIM);
  let n = 0;
  for (let i = 0; i < particles.length; i += 4) {
    const x = particles[i], y = particles[i + 1];
    if (x < G.x0 || x >= G.x1 || y < G.y0 || y >= G.y1) continue;
    const cx = Math.floor(((x - G.x0) / (G.x1 - G.x0)) * G.nx), cy = Math.floor(((y - G.y0) / (G.y1 - G.y0)) * G.ny);
    o[cy * G.nx + cx] += 1 / G.perCell;
    n++;
  }
  for (let k = 0; k < G.nx * G.ny; k++) o[k] = Math.min(1, o[k]);
  o[G.nx * G.ny] = initialCount ? n / initialCount : 0;
  o[G.nx * G.ny + 1] = tFrac;
  return o;
}

// ---------------------------------------------------------------------------
// MLP (tanh 은닉층, 선형 출력) + 역전파
// ---------------------------------------------------------------------------
export function initMLP(sizes, rand, outScale = 0.1) {
  const layers = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const nIn = sizes[l], nOut = sizes[l + 1];
    const s = (l === sizes.length - 2 ? outScale : 1) * Math.sqrt(1 / nIn);
    const W = new Float64Array(nIn * nOut).map(() => (rand() * 2 - 1) * s * Math.sqrt(3));
    layers.push({ nIn, nOut, W, b: new Float64Array(nOut) });
  }
  return { sizes: sizes.slice(), layers };
}

export function forward(net, x) {
  const acts = [x];
  let h = x;
  net.layers.forEach((L, l) => {
    const out = new Float64Array(L.nOut);
    for (let j = 0; j < L.nOut; j++) {
      let s = L.b[j];
      for (let i = 0; i < L.nIn; i++) s += h[i] * L.W[i * L.nOut + j];
      out[j] = l < net.layers.length - 1 ? Math.tanh(s) : s;
    }
    acts.push(out);
    h = out;
  });
  return { out: h, acts };
}

/** dout(출력 기울기) → 각 층 W·b 기울기를 grads에 더함 */
export function backward(net, acts, dout, grads) {
  let d = dout;
  for (let l = net.layers.length - 1; l >= 0; l--) {
    const L = net.layers[l], hIn = acts[l], G = grads[l];
    const dz = new Float64Array(L.nOut);
    for (let j = 0; j < L.nOut; j++) dz[j] = l < net.layers.length - 1 ? d[j] * (1 - acts[l + 1][j] ** 2) : d[j];
    const dIn = new Float64Array(L.nIn);
    for (let i = 0; i < L.nIn; i++) {
      let s = 0;
      for (let j = 0; j < L.nOut; j++) {
        G.W[i * L.nOut + j] += hIn[i] * dz[j];
        s += L.W[i * L.nOut + j] * dz[j];
      }
      dIn[i] = s;
    }
    for (let j = 0; j < L.nOut; j++) G.b[j] += dz[j];
    d = dIn;
  }
}

export const zeroGrads = (net) => net.layers.map((L) => ({ W: new Float64Array(L.W.length), b: new Float64Array(L.b.length) }));

/** Adam 최적화기 (파라미터 묶음: [{ p: Float64Array, g: Float64Array }]) */
export class Adam {
  constructor(lr = 3e-4, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
    Object.assign(this, { lr, b1, b2, eps, t: 0, m: new Map(), v: new Map() });
  }

  step(pairs, clipNorm = 0.5) {
    this.t++;
    let norm = 0;
    for (const { g } of pairs) for (const x of g) norm += x * x;
    norm = Math.sqrt(norm);
    const k = clipNorm && norm > clipNorm ? clipNorm / norm : 1;
    pairs.forEach(({ p, g }, idx) => {
      if (!this.m.has(idx)) {
        this.m.set(idx, new Float64Array(p.length));
        this.v.set(idx, new Float64Array(p.length));
      }
      const m = this.m.get(idx), v = this.v.get(idx);
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] * k;
        m[i] = this.b1 * m[i] + (1 - this.b1) * gi;
        v[i] = this.b2 * v[i] + (1 - this.b2) * gi * gi;
        const mh = m[i] / (1 - this.b1 ** this.t), vh = v[i] / (1 - this.b2 ** this.t);
        p[i] -= (this.lr * mh) / (Math.sqrt(vh) + this.eps);
      }
    });
    return norm;
  }
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const LOG2PI = Math.log(2 * Math.PI);

// ---------------------------------------------------------------------------
// 정책 (가우시안) · 가치
// ---------------------------------------------------------------------------
export function createAgent({ obsDim = OBS_DIM, actDim, hidden = [64, 64], rand, logStd0 = Math.log(0.15) }) {
  return {
    pi: initMLP([obsDim, ...hidden, actDim], rand, 0.1),
    vf: initMLP([obsDim, ...hidden, 1], rand, 1),
    logStd: new Float64Array(actDim).fill(logStd0),
    actDim,
  };
}

/** 평균(0~1)과 표준편차 */
export function policyDist(agent, obs) {
  const { out, acts } = forward(agent.pi, obs);
  const mean = Array.from(out, sigmoid);
  const std = Array.from(agent.logStd, (s) => Math.exp(s));
  return { mean, std, acts };
}

export function logProb(u, mean, logStd) {
  let s = 0;
  for (let j = 0; j < u.length; j++) {
    const z = (u[j] - mean[j]) / Math.exp(logStd[j]);
    s += -0.5 * z * z - logStd[j] - 0.5 * LOG2PI;
  }
  return s;
}

/** 행동 표본 (학습) 또는 평균 (deterministic = 실행) */
export function act(agent, obs, rand, deterministic = false) {
  const { mean, std } = policyDist(agent, obs);
  if (deterministic) return { u: mean.slice(), logp: logProb(mean, mean, agent.logStd), mean };
  const u = mean.map((m, j) => m + std[j] * gauss(rand));
  return { u, logp: logProb(u, mean, agent.logStd), mean };
}

export const value = (agent, obs) => forward(agent.vf, obs).out[0];

export function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** GAE(λ) 이점·목표 반환 (에피소드별) */
export function gae(rewards, values, gamma = 0.99, lambda = 0.95) {
  const n = rewards.length;
  const adv = new Array(n).fill(0);
  let last = 0;
  for (let t = n - 1; t >= 0; t--) {
    const next = t + 1 < n ? values[t + 1] : 0;
    const delta = rewards[t] + gamma * next - values[t];
    last = delta + gamma * lambda * last;
    adv[t] = last;
  }
  return { adv, ret: adv.map((a, t) => a + values[t]) };
}

/**
 * PPO 업데이트. batch = [{ obs, u, logp, adv, ret }]. 정책·가치·logStd를 갱신하고 통계를 돌려준다.
 * opts { epochs, minibatch, clip, entCoef, vfCoef, rand, optPi, optVf }
 */
export function ppoUpdate(agent, batch, { epochs = 8, minibatch = 32, clip = 0.2, entCoef = 0.003, rand, optPi, optVf, minLogStd = Math.log(0.02) }) {
  // 이점 정규화
  const mu = batch.reduce((s, b) => s + b.adv, 0) / batch.length;
  const sd = Math.sqrt(batch.reduce((s, b) => s + (b.adv - mu) ** 2, 0) / batch.length) + 1e-8;
  const data = batch.map((b) => ({ ...b, a: (b.adv - mu) / sd }));
  let kl = 0, clipFrac = 0, nPi = 0, vLoss = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = data.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [data[i], data[j]] = [data[j], data[i]];
    }
    for (let s = 0; s < data.length; s += minibatch) {
      const mb = data.slice(s, s + minibatch);
      const gPi = zeroGrads(agent.pi), gVf = zeroGrads(agent.vf);
      const gLs = new Float64Array(agent.actDim);
      for (const b of mb) {
        const { mean, acts } = policyDist(agent, b.obs);
        const lp = logProb(b.u, mean, agent.logStd);
        const r = Math.exp(lp - b.logp);
        kl += b.logp - lp;
        nPi++;
        const clipped = (b.a >= 0 && r > 1 + clip) || (b.a < 0 && r < 1 - clip);
        if (clipped) clipFrac++;
        // 손실 L = −min(r·A, clip(r)·A) − entCoef·Σ logStd  → dL/dlogp = −r·A (클립 안 될 때)
        const dlp = clipped ? 0 : -r * b.a;
        const dz = new Float64Array(agent.actDim);
        for (let j = 0; j < agent.actDim; j++) {
          const v2 = Math.exp(2 * agent.logStd[j]);
          const dm = (b.u[j] - mean[j]) / v2; // dlogp/dmean
          dz[j] = (dlp * dm * mean[j] * (1 - mean[j])) / mb.length; // sigmoid 미분
          gLs[j] += (dlp * (((b.u[j] - mean[j]) ** 2) / v2 - 1) - entCoef) / mb.length;
        }
        backward(agent.pi, acts, dz, gPi);
        // 가치 손실 0.5·(V − R)²
        const fv = forward(agent.vf, b.obs);
        const dv = (fv.out[0] - b.ret) / mb.length;
        vLoss += (fv.out[0] - b.ret) ** 2;
        backward(agent.vf, fv.acts, [dv], gVf);
      }
      optPi.step([...agent.pi.layers.flatMap((L, l) => [{ p: L.W, g: gPi[l].W }, { p: L.b, g: gPi[l].b }]), { p: agent.logStd, g: gLs }]);
      optVf.step(agent.vf.layers.flatMap((L, l) => [{ p: L.W, g: gVf[l].W }, { p: L.b, g: gVf[l].b }]), 5);
      for (let j = 0; j < agent.actDim; j++) agent.logStd[j] = Math.max(minLogStd, Math.min(Math.log(0.5), agent.logStd[j]));
    }
  }
  return { approxKl: kl / Math.max(1, nPi), clipFrac: clipFrac / Math.max(1, nPi), vLoss: vLoss / Math.max(1, nPi), std: Array.from(agent.logStd, (s) => +Math.exp(s).toFixed(3)) };
}

/** 모방 학습(BC): 평균을 교사 행동(규칙 경로 등)에 맞춤. samples = [{ obs, target(0~1) }] */
export function bcUpdate(agent, samples, { epochs = 20, minibatch = 32, rand, opt }) {
  let loss = 0, n = 0;
  for (let ep = 0; ep < epochs; ep++) {
    const data = samples.slice();
    for (let i = data.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [data[i], data[j]] = [data[j], data[i]];
    }
    for (let s = 0; s < data.length; s += minibatch) {
      const mb = data.slice(s, s + minibatch);
      const g = zeroGrads(agent.pi);
      for (const b of mb) {
        const { mean, acts } = policyDist(agent, b.obs);
        const dz = mean.map((m, j) => ((m - b.target[j]) * m * (1 - m) * 2) / mb.length);
        mean.forEach((m, j) => (loss += (m - b.target[j]) ** 2));
        n++;
        backward(agent.pi, acts, dz, g);
      }
      opt.step(agent.pi.layers.flatMap((L, l) => [{ p: L.W, g: g[l].W }, { p: L.b, g: g[l].b }]));
    }
  }
  return { mse: loss / Math.max(1, n * agent.actDim) };
}

/** 정책 저장 형식 (브라우저·Node 공통, 현장용 ONNX 변환의 입력) */
export function exportPolicy(agent, meta = {}) {
  return {
    schema: POLICY_SCHEMA,
    created: new Date().toISOString(),
    obs: { ...OBS_GRID, dim: OBS_DIM },
    actDim: agent.actDim,
    pi: { sizes: agent.pi.sizes, layers: agent.pi.layers.map((L) => ({ W: Array.from(L.W, (v) => +v.toPrecision(7)), b: Array.from(L.b, (v) => +v.toPrecision(7)) })) },
    vf: { sizes: agent.vf.sizes, layers: agent.vf.layers.map((L) => ({ W: Array.from(L.W, (v) => +v.toPrecision(7)), b: Array.from(L.b, (v) => +v.toPrecision(7)) })) },
    logStd: Array.from(agent.logStd),
    ...meta,
  };
}

export function importPolicy(obj) {
  if (obj?.schema !== POLICY_SCHEMA) throw new Error(`정책 파일 형식이 아닙니다 (schema = ${obj?.schema ?? '없음'}, 기대값 ${POLICY_SCHEMA}).`);
  if (obj.obs?.dim !== OBS_DIM) throw new Error(`관측 크기가 다릅니다 (${obj.obs?.dim} ≠ ${OBS_DIM}).`);
  const net = (n) => ({ sizes: n.sizes, layers: n.layers.map((L, l) => ({ nIn: n.sizes[l], nOut: n.sizes[l + 1], W: Float64Array.from(L.W), b: Float64Array.from(L.b) })) });
  return { pi: net(obj.pi), vf: net(obj.vf), logStd: Float64Array.from(obj.logStd), actDim: obj.actDim, meta: obj };
}

/** 에이전트 복사 (작업자에게 보낼 가중치) */
export const agentWeights = (agent) => exportPolicy(agent);
