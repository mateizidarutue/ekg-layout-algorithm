// Real-bundle smoke check. Not part of the test suite; run on demand:
//
//     node bep/tests/smoke_real_bundles.mjs
//
// Asserts that getEkgView() returns within budget on `library` and `bpic19`,
// and that the same invariants from test_ekg_view.mjs still hold on real data.

import { readFile } from "node:fs/promises";
import { buildStore, getEkgView } from "../viewer/src/data/store.js";
import { computeEkgViewLayout, EKG_LEVELS } from "../viewer/src/layout/ekgViewLayout.js";

const PERF_BUDGET_MS = { library: 800, bpic19: 1500 };

async function run(name, file) {
  const bundle = JSON.parse(await readFile(file, "utf8"));
  console.log(`\n${name}: events=${bundle.events.length.toLocaleString()} entities=${bundle.entities.length.toLocaleString()}`);

  const tBuild0 = performance.now();
  buildStore(bundle);
  const tBuild1 = performance.now();
  console.log(`  buildStore        ${(tBuild1 - tBuild0).toFixed(0).padStart(5)} ms`);

  const tView0 = performance.now();
  const view = getEkgView();
  const tView1 = performance.now();
  console.log(`  getEkgView        ${(tView1 - tView0).toFixed(0).padStart(5)} ms — bins=${view.bins.length} types=${view.typeNodes.length} spines=${view.spines.length.toLocaleString()}`);

  for (const lvl of [EKG_LEVELS.L0, EKG_LEVELS.L1, EKG_LEVELS.L2]) {
    const t0 = performance.now();
    const layout = computeEkgViewLayout(view, { width: 1280 }, { level: lvl });
    const t1 = performance.now();
    console.log(`  layout L${lvl}          ${(t1 - t0).toFixed(0).padStart(5)} ms — bands=${layout.bands.length} h=${layout.totalHeight} spines:${layout.sharedSpines.length}→${layout.spineClusters.length} clusters · hidden:${layout.hiddenTypeCount}`);
  }

  // Conservation spot-check
  const sumByType = {};
  view.bins.forEach(bin => {
    Object.entries(bin.byType).forEach(([t, s]) => {
      sumByType[t] = (sumByType[t] ?? 0) + s.total;
    });
  });
  view.typeNodes.forEach(node => {
    const sum = sumByType[node.id] ?? 0;
    if (sum !== node.eventCount) {
      console.error(`    ✗ ${node.id}: bin sum ${sum} != typeNode.eventCount ${node.eventCount}`);
    }
  });

  const budget = PERF_BUDGET_MS[name];
  if (tView1 - tView0 > budget) {
    console.error(`  ✗ over budget (${budget}ms) — saw ${(tView1 - tView0).toFixed(0)}ms`);
  } else {
    console.log(`  ✓ within ${budget}ms budget`);
  }
}

await run("library", "bep/output/library.json");
await run("bpic19",  "bep/output/bpic19.json");
