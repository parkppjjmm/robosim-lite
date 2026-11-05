// PPO 롤아웃 작업자 — Node worker_threads (tools/ppo-train.mjs가 띄움). 에피소드 1개를 돌려 전이(관측·행동·log π·보상)를 돌려준다.
// 메시지: { type: 'init', robots, cfg } → { type: 'ready' }
//        { id, mode: 'policy' | 'eval' | 'teacher', policy(정책 JSON), seed, randSeed } → { id, transitions, stats }
import { parentPort } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { loadRapier } = await import(pathToFileURL(`${root}/tests/lib/rapier.mjs`));
const LAB = await import(pathToFileURL(`${root}/js/stroke-lab.js`));
const PPO = await import(pathToFileURL(`${root}/js/ppo.js`));
const { rng } = await import(pathToFileURL(`${root}/js/dross.js`));
const RAPIER = await loadRapier();
let env = null, cfg = null;

parentPort.on('message', async (m) => {
  if (m.type === 'init') {
    cfg = m.cfg;
    const robot = m.robots.find((r) => r.id === cfg.robotId);
    env = new LAB.StrokeEnv(RAPIER, robot, { count: cfg.count, reward: cfg.lab.reward, thresholds: cfg.thresholds, timeLimitS: cfg.timeLimitS, maxSteps: cfg.maxSteps });
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  try {
    const agent = PPO.importPolicy(m.policy);
    const rand = rng(m.randSeed);
    let ps = env.reset(m.seed);
    const tr = [];
    let ret = 0, empties = 0, infeasible = 0, repaired = 0, done = false;
    while (!done) {
      const obs = PPO.observe(ps, { initialCount: env.initialWork, tFrac: env.tFrac });
      let u, logp, target = null;
      if (m.mode === 'teacher') {
        const tv = env.teacher(cfg.task);
        if (tv) target = LAB.encodeValues(tv, cfg.lab);
        const a = PPO.act(agent, obs, rand, false);
        u = target ?? a.u;
        logp = PPO.logProb(u, a.mean, agent.logStd);
      } else {
        const a = PPO.act(agent, obs, rand, m.mode === 'eval');
        u = a.u;
        logp = a.logp;
      }
      const uc = u.map((x) => Math.min(1, Math.max(0, x)));
      const r = await env.step(LAB.decodeStroke(uc, cfg.lab).values);
      ret += r.reward;
      if (!r.info.feasible) infeasible++;
      else if (r.info.collected === 0) empties++;
      if (r.info.repaired > 0) repaired++;
      tr.push({ obs: Array.from(obs), u, logp, reward: r.reward, target, collected: r.info.collected, feasible: r.info.feasible });
      done = r.done;
      ps = env.particles();
    }
    parentPort.postMessage({ id: m.id, transitions: tr, stats: { ret, rate: (100 * env.collected) / Math.max(1, env.initialWork), collected: env.collected, steps: tr.length, empties, infeasible, repaired, t: env.t } });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err?.stack ?? err) });
  }
});
