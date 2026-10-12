# 开盒规则与字段说明

本文件定义「午餐惊喜盒」引擎（`scripts/box-engine.mjs`）的输入输出契约。

---

## 1. 输入字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|:--:|---|
| `seed` | string \| number | 否 | 随机种子。默认 `lunch`。生产环境建议传当天日期 `2026-10-26`，保证「同一天开的盒一致，换天自然变化」。 |
| `profile` | enum | 否 | `saver` / `lean` / `explorer` / `random`，默认 `random`。 |
| `budgetFen` | number | 否 | 预算上限（**分**）。默认 `4000`（40 元）。 |
| `maxKcal` | number | 否 | 热量上限。默认 `0` 表示不限。`lean` 档案建议给 700~900。 |
| `excludeTags` | string[] | 否 | 忌口标签，命中即排除。常见：`pickle` 腌黄瓜、`spicy` 辣、`beef` 牛肉、`seafood` 海鲜、`dairy` 乳制品、`chicken` 鸡肉。 |
| `meals` | Meal[] | 是 | 归一化后的餐品列表。 |
| `coupons` | Coupon[] | 否 | 归一化后的可用券列表。 |
| `poolSize` | number | 否 | 候选池上限，默认 `12`。引擎会自适应收缩。 |
| `preferCombo` | boolean | 否 | **默认 `true`**。用户没点名想吃什么时，摇池优先让盒子「大部分是套餐」。 |
| `comboShare` | number | 否 | 套餐在抽取池里的目标占比，默认 `0.7`。仅 `preferCombo: true` 时生效。 |

### Meal

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 餐品编码（来自 `query-meals`）。 |
| `name` | string | 餐品名称。 |
| `priceFen` | number | 现价（分）。 |
| `kcal` | number | 热量。 |
| `category` | enum | `burger` 主食 / `side` 小食 / `drink` 饮料 / `dessert` 甜品 / **`combo` 套餐**。缺省时引擎按名称兜底猜测。 |
| `includes` | string[] | **仅套餐（`combo`）需要**：声明套餐内含哪些品类，如 `["burger","drink","side"]`。缺省时引擎按名称兜底推断。 |
| `comboItems` | object[] | **仅套餐（`combo`）需要**：套餐子项明细 `[{ name, category?, quantity? }]`（来自 `query-meal-detail` 的 `rounds[].choices`）。用于在卡片里写清「套餐里到底有什么」。`category` 缺省时引擎按子项名称兜底推断。 |
| `tags` | string[] | 忌口 / 特征标签。缺省时引擎按名称兜底猜测。 |
| `isNew` | boolean | 是否新品 / 限定。 |

### Coupon

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 券 ID。 |
| `code` | string | 券码。 |
| `name` | string | 券名称。 |
| `thresholdFen` | number | 使用门槛（分）。`0` 表示无门槛。 |
| `discountFen` | number | 减免金额（分）。 |
| `scopeTags` | string[] | 选填。仅对含这些标签的餐品生效。为空表示通用券。 |
| `scopeCodes` | string[] | 选填。仅对指定餐品生效。 |

---

## 2. 输出字段

```jsonc
{
  "ok": true,
  "seed": "2026-10-26",
  "boxNo": 2634,                 // 盒子编号（由种子派生，可复现）
  "boxName": "隐藏款便当🍀",       // 盒名（由种子+档案派生）
  "profile": "saver",
  "profileLabel": "省钱盒",
  "profileDesc": "同预算下花得更少、把券用到极致",
  "items": [ { "code": "...", "name": "...", "priceFen": 3150, "kcal": 730, "category": "combo", "isNew": false,
               "comboItems": [ { "name": "吉士汉堡包", "category": "burger", "quantity": 1 },
                               { "name": "中薯条", "category": "side", "quantity": 1 },
                               { "name": "可口可乐中杯", "category": "drink", "quantity": 1 } ] } ],
  "pattern": "ala-carte",         // 取法：'ala-carte'（单点 主食+小食+饮料）/ 'combo'（整份套餐）
  "originalFen": 3950,           // 原价合计（分）
  "finalFen": 3350,              // 到手价（分）
  "savedFen": 600,               // 立省（分）
  "kcal": 550,                   // 总热量
  "coupon": { "id": "...", "code": "...", "name": "鳕鱼堡立减 6 元" },  // 命中的券，可为 null
  "surprise": 72,                // 惊喜度 0-100
  "reasons": ["用券立省 ¥6.00"],   // 入选理由
  "candidateCount": 11,          // 可行组合总数
  "poolSize": 4                  // 打分前 N 名（抽取池大小）
}
```

失败时返回：

```jsonc
{ "ok": false, "error": "在给定预算/热量/忌口约束下没有可用组合，请放宽条件。" }
```

---

## 3. 算法流程

```
seed ──hashSeed──▶ 32位种子 ──mulberry32──▶ 确定性 PRNG
                                              │
meals ─┐                                      │
      ├─ buildCombos()  单点组合 + 套餐 两条取法  │
budget ┤   ↓ 硬约束过滤（预算 / 热量 / 忌口）    │
kcal  ─┘   ↓                                 │
          combos ── applyBestCoupon() ──▶ 定价 │
                  └─ scoreCombo() ──▶ 打分     │
                          ↓                  │
              取 Top-K 自适应池 ◀─────────────┘
                          ↓
              pickWeighted(rng, 池)  ──▶ 开出唯一盒子
                          ↓
              surpriseScore() ──▶ 惊喜度
```

### 关键设计点

1. **可复现**：随机性 100% 来自 `seed`，不使用 `Math.random()`。同输入 ⇒ 同输出。
2. **两种取法同池**：盒的合法构成有两条，`buildCombos` 同时生成、放进同一个池子竞争：
   - **单点**（`pattern: 'ala-carte'`）：主食 + 小食 + 饮料；
   - **套餐**（`pattern: 'combo'`）：一个「含主食 + 饮料」的套餐即可独立成盒。
   两条取法都必须覆盖到「主食 + 饮料」；只有主食、或只有小食的套餐**不入池**。
3. **硬约束优先**：预算 / 热量 / 忌口在候选生成阶段就被过滤，不可能开出违规盒子。
4. **多样选池 + 名次加权抽取**：既不是"死板取最优"，也不是"完全乱来"。
   - **选池**（K 自适应，约为候选数的 30%，上限 `poolSize`）分三轮：
     ⓪ **套餐配额**：`preferCombo` 默认开启，先把预算内的**套餐**按分数填进池子（目标占比 `comboShare = 0.7`）——
        套餐自带主食 + 饮料，天然避开「单点拼盒时最便宜的饮料垄断整池」（实测单一饮品占比曾高达 **98%**）。
        同时**限制单点在池中的上限**（`K − ceil(K × comboShare)`，最少 2 个），否则池子会被单点稀释、
        套餐只占 1/3。池子里套餐越多效果越明显，所以归一化时要**尽量把预算内的套餐都纳入**
        （实测：4 个套餐 → 套餐占比 79%；关闭偏好时仅 20.5%）。
     ① **饮品保底**：为部分饮品各留 1 个最高分组合（最多占剩余名额一半）—— 让每款饮料都有出镜机会；
     ② **补充**：按分数降序填满剩余名额。
     三轮都限制「任一同款餐品在池中出现次数 < `ceil(K/3)`」，被挡掉的高分候选不回落补位。
   - **抽取**在池内按「**名次**线性加权」（第 1 名权重 = 池大小，末位 = 1），而不是按原始分数 ——
     档案评分是单目标线性的，分数差可达数百点，直接按分数加权会重新退化成「每次都开同一个盒」。
   - 取舍：多样性会让「省钱盒」的平均到手价高于「永远只开最便宜那一盒」，这是有意为之。
   - 函数入口：`selectDiversePool(ranked, K, maxShare = 1/3)`。
5. **券自动最优**：在可用券中挑减免额最大的一张叠加，展示省钱前后对比。
6. **惊喜度**：券利用率 + 新品数 + 预算"甜蜜区"（落在预算 60%~95% 最惊喜）的复合指标，用于展示，不参与决策。

---

## 4. CLI 用法

```bash
# 单盒：内置 Demo 数据开盒（零配置体验）
node scripts/box-engine.mjs --demo --profile saver --seed 20261026

# 单盒：从文件读取归一化输入
node scripts/box-engine.mjs --in input.json --profile lean --budget 35

# 单盒：从 stdin 读取（推荐给自动化 / MCP 编排使用）
cat input.json | node scripts/box-engine.mjs --stdin --json

# 候选模式：摇 6 个候选盲盒（封盒展示）
node scripts/box-engine.mjs --stdin --candidates 6 < input.json

# 候选模式：揭晓第 3 个（用户选定序号后）
node scripts/box-engine.mjs --stdin --candidates 6 --pick 3 < input.json

# 运行单元测试
node --test scripts/box-engine.test.mjs
```

| 参数 | 说明 |
|---|---|
| `--demo` | 使用内置示例数据 |
| `--in <file>` | 从 JSON 文件读输入 |
| `--stdin` | 从标准输入读输入 |
| `--profile <p>` | 盒子档案（`saver` / `lean` / `explorer` / `random`） |
| `--seed <s>` | 随机种子（默认当天日期） |
| `--budget <元>` | 预算上限（元，自动转分） |
| `--candidates <n>` | **候选模式**：摇 n 个互不相同的候选盲盒（默认 6） |
| `--pick <i>` | 与 `--candidates` 连用：揭晓第 i 个（1-based） |
| `--reveal` | 与 `--candidates` 连用：一次性揭晓全部候选 |
| `--json` | 输出 JSON 而非 Markdown 卡片 |

---

## 5. 候选盲盒（推荐交互）

交互要求「**先问盒型 → 再问预算 → 摇 6 个候选 → 用户挑 1 个揭晓**」，引擎为此提供：

| 函数 | 作用 |
|---|---|
| `openBoxes(input, n=6)` | 摇出 n 个**互不相同**的候选盒（由 seed 派生子种子 + 按餐品集合去重）；候选不足时自动放宽抽取池补足 |
| `sealCandidate(box, i)` | **封盒**：只保留线索，不含具体餐品 |
| `openCandidates(input, n=6)` | = 摇 n 个 + 全部封盒 |
| `renderCandidates(list)` | 把封盒候选渲染成 Markdown 表格 |

### 封盒字段（`sealCandidate` 输出）

| 字段 | 说明 |
|---|---|
| `no` | 展示序号（1-based） |
| `boxNo` | 盒子编号 |
| `boxName` | 盒名 |
| `profile` / `profileLabel` | 档案 |
| `originalFen` / `finalFen` / `savedFen` | 原价 / 到手价 / 立省（分） |
| `kcal` | 整盒热量 |
| `hasNew` | 是否含新品 / 限定 |
| `itemCount` | 餐品数量 |
| `surprise` | 惊喜度 0-100 |

> 封盒**不包含** `items` 与 `coupon` —— 用户选定序号后才用 `--pick` 揭晓完整内容。
> 确定性：相同 `seed` + 相同输入 ⇒ 同一批候选、同一顺序。

### 抽取池自适应

- 常规开盒：Top-K = `min(poolSize, max(3, ceil(候选数 × 0.3)))`，保留档案区分度。
- 候选模式：若按常规池凑不满 n 个互不相同的盒，自动切到**全量池**补足，保证候选数量。
