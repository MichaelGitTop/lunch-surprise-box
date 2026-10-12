#!/usr/bin/env node
/**
 * 午餐惊喜盒 · 开盒引擎 (box-engine)
 * ------------------------------------------------------------
 * 一个零依赖、确定性（可复现）的「午餐盲盒」生成器。
 *
 * 职责边界：
 *   - 本引擎只负责「确定性计算」：候选筛选 → 打分 → 按种子开盒 → 叠加券 → 出结果。
 *   - 所有「不确定性」都收敛到 seed 上：同一个 seed + 同一份输入，永远开出同一个盒子。
 *   - 真实的门店 / 餐品 / 优惠券数据由麦当劳 MCP 提供，本引擎通过 stdin/JSON 接收归一化输入。
 *
 * 设计目标：
 *   1. 可复现：seed 相同 => 结果逐字节相同（便于测试、复盘、分享「我今天开到了什么」）。
 *   2. 可解释：每个盒子都带 scoring 明细，说明「为什么是它」。
 *   3. 可约束：支持预算上限、热量上限、忌口标签排除。
 *   4. 可省钱：自动尝试把可用券套到盒子上，给出省钱前后对比。
 *
 * 用法：
 *   node scripts/box-engine.mjs --demo
 *   node scripts/box-engine.mjs --in input.json --profile saver --seed 20261026
 *   cat input.json | node scripts/box-engine.mjs --stdin --profile lean
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ============================================================
 * 0. 基础工具：确定性伪随机数
 * ============================================================ */

/** 把任意字符串/数字散列为 32 位无符号整数种子 */
export function hashSeed(input) {
  const str = String(input ?? '');
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小巧、无依赖、跨平台一致的 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用给定 rng 从数组里取一项 */
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * 按权重抽取：权重越大越容易被抽中，但低权重项仍有机会 —— 「高分不代表必中，但更容易中」。
 * 用 rng 保证可复现。
 */
function pickWeighted(rng, arr, weightFn) {
  const weights = arr.map((it, i) => Math.max(0, weightFn(it, i)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return pick(rng, arr); // 权重全为 0 时退化为均匀随机
  let r = rng() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

/** 用给定 rng 做 Fisher–Yates 洗牌（不改原数组） */
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================
 * 1. 常量：盒子档案与命名
 * ============================================================ */

export const PROFILES = {
  saver: { key: 'saver', label: '省钱盒', emoji: '💰', desc: '同预算下花得更少、把券用到极致' },
  lean: { key: 'lean', label: '轻盈盒', emoji: '🥗', desc: '控卡优先，热量更低' },
  explorer: { key: 'explorer', label: '尝鲜盒', emoji: '🎲', desc: '优先新品 / 限定，换换口味' },
  random: { key: 'random', label: '随机盒', emoji: '🎁', desc: '完全交给命运，开什么吃什么' },
};

/** 盒子命名词库：主要食 + 形容词 + 名词，用 rng 组合出「今天这盒叫啥」 */
const NAME_NOUNS = ['午餐盒', '食光', '便当', '能量盒', '碳水星', '悦食盒', '一盒', '食验品'];
const NAME_ADJ = ['好运', '元气', '隐藏款', '欧皇', '锦鲤', '限定', '盲选', '今日', '解压', '满分'];
const NAME_EMOJI = ['🍔', '🎁', '✨', '🍟', '🥤', '🔥', '🍀', '🌟'];

/* ============================================================
 * 2. 输入归一化
 * ============================================================ */

/**
 * 把麦当劳 MCP 的原始餐品数据归一化为引擎内部模型。
 * 真实调用中，query-meals / query-meal-detail / list-nutrition-foods 的字段名各异，
 * 这里做一层「宽容解析」，缺失字段给安全默认值。
 */
export function normalizeMeals(raw = []) {
  return raw
    .map((m) => {
      const code = String(m.code ?? m.productCode ?? m.itemCode ?? '').trim();
      const name = String(m.name ?? m.productName ?? m.itemName ?? '').trim();
      if (!code || !name) return null;
      // 价格字段可能是分或元，统一折算为「分」：
      //   - 显式 priceFen 字段：按分直接采用（调用方已声明口径，无需猜测）
      //   - 模糊字段（price/originalPrice）：>1000 视为已是分，否则视为元
      let priceFen;
      if (m.priceFen != null) {
        priceFen = Math.round(Number(m.priceFen));
      } else {
        const rawPrice = Number(m.price ?? m.originalPrice ?? 0);
        priceFen = rawPrice > 1000 ? Math.round(rawPrice) : Math.round(rawPrice * 100);
      }
      const kcal = Number(m.kcal ?? m.calorie ?? m.energy ?? 0) || 0;
      const category = String(m.category ?? guessCategory(name)).trim();
      const tags = Array.isArray(m.tags) ? m.tags.map(String) : guessTags(name);
      const isNew = Boolean(m.isNew ?? m.new ?? /新品|限定|回归/.test(name + tags.join(',')));
      // 套餐（combo）需要知道它内含哪些品类；优先用输入里显式声明的 includes，否则按名称兜底推断
      const includes =
        Array.isArray(m.includes) && m.includes.length
          ? m.includes.map(String)
          : category === 'combo'
            ? inferComboIncludes(name)
            : [];
      // 套餐子项（对应 query-meal-detail 的 rounds[].choices），用于在卡片里写清「套餐里到底有什么」：
      //   什么主食 + 什么小食 + 什么饮料。缺失时退化为通用的「已含主食 + 饮料」说明。
      const comboItems = Array.isArray(m.comboItems)
        ? m.comboItems
            .map((it) => {
              const subName = String(it?.name ?? it?.productName ?? '').trim();
              if (!subName) return null;
              return {
                name: subName,
                category: it?.category ? String(it.category) : guessCategory(subName),
                quantity: Number(it?.quantity ?? it?.itemQuantity ?? 1) || 1,
              };
            })
            .filter(Boolean)
        : [];
      return { code, name, priceFen, kcal, category, tags, isNew, includes, comboItems };
    })
    .filter(Boolean);
}

/** 名称特征：套餐 / 含主食 / 含饮料 / 含小食 */
const RE_COMBO = /套餐|三件套|四件套|单人餐|双人餐|分享餐/;
const RE_BURGER = /堡|巨无霸|麦香鱼|主食/;
const RE_DRINK = /可乐|雪碧|芬达|咖啡|茶|橙|苹果汁|纯悦|牛奶|豆浆|饮|奶茶/;
const RE_SIDE = /薯条|鸡块|鸡翅|V翅|鸡排|派|玉米|薯饼|苹果片|麦乐鸡|沙拉/;

/**
 * 推断「套餐」里包含哪些品类。
 * MCP 的 `query-meals` 只给套餐的名称与价格、不返回内部组成，所以这里做「名称兜底」：
 *   - 名称含「堡 / 巨无霸 / 麦香鱼 / 主食」→ 含主食
 *   - 名称含饮料词，或属于标准套餐（套餐 / 三件套 / 四件套 / 单人餐…）→ 含饮料
 *   - 名称含小食词，或属于标准套餐 → 含小食
 * 需要更准时，可在归一化输入里显式写 `includes: ["burger","drink", ...]` 覆盖本推断。
 */
function inferComboIncludes(name) {
  const inc = [];
  const isSet = RE_COMBO.test(name);
  if (RE_BURGER.test(name)) inc.push('burger');
  if (RE_DRINK.test(name) || isSet) inc.push('drink');
  if (RE_SIDE.test(name) || isSet) inc.push('side');
  return inc;
}

/** 从名字兜底猜分类 */
function guessCategory(name) {
  if (RE_COMBO.test(name)) return 'combo'; // 套餐优先识别
  if (/可乐|雪碧|芬达|咖啡|茶|橙汁|牛奶|豆浆|水|饮/.test(name)) return 'drink';
  if (RE_SIDE.test(name)) return 'side';
  if (/冰淇淋|圣代|新地|麦旋风|甜品|蛋糕|甜筒/.test(name)) return 'dessert';
  return 'burger'; // 主食兜底
}

/** 从名字兜底猜忌口标签 */
function guessTags(name) {
  const tags = [];
  if (/腌黄瓜|酸黄瓜|pickle/i.test(name)) tags.push('pickle');
  if (/辣|川|劲辣|麻辣/.test(name)) tags.push('spicy');
  if (/牛肉|牛|巨无霸|安格斯/.test(name)) tags.push('beef');
  if (/鸡|鸡腿|鸡排/.test(name)) tags.push('chicken');
  if (/[鱼虾蟹]|鳕/.test(name)) tags.push('seafood');
  if (/奶|芝士|黄油/.test(name)) tags.push('dairy');
  return tags;
}

/* ============================================================
 * 3. 候选组合生成
 * ============================================================ */

/**
 * 生成所有合法的盒子组合，并做硬约束过滤。
 *
 * 盒的合法构成（两种取法，同池竞争）：
 *   A · 单点：主食 + 小食 + 饮料   （pattern = 'ala-carte'）
 *   B · 套餐：一个「含主食 + 饮料」的套餐即可独立成盒（pattern = 'combo'）
 *
 * 任何一个取法都必须覆盖到「主食 + 饮料」；纯小食/无饮料的套餐不入池。
 * 若某分类为空，单点取法会跳过该分类。
 */
export function buildCombos(meals, ctx) {
  const exclude = new Set(ctx.excludeTags || []);
  const ok = (m) => !m.tags.some((t) => exclude.has(t));

  const pool = {
    burger: meals.filter((m) => m.category === 'burger' && ok(m)),
    side: meals.filter((m) => m.category === 'side' && ok(m)),
    drink: meals.filter((m) => m.category === 'drink' && ok(m)),
    combo: meals.filter((m) => m.category === 'combo' && ok(m)),
  };

  const combos = [];
  const push = (items, pattern) => {
    const originalFen = items.reduce((s, i) => s + i.priceFen, 0);
    const kcal = items.reduce((s, i) => s + i.kcal, 0);
    // 硬约束：预算上限
    if (ctx.budgetFen && originalFen > ctx.budgetFen) return;
    // 硬约束：热量上限
    if (ctx.maxKcal && kcal > ctx.maxKcal) return;
    combos.push({ items, originalFen, kcal, pattern });
  };

  // 取法 A · 单点：主食 + 小食 + 饮料
  const sides = pool.side.length ? pool.side : [null];
  const drinks = pool.drink.length ? pool.drink : [null];
  for (const main of pool.burger) {
    for (const side of sides) {
      for (const drink of drinks) {
        push([main, side, drink].filter(Boolean), 'ala-carte');
      }
    }
  }

  // 取法 B · 套餐：一个自带「主食 + 饮料」的套餐即可独立成盒
  for (const set of pool.combo) {
    const inc = Array.isArray(set.includes) ? set.includes : [];
    if (inc.includes('burger') && inc.includes('drink')) push([set], 'combo');
  }

  return combos;
}

/* ============================================================
 * 4. 优惠券叠加
 * ============================================================ */

/**
 * 在给定券列表中，为组合挑一张「最省」的可用券。
 * 支持两类：满减（thresholdFen + discountFen）；无门槛（thresholdFen 缺省视为 0）。
 * scopeCodes / scopeTags 可选，为空表示全场通用。
 */
export function applyBestCoupon(combo, coupons = []) {
  const codes = new Set(combo.items.map((i) => i.code));
  const tags = new Set(combo.items.flatMap((i) => i.tags));

  const applicable = coupons
    .filter((c) => (combo.originalFen >= (c.thresholdFen ?? 0)))
    .filter((c) => {
      if (Array.isArray(c.scopeCodes) && c.scopeCodes.length) {
        return c.scopeCodes.some((code) => codes.has(code));
      }
      if (Array.isArray(c.scopeTags) && c.scopeTags.length) {
        return c.scopeTags.some((t) => tags.has(t));
      }
      return true; // 通用券
    })
    .map((c) => ({ coupon: c, save: Math.min(c.discountFen ?? 0, combo.originalFen) }))
    .sort((a, b) => b.save - a.save);

  const best = applicable[0];
  const finalFen = combo.originalFen - (best ? best.save : 0);
  return { best: best?.coupon ?? null, savedFen: best?.save ?? 0, finalFen };
}

/* ============================================================
 * 5. 打分
 * ============================================================ */

/**
 * 按档案给组合打分。分数越高越「该被开到」。
 * 返回 { total, reasons[] }，reasons 用于向用户解释。
 */
export function scoreCombo(combo, ctx, priced) {
  const reasons = [];
  const profile = ctx.profile || 'random';
  let score = 0;

  if (profile === 'saver') {
    score += 1000 - priced.finalFen / 10; // 越便宜越高
    if (priced.savedFen > 0) {
      score += 300;
      reasons.push(`用券立省 ¥${(priced.savedFen / 100).toFixed(2)}`);
    }
  } else if (profile === 'lean') {
    score += 1000 - combo.kcal / 5; // 热量越低越高
    reasons.push(`热量 ${combo.kcal} kcal`);
  } else if (profile === 'explorer') {
    const news = combo.items.filter((i) => i.isNew).length;
    score += news * 400 + (1000 - priced.finalFen / 20);
    if (news > 0) reasons.push(`含 ${news} 款新品/限定`);
  } else {
    // random：不偏心，仅轻度惩罚超贵
    score += 500 - priced.finalFen / 50;
  }

  // 通用加分：券利用率（省得越多越"赚到"）
  if (priced.savedFen > 0) score += priced.savedFen / 5;

  return { total: Math.round(score * 100) / 100, reasons };
}

/* ============================================================
 * 6. 惊喜度（一个"好玩"的指标，用于展示而非决策）
 * ============================================================ */

/** 0-100 的惊喜度：券利用率高 + 含新品 + 价格踩在预算甜点区间 => 更"惊喜" */
export function surpriseScore(combo, ctx, priced) {
  let s = 30;
  const ratio = priced.savedFen / Math.max(combo.originalFen, 1);
  s += Math.min(ratio * 120, 35); // 最多 +35
  s += combo.items.filter((i) => i.isNew).length * 12; // 新品加分
  if (ctx.budgetFen) {
    const fill = priced.finalFen / ctx.budgetFen;
    // 落在预算 60%~95% 的"甜蜜区"最惊喜
    if (fill >= 0.6 && fill <= 0.95) s += 12;
    else if (fill < 0.4) s -= 8;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

/* ============================================================
 * 7. 主流程：开盒
 * ============================================================ */

/**
 * 从「按分数降序排好」的候选里选出 Top-K 抽取池，并施加多样性约束。
 *
 * 背景：若只按分数取 Top-K，单一商品会垄断整池 —— 典型如「最便宜的饮料」
 * （纯悦 ¥8，第二便宜 ¥11）。实测该场景下 98% 的盒子都是同一瓶饮料。
 *
 * 三轮选池：
 *   第 0 轮 · 套餐配额：`comboShare > 0` 时先把「套餐」按分数填进池子，让池子大部分是套餐
 *                      （套餐自带主食+饮料，天然避开单点饮料垄断）；
 *   第 1 轮 · 饮品保底：为**每一个饮品**保留 1 个「分数最高且不与已选项冲突」的组合，
 *                      保证每款饮料都有出镜机会（套餐自带饮料的记作一个独立分组）；
 *   第 2 轮 · 补充：按分数降序填满剩余名额。
 * 三轮都受「同一餐品出现次数 < cap」约束，cap = max(1, ceil(K × maxShare))，默认 maxShare = 1/3。
 * 被约束挡掉的高分候选**不回落补位**，因此池子可能小于 K —— 这是有意的取舍（多样性优先）。
 */
export function selectDiversePool(ranked, K, { maxShare = 1 / 3, comboShare = 0 } = {}) {
  if (K >= ranked.length) return ranked.slice();
  const cap = Math.max(1, Math.ceil(K * maxShare));
  const picked = [];
  const counts = new Map();
  const taken = new Set();

  const keyOf = (item) => item.combo.items.map((i) => i.code).sort().join('|');
  // 套餐配额同时限制「单点」在池中的上限：否则池子会被单点填满，套餐被稀释
  // （例如 4 个套餐 + 8 个单点，套餐只占池子 1/3）。
  const useComboQuota = comboShare > 0;
  const alaCarteCap = useComboQuota ? Math.max(2, K - Math.ceil(K * comboShare)) : Infinity;
  let alaCartePlaced = 0;
  const place = (item) => {
    const k = keyOf(item);
    if (taken.has(k)) return false;
    const isCombo = item.combo.pattern === 'combo';
    if (!isCombo && alaCartePlaced >= alaCarteCap) return false;
    const codes = item.combo.items.map((i) => i.code);
    if (!codes.every((c) => (counts.get(c) ?? 0) < cap)) return false;
    for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
    taken.add(k);
    picked.push(item);
    if (!isCombo) alaCartePlaced++;
    return true;
  };

  // 第 0 轮 · 套餐配额：让池子大部分是套餐
  if (useComboQuota) {
    const quota = Math.ceil(K * comboShare);
    for (const item of ranked) {
      if (picked.length >= quota) break;
      if (item.combo.pattern !== 'combo') continue;
      place(item);
    }
  }

  // 分组：按「饮品」聚合（套餐自带饮料的记作一个独立分组）
  const groups = new Map();
  for (const item of ranked) {
    const d = item.combo.items.find((i) => i.category === 'drink');
    const key = d ? d.code : '\u0000combo-drink';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  // 第 1 轮 · 饮品保底：给部分饮品（最多占剩余名额一半）各留 1 个最高分组合。
  // 留一半名额给第 2 轮，是为了不让「保底」把整池吃满 —— 否则档案区分的省钱效果会被抹平。
  const reserveLimit = Math.max(1, Math.ceil((K - picked.length) / 2));
  let reserved = 0;
  for (const [key, members] of groups) {
    if (picked.length >= K || reserved >= reserveLimit) break;
    if (useComboQuota && key === '\u0000combo-drink') continue; // 套餐已由第 0 轮处理
    for (const item of members) {
      if (place(item)) {
        reserved++;
        break; // 取该饮品下第一个不冲突的组合
      }
    }
  }

  // 第 2 轮 · 补充：按分数降序填满剩余名额
  for (const item of ranked) {
    if (picked.length >= K) break;
    place(item);
  }

  return picked;
}

/**
 * 开一个午餐惊喜盒。
 * @param {object} input 归一化输入
 * @returns {object} 开盒结果
 */
export function openBox(input) {
  const {
    seed = 'lunch',
    profile = 'random',
    budgetFen = 4000,
    maxKcal = 0,
    excludeTags = [],
    meals = [],
    coupons = [],
    poolSize = 12,
    exhaustivePool = false,
    preferCombo = true,
    comboShare = 0.7,
  } = input || {};

  const ctx = { profile, budgetFen, maxKcal, excludeTags };
  const rng = mulberry32(hashSeed(seed));

  const combos = buildCombos(meals, ctx);
  if (combos.length === 0) {
    return {
      ok: false,
      seed: String(seed),
      profile,
      profileLabel: PROFILES[profile]?.label ?? profile,
      error: '在给定预算/热量/忌口约束下没有可用组合，请放宽条件。',
    };
  }

  // 逐个定价 + 打分
  const scored = combos.map((combo) => {
    const priced = applyBestCoupon(combo, coupons);
    const { total, reasons } = scoreCombo(combo, ctx, priced);
    return { combo, priced, score: total, reasons };
  });

  // 取 Top K 池子，再按分数加权抽取 —— 「最优里带点运气，分数越高越容易开出」。
  // K 自适应：候选少时收紧（否则档案打分会被稀释），候选多时用 poolSize 上限。
  const ranked = scored.sort((a, b) => b.score - a.score);
  // exhaustivePool=true 时放开抽取池到全部候选（供「摇 N 个候选」时保证数量足够，不做多样性裁剪）
  const adaptiveK = exhaustivePool
    ? ranked.length
    : Math.max(1, Math.min(poolSize, Math.max(3, Math.ceil(ranked.length * 0.3))));
  const top = exhaustivePool
    ? ranked.slice(0, adaptiveK)
    : selectDiversePool(ranked, adaptiveK, { comboShare: preferCombo ? comboShare : 0 });
  // 池内按「名次」线性加权（第 1 名权重 = 池大小，末位权重 = 1）：
  // 不用原始分数做权重 —— 档案评分是单目标线性的，池内分数差可达数百点，
  // 直接按分数加权会被「最省 / 最低卡」的那一项几乎全部吃掉（实测单一饮品占比 98%）。
  const chosen = pickWeighted(rng, top, (_t, i) => top.length - i);

  // 盒名用「种子 + 档案」单独派生一个 rng，保证同一天换档案能开出不同名字
  const nameRng = mulberry32(hashSeed(`${seed}:${profile}`));
  const boxName = `${pick(nameRng, NAME_ADJ)}${pick(nameRng, NAME_NOUNS)}${pick(nameRng, NAME_EMOJI)}`;
  const boxNo = (hashSeed(seed) % 9000) + 1000;

  const items = chosen.combo.items.map((i) => ({
    code: i.code,
    name: i.name,
    priceFen: i.priceFen,
    kcal: i.kcal,
    category: i.category,
    isNew: i.isNew,
    comboItems: i.comboItems ?? [],
  }));

  return {
    ok: true,
    seed: String(seed),
    boxNo,
    boxName,
    profile,
    profileLabel: PROFILES[profile]?.label ?? profile,
    profileDesc: PROFILES[profile]?.desc ?? '',
    items,
    pattern: chosen.combo.pattern,
    originalFen: chosen.combo.originalFen,
    finalFen: chosen.priced.finalFen,
    savedFen: chosen.priced.savedFen,
    kcal: chosen.combo.kcal,
    coupon: chosen.priced.best
      ? { id: chosen.priced.best.id, code: chosen.priced.best.code, name: chosen.priced.best.name }
      : null,
    surprise: surpriseScore(chosen.combo, ctx, chosen.priced),
    reasons: chosen.reasons,
    candidateCount: combos.length,
    poolSize: top.length,
  };
}

/* ============================================================
 * 8. 候选盲盒：一次摇 N 个，供用户挑选
 * ============================================================ */

/**
 * 一次摇出 n 个「互不相同」的候选盲盒。
 * 用于「摇 6 个 → 用户挑 1 个揭晓」的交互。
 * 做法：以 seed 为基准派生 n 个子种子分别开盒，并按「餐品集合」去重。
 * 确定性：相同 seed + 相同 input ⇒ 永远同一批候选、同一顺序。
 */
export function openBoxes(input = {}, n = 6) {
  const baseSeed = String(input.seed ?? 'lunch');
  const results = [];
  const seen = new Set();
  const keyOf = (r) => r.items.map((i) => i.code).sort().join('|');

  // 分两阶段：先用默认抽取池（保留档案区分度）；数量不够时再放开池子补足。
  const collect = (exhaustive) => {
    let attempt = 0;
    const maxAttempts = Math.max(n * 30, 60);
    while (results.length < n && attempt < maxAttempts) {
      const seed = `${baseSeed}#${exhaustive ? 'x' : 'p'}${attempt}`;
      const r = openBox({ ...input, seed, exhaustivePool: exhaustive });
      attempt += 1;
      if (!r.ok) return false; // 约束下压根开不出盒，直接停
      const key = keyOf(r);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
    }
    return results.length >= n;
  };

  if (!collect(false)) collect(true);
  return results;
}

/**
 * 「封盒」：把候选盒压缩成只含线索的视图。
 * 只暴露 盒名 / 编号 / 整盒到手价 / 热量 / 是否含新品 —— 不暴露具体餐品，
 * 用户选定序号后才揭晓完整内容。
 */
export function sealCandidate(r, index) {
  return {
    no: index + 1,
    boxNo: r.boxNo,
    boxName: r.boxName,
    profile: r.profile,
    profileLabel: r.profileLabel,
    originalFen: r.originalFen,
    finalFen: r.finalFen,
    savedFen: r.savedFen,
    kcal: r.kcal,
    hasNew: r.items.some((i) => i.isNew),
    itemCount: r.items.length,
    surprise: r.surprise,
  };
}

/** 摇出 n 个「封盒」后的候选（给用户挑选用） */
export function openCandidates(input = {}, n = 6) {
  return openBoxes(input, n).map((r, i) => sealCandidate(r, i));
}

/** 把候选列表渲染成 Markdown 表格（内容封住，只给线索） */
export function renderCandidates(list) {
  if (!list.length) return '> ⚠️ 在给定约束下摇不出候选盒，请放宽预算 / 热量 / 忌口。';
  const yuan = (fen) => `¥${(fen / 100).toFixed(2)}`;
  const lines = [];
  lines.push(`## 摇到 ${list.length} 个候选盲盒 —— 挑一个打开吧`);
  lines.push('');
  lines.push('| # | 盒名 | 编号 | 到手价 | 热量 | 线索 |');
  lines.push('|:--:|---|:--:|---:|---:|---|');
  for (const c of list) {
    const clues = [];
    if (c.hasNew) clues.push('含新品');
    if (c.savedFen > 0) clues.push(`用券省 ${yuan(c.savedFen)}`);
    lines.push(
      `| **${c.no}** | ${c.boxName} | NO.${c.boxNo} | ${yuan(c.finalFen)} | ${c.kcal} kcal | ${clues.join(' · ') || '—'} |`
    );
  }
  lines.push('');
  lines.push(`> 内容已封住。回复序号（1-${list.length}）即可揭晓。`);
  return lines.join('\n');
}

/* ============================================================
 * 9. 渲染：把结果渲染成人类可读的 Markdown 卡片
 * ============================================================ */

export function renderCard(r) {
  if (!r.ok) return `> ⚠️ 开盒失败：${r.error}`;
  const yuan = (fen) => `¥${(fen / 100).toFixed(2)}`;
  const lines = [];
  lines.push(`## ${r.boxName}　\`NO.${r.boxNo}\``);
  lines.push('');
  lines.push(`> 档案：**${r.profileLabel}** ${PROFILES[r.profile]?.emoji ?? ''} — ${r.profileDesc}`);
  lines.push(`> 惊喜度：**${r.surprise}/100**　·　种子 \`${r.seed}\``);
  lines.push('');
  lines.push('| 组成 | 餐品 | 单价 | 热量 |');
  lines.push('|:--:|---|---:|---:|');
  const label = { burger: '主食', side: '小食', drink: '饮料', dessert: '甜品', combo: '套餐' };
  for (const i of r.items) {
    lines.push(`| ${label[i.category] ?? i.category} | ${i.name}${i.isNew ? ' 🆕' : ''} | ${yuan(i.priceFen)} | ${i.kcal} kcal |`);
  }
  lines.push('');
  for (const i of r.items) {
    if (i.category !== 'combo') continue;
    if (Array.isArray(i.comboItems) && i.comboItems.length) {
      // 套餐盒必须写清「里面到底有什么」：主食 / 小食 / 饮料 逐项列出
      // （子项品类优先用归一化时标好的 category，缺失则按名称兜底）
      const detail = i.comboItems
        .map((c) => {
          const cat = label[c.category] ?? label[guessCategory(c.name)] ?? '';
          return `${cat ? `${cat} ` : ''}${c.name}${c.quantity > 1 ? ` ×${c.quantity}` : ''}`;
        })
        .join(' · ');
      lines.push(`- 套餐内容：${detail}`);
    } else {
      lines.push('- 形式：以**套餐**提供（已含主食 + 饮料，具体内容以门店为准）');
    }
  }
  lines.push(`- 原价合计：${yuan(r.originalFen)}`);
  if (r.coupon) lines.push(`- 已叠加券：**${r.coupon.name}**，立省 ${yuan(r.savedFen)}`);
  else lines.push('- 未找到可用券，建议先「一键领券」再开盒');
  lines.push(`- **到手价：${yuan(r.finalFen)}**　·　合计热量 ${r.kcal} kcal`);
  if (r.reasons.length) lines.push(`- 入选理由：${r.reasons.join('；')}`);
  lines.push('');
  lines.push(`> 本盒从 ${r.candidateCount} 个可行组合中开出（打分前 ${r.poolSize} 名内抽取）。`);
  return lines.join('\n');
}

/* ============================================================
 * 10. Demo 数据 + CLI
 * ============================================================ */

export const DEMO_MEALS = [
  { code: 'B001', name: '巨无霸', priceFen: 2250, kcal: 550, category: 'burger', tags: ['beef'] },
  { code: 'B002', name: '麦辣鸡腿堡', priceFen: 2050, kcal: 570, category: 'burger', tags: ['chicken', 'spicy'] },
  { code: 'B003', name: '板烧鸡腿堡', priceFen: 2100, kcal: 430, category: 'burger', tags: ['chicken'] },
  { code: 'B004', name: '双层深海鳕鱼堡', priceFen: 2350, kcal: 460, category: 'burger', tags: ['seafood'], isNew: true },
  { code: 'S001', name: '中薯条', priceFen: 1150, kcal: 340, category: 'side', tags: [] },
  { code: 'S002', name: '麦乐鸡(5块)', priceFen: 1250, kcal: 230, category: 'side', tags: ['chicken'] },
  { code: 'S003', name: '玉米杯', priceFen: 900, kcal: 90, category: 'side', tags: [] },
  { code: 'D001', name: '可口可乐(中)', priceFen: 950, kcal: 180, category: 'drink', tags: [] },
  { code: 'D002', name: '零度可乐(中)', priceFen: 950, kcal: 1, category: 'drink', tags: [] },
  { code: 'D003', name: '纯悦矿泉水', priceFen: 700, kcal: 0, category: 'drink', tags: [] },
  { code: 'D004', name: '麦咖啡拿铁(中)', priceFen: 1650, kcal: 130, category: 'drink', tags: ['dairy'], isNew: true },
  { code: 'C001', name: '板烧鸡腿堡套餐', priceFen: 3950, kcal: 650, category: 'combo', tags: ['chicken'], includes: ['burger', 'side', 'drink'], comboItems: [{ name: '板烧鸡腿堡' }, { name: '中薯条' }, { name: '可口可乐(中)' }] },
];

export const DEMO_COUPONS = [
  { id: 'C001', code: 'MCP5', name: '满 30 减 5', thresholdFen: 3000, discountFen: 500 },
  { id: 'C002', code: 'MCP3', name: '满 20 减 3', thresholdFen: 2000, discountFen: 300 },
  { id: 'C003', code: 'NEWFISH', name: '鳕鱼堡立减 6 元', thresholdFen: 0, discountFen: 600, scopeTags: ['seafood'] },
];

/** 解析 CLI 参数（极简实现，够用即可） */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const input = args.in
    ? JSON.parse(readFileSync(args.in, 'utf8'))
    : args.stdin
      ? JSON.parse(readFileSync(0, 'utf8'))
      : null;

  if (!input && !args.demo && !args.in && !args.stdin) {
    // 没给任何来源时，默认跑 demo，保证「开箱即用」
    console.error('[box-engine] 未指定输入，使用内置 Demo 数据（--demo）。');
  }

  // 优先级：CLI 显式参数 > 输入 JSON > 内置默认
  // （早期版本漏读 input.profile / input.seed，导致 --stdin 时档案与种子被静默忽略）
  const meals = input ? normalizeMeals(input.meals ?? input.products ?? DEMO_MEALS) : DEMO_MEALS;
  const coupons = input?.coupons ?? DEMO_COUPONS;
  const profile = args.profile ?? input?.profile ?? 'random';
  const seed = args.seed ?? input?.seed ?? new Date().toISOString().slice(0, 10);
  const budgetFen =
    (args.budget ? Math.round(Number(args.budget) * 100) : null) ??
    input?.budgetFen ??
    (input?.budget ? Math.round(input.budget * 100) : null) ??
    4000;
  const excludeTags = input?.excludeTags ?? ['pickle'];
  const maxKcal = input?.maxKcal ?? (profile === 'lean' ? 900 : 0);

  const engineInput = { seed, profile, budgetFen, maxKcal, excludeTags, meals, coupons };

  // 候选模式：摇 N 个盲盒 → 封盒展示（默认）/ 揭晓指定的那个（--pick）/ 全部揭晓（--reveal）
  if (args.candidates) {
    const n = Math.max(1, Number(args.candidates) || 6);
    const boxes = openBoxes(engineInput, n);

    if (args.pick != null && args.pick !== true) {
      const idx = Number(args.pick);
      const picked = boxes[idx - 1];
      if (!picked) {
        console.error(`[box-engine] --pick ${idx} 超出范围（本次共 ${boxes.length} 个候选）。`);
        process.exit(1);
      }
      process.stdout.write((args.json ? JSON.stringify(picked, null, 2) : renderCard(picked)) + '\n');
      return;
    }

    if (args.reveal) {
      const out = args.json
        ? JSON.stringify(boxes, null, 2)
        : boxes.map((r) => renderCard(r)).join('\n\n---\n\n');
      process.stdout.write(out + '\n');
      return;
    }

    const sealed = boxes.map((r, i) => sealCandidate(r, i));
    process.stdout.write((args.json ? JSON.stringify(sealed, null, 2) : renderCandidates(sealed)) + '\n');
    return;
  }

  const result = openBox(engineInput);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderCard(result) + '\n');
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
