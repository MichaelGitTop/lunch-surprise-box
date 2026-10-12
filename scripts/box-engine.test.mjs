#!/usr/bin/env node
/**
 * 开盒引擎单元测试
 * 运行：node --test scripts/box-engine.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hashSeed,
  mulberry32,
  normalizeMeals,
  buildCombos,
  applyBestCoupon,
  scoreCombo,
  openBox,
  openBoxes,
  openCandidates,
  sealCandidate,
  selectDiversePool,
  renderCard,
  renderCandidates,
  DEMO_MEALS,
  DEMO_COUPONS,
} from './box-engine.mjs';

test('hashSeed 稳定且区分大小写', () => {
  assert.equal(hashSeed('20261026'), hashSeed('20261026'));
  assert.notEqual(hashSeed('abc'), hashSeed('ABC'));
});

test('mulberry32 同种子输出序列完全一致', () => {
  const a = mulberry32(hashSeed('lunch'));
  const b = mulberry32(hashSeed('lunch'));
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('normalizeMeals 兼容分/元两种价格口径', () => {
  const out = normalizeMeals([
    { code: 'X1', name: '测试堡', price: 22.5, category: 'burger' },
    { code: 'X2', name: '测试饮', priceFen: 950, category: 'drink' },
  ]);
  assert.equal(out[0].priceFen, 2250);
  assert.equal(out[1].priceFen, 950);
});

test('normalizeMeals 能从名字兜底分类', () => {
  const out = normalizeMeals([{ code: 'Y1', name: '大杯可口可乐' }]);
  assert.equal(out[0].category, 'drink');
});

/* ---------- 套餐（combo）取法 ---------- */

test('normalizeMeals 识别套餐并推断 includes', () => {
  const out = normalizeMeals([{ code: 'X1', name: '麦辣鸡腿汉堡套餐', price: 40.5 }]);
  assert.equal(out[0].category, 'combo');
  assert.ok(out[0].includes.includes('burger'));
  assert.ok(out[0].includes.includes('drink'));

  const plain = normalizeMeals([{ code: 'X2', name: '巨无霸', price: 29 }]);
  assert.equal(plain[0].category, 'burger');
  assert.deepEqual(plain[0].includes, []);
});

test('buildCombos 两种取法同池：单点 + 含「主食+饮料」的套餐', () => {
  const meals = [
    { code: 'B1', name: '测试堡', priceFen: 2000, kcal: 500, category: 'burger', tags: [] },
    { code: 'S1', name: '薯条', priceFen: 1000, kcal: 300, category: 'side', tags: [] },
    { code: 'D1', name: '可乐', priceFen: 900, kcal: 150, category: 'drink', tags: [] },
    { code: 'C1', name: '测试堡套餐', priceFen: 3500, kcal: 900, category: 'combo', tags: [], includes: ['burger', 'side', 'drink'] },
    { code: 'C2', name: '鸡翅套餐', priceFen: 3000, kcal: 800, category: 'combo', tags: [], includes: ['side', 'drink'] },
    { code: 'C3', name: '只有堡套餐', priceFen: 3000, kcal: 800, category: 'combo', tags: [], includes: ['burger'] },
  ];
  const combos = buildCombos(meals, { budgetFen: 99999, maxKcal: 0, excludeTags: [] });
  assert.equal(combos.filter((c) => c.pattern === 'ala-carte').length, 1);
  const combosOnly = combos.filter((c) => c.pattern === 'combo');
  assert.equal(combosOnly.length, 1, '只有同时含主食+饮料的套餐才能独立成盒');
  assert.equal(combosOnly[0].items[0].code, 'C1');
});

test('openBox 只有套餐时也能成盒（pattern=combo）', () => {
  const meals = [
    { code: 'C1', name: '测试堡套餐', priceFen: 3500, kcal: 700, category: 'combo', tags: [], includes: ['burger', 'side', 'drink'] },
  ];
  const r = openBox({ seed: 'combo-1', profile: 'random', budgetFen: 4000, excludeTags: [], meals, coupons: [] });
  assert.equal(r.ok, true);
  assert.equal(r.pattern, 'combo');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].category, 'combo');
});

test('renderCard 对套餐盒标注「套餐」形式', () => {
  const meals = [
    { code: 'C1', name: '测试堡套餐', priceFen: 3500, kcal: 700, category: 'combo', tags: [], includes: ['burger', 'drink'] },
  ];
  const r = openBox({ seed: 'combo-2', profile: 'random', budgetFen: 4000, excludeTags: [], meals, coupons: [] });
  const md = renderCard(r);
  assert.match(md, /套餐/);
  assert.match(md, /已含主食/);
});

test('renderCard 套餐盒必须写清套餐内容（主食/小食/饮料）', () => {
  const meals = [
    {
      code: 'C1',
      name: '测试堡套餐',
      priceFen: 3500,
      kcal: 700,
      category: 'combo',
      tags: [],
      includes: ['burger', 'side', 'drink'],
      comboItems: [
        { name: '板烧鸡腿堡' },
        { name: '中薯条' },
        { name: '可口可乐(中)' },
      ],
    },
  ];
  const r = openBox({ seed: 'combo-3', profile: 'random', budgetFen: 4000, excludeTags: [], meals, coupons: [] });
  const md = renderCard(r);
  assert.match(md, /套餐内容/);
  assert.match(md, /主食 板烧鸡腿堡/);
  assert.match(md, /小食 中薯条/);
  assert.match(md, /饮料 可口可乐\(中\)/);
  assert.ok(!/已含主食/.test(md), '有子项时不应再退化为通用说明');
});

test('normalizeMeals 解析套餐子项 comboItems 并推断子项品类', () => {
  const out = normalizeMeals([
    {
      code: 'C9',
      name: '吉士汉堡套餐',
      price: 31.5,
      category: 'combo',
      includes: ['burger', 'side', 'drink'],
      comboItems: [
        { name: '吉士汉堡包', quantity: 1 },
        { name: '中薯条', itemQuantity: 1 },
        { name: '可口可乐中杯' },
      ],
    },
  ]);
  const c = out[0];
  assert.equal(c.comboItems.length, 3);
  assert.equal(c.comboItems[0].category, 'burger');
  assert.equal(c.comboItems[1].category, 'side');
  assert.equal(c.comboItems[2].category, 'drink');
});

test('demo 数据里含套餐，候选池同时含两种取法', () => {
  const combos = buildCombos(DEMO_MEALS, { budgetFen: 4000, maxKcal: 0, excludeTags: [] });
  assert.ok(combos.some((c) => c.pattern === 'ala-carte'));
  assert.ok(combos.some((c) => c.pattern === 'combo'));
});

test('buildCombos 遵守预算硬约束', () => {
  const combos = buildCombos(DEMO_MEALS, { budgetFen: 4000, maxKcal: 0, excludeTags: [] });
  assert.ok(combos.length > 0);
  assert.ok(combos.every((c) => c.originalFen <= 4000));
});

test('buildCombos 遵守忌口硬约束', () => {
  const combos = buildCombos(DEMO_MEALS, { budgetFen: 99999, maxKcal: 0, excludeTags: ['beef', 'spicy'] });
  const names = combos.flatMap((c) => c.items.map((i) => i.name));
  assert.ok(!names.some((n) => /巨无霸|麦辣/.test(n)));
});

test('applyBestCoupon 选出省得最多的可用券', () => {
  const combo = { items: [{ code: 'B001', tags: ['beef'] }], originalFen: 3200 };
  const { best, savedFen, finalFen } = applyBestCoupon(combo, DEMO_COUPONS);
  assert.equal(best.code, 'MCP5'); // 满30减5 > 满20减3
  assert.equal(savedFen, 500);
  assert.equal(finalFen, 2700);
});

test('applyBestCoupon 尊重 scopeTags 定向券', () => {
  const combo = { items: [{ code: 'B004', tags: ['seafood'] }], originalFen: 2350 };
  const { best } = applyBestCoupon(combo, DEMO_COUPONS);
  assert.equal(best.code, 'NEWFISH'); // 定向券省 6 元，优于通用满20减3
});

test('openBox 相同种子结果完全可复现', () => {
  const args = { seed: '20261026', profile: 'saver', budgetFen: 4000, excludeTags: ['pickle'], meals: DEMO_MEALS, coupons: DEMO_COUPONS };
  const a = openBox(args);
  const b = openBox(args);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
});

test('openBox 不同种子会开出不同盒子（绝大多数情况）', () => {
  const base = { profile: 'random', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS };
  const names = new Set();
  for (let i = 0; i < 20; i++) names.add(openBox({ ...base, seed: 'seed-' + i }).boxName);
  assert.ok(names.size > 1, '20 个种子应至少开出 2 种不同盒子');
});

test('openBox 在约束下无解时优雅失败', () => {
  const r = openBox({ seed: 'x', profile: 'saver', budgetFen: 100, excludeTags: [], meals: DEMO_MEALS, coupons: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可用组合/);
});

test('openBox 轻盈盒满足热量上限', () => {
  const r = openBox({ seed: 'lean-1', profile: 'lean', budgetFen: 6000, maxKcal: 900, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS });
  assert.equal(r.ok, true);
  assert.ok(r.kcal <= 900);
});

test('renderCard 产出包含价格与券信息的 Markdown', () => {
  const r = openBox({ seed: '20261026', profile: 'saver', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS });
  const md = renderCard(r);
  assert.match(md, /到手价/);
  assert.match(md, /NO\./);
});

test('openBoxes 摇出指定数量的互不相同候选盒', () => {
  const args = { seed: '20261026', profile: 'saver', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS };
  const boxes = openBoxes(args, 6);
  assert.equal(boxes.length, 6, 'demo 数据也应能凑够 6 个候选（不足时自动放宽抽取池）');
  const keys = boxes.map((b) => b.items.map((i) => i.code).sort().join('|'));
  assert.equal(new Set(keys).size, 6, '6 个候选的餐品组合应互不相同');
  assert.ok(boxes.every((b) => b.ok));
});

test('openBoxes 结果确定性可复现', () => {
  const args = { seed: 'repro-1', profile: 'random', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS };
  assert.deepEqual(openBoxes(args, 6), openBoxes(args, 6));
});

test('sealCandidate 只暴露线索、不泄露餐品与券', () => {
  const [box] = openBoxes({ seed: 'seal-1', profile: 'saver', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS }, 1);
  const sealed = sealCandidate(box, 0);
  assert.equal(sealed.no, 1);
  assert.equal(sealed.boxNo, box.boxNo);
  assert.equal(sealed.items, undefined, '封盒不应包含 items');
  assert.equal(sealed.coupon, undefined, '封盒不应包含券明细');
  assert.equal(typeof sealed.finalFen, 'number');
  assert.equal(typeof sealed.kcal, 'number');
});

test('renderCandidates 输出序号与揭晓提示', () => {
  const list = openCandidates({ seed: 'c1', profile: 'saver', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS }, 6);
  assert.equal(list.length, 6);
  const md = renderCandidates(list);
  assert.match(md, /6 个候选盲盒/);
  assert.match(md, /NO\./);
  assert.match(md, /回复序号/);
});

test('openBoxes 在约束下无解时返回空数组（不抛错）', () => {
  const boxes = openBoxes({ seed: 'x', profile: 'saver', budgetFen: 100, excludeTags: [], meals: DEMO_MEALS, coupons: [] }, 6);
  assert.deepEqual(boxes, []);
});

/* ---------- 抽取池多样性约束（防单一商品垄断） ---------- */

test('selectDiversePool 限制同一餐品在池中的占比', () => {
  // 20 个候选全都含同一个饮料 D1
  const ranked = Array.from({ length: 20 }, (_, i) => ({
    combo: { items: [{ code: `B${i}` }, { code: `S${i}` }, { code: 'D1' }] },
    score: 100 - i,
  }));
  const pool = selectDiversePool(ranked, 12, { maxShare: 1 / 3 });
  const cap = Math.ceil(12 / 3);
  const d1 = pool.filter((p) => p.combo.items.some((it) => it.code === 'D1')).length;
  assert.ok(d1 <= cap, `同一 SKU 不应超过 ceil(K/3)=${cap}，实际 ${d1}`);
  assert.ok(pool.length <= 12, '不回落补位，池子不得超过 K');
});

test('selectDiversePool 为每款饮品保底 1 个组合（即便分数很低）', () => {
  const mk = (burger, drink, score) => ({
    combo: {
      items: [
        { code: burger, category: 'burger' },
        { code: `S_${burger}`, category: 'side' },
        { code: drink, category: 'drink' },
      ],
    },
    score,
  });
  const ranked = [];
  for (let i = 0; i < 10; i++) ranked.push(mk(`B${i}`, 'WATER', 1000 - i));
  ranked.push(mk('B10', 'COLA', 100));
  ranked.push(mk('B11', 'TEA', 90));
  const pool = selectDiversePool(ranked, 6, { maxShare: 1 / 3 });
  const drinks = new Set(pool.map((p) => p.combo.items.find((i) => i.category === 'drink').code));
  assert.ok(drinks.has('COLA') && drinks.has('TEA'), '低分饮品也应被保底纳入');
});

test('selectDiversePool 套餐配额：让池子大部分是套餐', () => {
  const mkCombo = (code, score) => ({ combo: { pattern: 'combo', items: [{ code, category: 'combo' }] }, score });
  const mkAla = (code, score) => ({
    combo: {
      pattern: 'ala-carte',
      items: [
        { code: `${code}_b`, category: 'burger' },
        { code: `${code}_s`, category: 'side' },
        { code: `${code}_d`, category: 'drink' },
      ],
    },
    score,
  });
  const ranked = [];
  for (let i = 0; i < 3; i++) ranked.push(mkCombo(`C${i}`, 10 - i)); // 套餐分数更低
  for (let i = 0; i < 20; i++) ranked.push(mkAla(`A${i}`, 100 - i)); // 单点分数更高
  ranked.sort((a, b) => b.score - a.score);

  const withQuota = selectDiversePool(ranked, 10, { comboShare: 0.7 });
  const without = selectDiversePool(ranked, 10, { comboShare: 0 });
  const nWith = withQuota.filter((p) => p.combo.pattern === 'combo').length;
  const nWithout = without.filter((p) => p.combo.pattern === 'combo').length;
  assert.equal(nWith, 3, '配额应把预算内的套餐全部纳入（本例 3 个）');
  assert.ok(nWith > nWithout, '开启套餐配额后池中的套餐应明显更多');
});

test('selectDiversePool 候选数不足 K 时原样返回', () => {
  const ranked = [{ combo: { items: [{ code: 'X' }] }, score: 1 }];
  assert.equal(selectDiversePool(ranked, 6).length, 1);
});

test('抽取池施加多样性约束后，任一餐品占比 ≤ 1/3（demo）', () => {
  const ctx = { profile: 'saver', budgetFen: 4000, maxKcal: 0, excludeTags: [] };
  const ranked = buildCombos(DEMO_MEALS, ctx)
    .map((c) => {
      const priced = applyBestCoupon(c, DEMO_COUPONS);
      return { combo: c, score: scoreCombo(c, ctx, priced).total };
    })
    .sort((a, b) => b.score - a.score);
  const K = Math.min(12, Math.max(3, Math.ceil(ranked.length * 0.3)));
  const pool = selectDiversePool(ranked, K);
  const cap = Math.max(1, Math.ceil(K / 3));
  const counts = new Map();
  for (const p of pool) for (const it of p.combo.items) counts.set(it.code, (counts.get(it.code) ?? 0) + 1);
  for (const [code, n] of counts) {
    assert.ok(n <= cap, `餐品 ${code} 在池中出现 ${n} 次，超过上限 ${cap}`);
  }
});

test('openBox 抽样：单一饮品不再垄断（demo）', () => {
  const tally = new Map();
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const r = openBox({ seed: `div-${i}`, profile: 'saver', budgetFen: 4000, excludeTags: [], meals: DEMO_MEALS, coupons: DEMO_COUPONS });
    if (!r.ok) continue;
    n++;
    const d = r.items.find((x) => x.category === 'drink');
    const key = d ? d.name : '(套餐自带)';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const top = Math.max(...tally.values());
  assert.ok(top / n <= 0.7, `单一饮品占比 ${((top / n) * 100).toFixed(1)}% 仍然偏高`);
});

/* ---------- CLI 集成测试：--stdin 必须尊重输入 JSON 的字段 ---------- */

const ENGINE_PATH = fileURLToPath(new URL('./box-engine.mjs', import.meta.url));

function runCli(args, inputObj) {
  const out = execFileSync(process.execPath, [ENGINE_PATH, ...args], {
    input: JSON.stringify(inputObj),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('CLI --stdin 尊重输入 JSON 的 profile / seed / maxKcal', () => {
  const r = runCli(['--stdin', '--json'], {
    seed: 'cli-seed-1',
    profile: 'lean',
    budgetFen: 6000,
    maxKcal: 900,
    excludeTags: [],
    meals: DEMO_MEALS,
    coupons: DEMO_COUPONS,
  });
  assert.equal(r.profile, 'lean', 'profile 应取自输入 JSON，而非默认 random');
  assert.equal(r.seed, 'cli-seed-1', 'seed 应取自输入 JSON');
  assert.ok(r.kcal <= 900);
});

test('CLI --candidates 尊重输入 JSON 的 profile', () => {
  const list = runCli(['--stdin', '--candidates', '6', '--json'], {
    seed: 'cli-cand-1',
    profile: 'saver',
    budgetFen: 4000,
    excludeTags: [],
    meals: DEMO_MEALS,
    coupons: DEMO_COUPONS,
  });
  assert.equal(list.length, 6);
  assert.ok(list.every((c) => c.profile === 'saver'), '候选盒也应按输入 JSON 的档案生成');
  assert.equal(list[0].items, undefined, '封盒候选不应泄露餐品');
});

test('CLI --stdin 使用输入 JSON 的 budgetFen（而非默认 40 元）', () => {
  const base = { seed: 'cli-budget-1', profile: 'saver', excludeTags: [], meals: DEMO_MEALS, coupons: [] };
  // demo 最低可行组合 = 麦辣鸡腿堡 20.50 + 玉米杯 9.00 + 纯悦 7.00 = 36.50 元
  const tight = runCli(['--stdin', '--json'], { ...base, budgetFen: 3600 });
  assert.equal(tight.ok, false, '36 元低于 demo 最低组合，应开不出（证明 JSON 预算生效）');
  const ok = runCli(['--stdin', '--json'], { ...base, budgetFen: 3800 });
  assert.equal(ok.ok, true);
  assert.ok(ok.originalFen <= 3800);
});
