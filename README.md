# 🎁 午餐惊喜盒（Lunch Surprise Box）

> 每天中午都要纠结一次「吃什么」？把它变成一次**开盲盒**。
> 基于麦当劳 MCP 实时数据，在预算 / 热量 / 忌口约束下，为你摇出一份完整午餐（主食 + 小食 + 饮料），自动叠券并算出到手价。

<p align="center">
  <b>一句话：不纠结、不乱花、不踩忌口、还有惊喜。</b>
</p>

---

## 这是什么？

「午餐惊喜盒」是一个基于 **麦当劳 MCP（Model Context Protocol）** 开发的 Skill。

它不是又一个"菜单价格表"，而是把**决策**这件事本身做成了一次有趣的体验：

- **开盒**：不是让你从 50 个餐品里挑，而是直接给你**一个完整的盒子**。
- **可复现**：每个盒子绑定一个 `seed`。同一个种子永远开出同一个盒子 —— 你可以复读昨天的好运，也可以"再摇一次"。
- **有约束**：预算、热量、忌口都是硬约束，绝不会开出你不能吃的东西。
- **真省钱**：自动把你手上能用的券套到盒子上，明明白白告诉你省了多少。

---

## 它解决什么问题？

| 痛点 | 午餐惊喜盒的解法 |
|---|---|
| 中午选择困难，纠结 10 分钟 | 一次开盒直接给你答案 |
| 想省钱但不知道哪张券最划算 | 引擎自动选「省得最多」的可用券 |
| 减脂期怕点多了 | 轻盈盒 + 热量上限，硬约束过滤 |
| 有忌口（不吃腌黄瓜 / 不吃辣） | 忌口标签命中即排除，绝不踩雷 |
| 每天都吃一样，有点腻 | 尝鲜盒优先新品 / 限定 |
| 不想一件件凑，想来个套餐 | 套餐也纳入候选池 —— 只要含主食+饮料即可独立成盒 |
| 想分享「我今天吃啥」 | 每个盒子有唯一编号与名字，结果可复现可分享 |

---

## 目标用户

- **选择困难症上班族** —— 午休时间宝贵，只想快点决定吃什么。
- **精打细算的学生党 / 打工族** —— 想用最少的钱吃到最满足的午餐。
- **健身 / 减脂人群** —— 需要控卡，但不想自己一道道算热量。
- **有饮食忌口的人** —— 不想每次点餐都反复确认"这个有没有腌黄瓜"。
- **喜欢尝鲜的麦门玩家** —— 想第一时间吃到新品和限定款。

---

## 怎么用？（3 步）

### 1. 配置麦当劳 MCP

先在 [麦当劳 MCP 官网](https://open.mcd.cn/mcp) 申请 MCP Token，然后在 WorkBuddy 的「连接器 → 自定义连接器 → 配置 MCP」里填入 `mcp-config.example.json` 的内容（把 `${MCD_MCP_TOKEN}` 换成你的真实 Token）。

> 详细步骤见 [MCP_INTEGRATION.md](./MCP_INTEGRATION.md)

### 2. 安装本 Skill

把本目录放到 WorkBuddy 的 skills 目录下（或直接在本目录下工作）：

```bash
git clone <your-repo-url>
cd lunch-surprise-box
```

引擎零依赖，无需 `npm install`：

```bash
node scripts/box-engine.mjs --demo
```

### 3. 开始对话

直接在 WorkBuddy 里说（我会**先问盒型 → 再问预算 → 摇 6 个候选盲盒**供你挑）：

```
中午吃什么？帮我开个午餐盲盒
```

```
帮我点一份 30 块以内的午餐，不想吃腌黄瓜
```

```
想吃得清淡点，低卡午餐推荐
```

```
再摇一次
```

> 完整交互：**选盒型 → 定预算 → 摇出 6 个候选盲盒 → 回复序号揭晓**。每个盒子绑定可复现的 `seed`，同一个种子永远开出同一个盒子。

---

## 使用示例

### 示例一：省钱盒

输入：预算 40 元、不要腌黄瓜、省钱优先、种子 `20261026`

输出（`node scripts/box-engine.mjs --demo --profile saver --seed 20261026`）：

```markdown
## 隐藏款便当🍀　`NO.2634`

> 档案：**省钱盒** 💰 — 同预算下花得更少、把券用到极致
> 惊喜度：**57/100**　·　种子 `20261026`

| 组成 | 餐品 | 单价 | 热量 |
|:--:|---|---:|---:|
| 套餐 | 板烧鸡腿堡套餐 | ¥39.50 | 650 kcal |

- 套餐内容：主食 板烧鸡腿堡 · 小食 中薯条 · 饮料 可口可乐(中)
- 原价合计：¥39.50
- 已叠加券：**满 30 减 5**，立省 ¥5.00
- **到手价：¥34.50**　·　合计热量 650 kcal
- 入选理由：用券立省 ¥5.00
```

### 示例二：轻盈盒

```bash
node scripts/box-engine.mjs --demo --profile lean --seed 20261026
```

会优先挑低热量组合（引擎自动设 900 kcal 上限），例如「板烧鸡腿堡 + 玉米杯 + 零度可乐」≈ 521 kcal。

### 示例三：换个种子再摇

```bash
node scripts/box-engine.mjs --demo --seed lunch-7
```

同一个种子结果永远一致；换个种子就是新的惊喜。

### 示例四：摇 6 个候选盲盒（新交互）

```bash
node scripts/box-engine.mjs --demo --candidates 6 --profile saver --seed 20261026
```

先输出一张「封盒表」——只给线索、不暴露餐品：

```markdown
## 摇到 6 个候选盲盒 —— 挑一个打开吧

| # | 盒名 | 编号 | 到手价 | 热量 | 线索 |
|:--:|---|:--:|---:|---:|---|
| **1** | 满分食验品🍀 | NO.1899 | ¥31.50 | 660 kcal | 用券省 ¥5.00 |
| **2** | 限定一盒✨ | NO.9280 | ¥32.00 | 520 kcal | 用券省 ¥5.00 |
| **3** | 盲选悦食盒🌟 | NO.5137 | ¥33.50 | 550 kcal | 含新品 · 用券省 ¥6.00 |
```

用户回复序号后揭晓完整内容：

```bash
node scripts/box-engine.mjs --demo --candidates 6 --pick 3 --profile saver --seed 20261026
```

> 更多示例见 [`examples/sample-output.md`](examples/sample-output.md)

---

## 四个盒子档案

| 档案 | 键名 | 一句话 | 适合谁 |
|---|---|---|---|
| 💰 省钱盒 | `saver` | 花得更少、券用到极致 | 想省钱 |
| 🥗 轻盈盒 | `lean` | 控卡优先 | 减脂 / 健身 |
| 🎲 尝鲜盒 | `explorer` | 优先新品限定 | 喜欢新鲜感 |
| 🎁 随机盒 | `random` | 完全交给命运 | 佛系干饭人 |

---

## 命令行用法

```bash
# 单盒：内置示例数据，零配置体验
node scripts/box-engine.mjs --demo --profile saver --seed 20261026

# 单盒：用真实数据（把 MCP 返回归一化成 input.json 后）
node scripts/box-engine.mjs --in input.json --profile lean --budget 35

# 单盒：输出 JSON（供自动化编排消费）
cat input.json | node scripts/box-engine.mjs --stdin --json

# 候选模式：摇 6 个候选盲盒（封盒展示）
node scripts/box-engine.mjs --stdin --candidates 6 < input.json

# 候选模式：揭晓第 3 个（用户选定序号后）
node scripts/box-engine.mjs --stdin --candidates 6 --pick 3 < input.json

# 跑测试
node --test scripts/box-engine.test.mjs
```

| 参数 | 说明 |
|---|---|
| `--demo` | 使用内置示例数据 |
| `--in <file>` | 从 JSON 文件读输入 |
| `--stdin` | 从标准输入读输入 |
| `--profile <p>` | `saver` / `lean` / `explorer` / `random` |
| `--seed <s>` | 随机种子（默认当天日期） |
| `--budget <元>` | 预算上限 |
| `--candidates <n>` | 摇 n 个候选盲盒（默认 6） |
| `--pick <i>` | 与 `--candidates` 连用，揭晓第 i 个 |
| `--reveal` | 与 `--candidates` 连用，一次性揭晓全部 |
| `--json` | 输出 JSON |

---

## 工作原理

```
用户说「中午吃什么」
        │
        ▼
   先问盒型 → 再问预算
        │
        ▼
麦当劳 MCP（门店 / 餐品 / 券 / 营养）
        │
        ▼
   归一化输入（meals + coupons + 约束）
        │
        ▼
  scripts/box-engine.mjs
   ├─ 生成候选：单点「主食+小食+饮料」+ 含主食饮料的套餐
   ├─ 硬约束过滤（预算 / 热量 / 忌口）
   ├─ 自动叠加最优券
   ├─ 按档案打分 → 取 Top-K
   └─ 用 seed 驱动 PRNG 加权抽取
        │
        ▼
   摇出 6 个候选盲盒（封盒：只给线索，不露餐品）
        │
        ▼
   用户挑 1 个 → 揭晓完整卡片（盒名 / 明细 / 到手价 / 热量 / 惊喜度）
        │
        ▼
   calculate-price → create-order → 支付
```

核心引擎是一个**零依赖、确定性、可复现**的纯函数模块，已覆盖 26 个单元测试（含 3 个 CLI 集成测试）。

---

## 技术栈

- **运行时**：Node.js ≥ 18（仅用 `node:fs` / `node:test`，无第三方依赖）
- **数据源**：麦当劳 MCP Server（`https://mcp.mcd.cn`）
- **形态**：WorkBuddy / Claude Skill（`SKILL.md` + 本地引擎脚本）

---

## 目录结构

```
lunch-surprise-box/
├── README.md                     # 本文件
├── SKILL.md                      # Skill 定义与工作流
├── MCP_INTEGRATION.md            # MCP 集成说明
├── mcp-config.example.json       # 脱敏 MCP 配置示例
├── CONTEST_DECLARATION.md        # 参赛声明（官方原文）
├── workbuddy.md                  # WorkBuddy 开发对话上下文
├── references/
│   ├── mcp-tools.md              # MCP 工具速查
│   └── box-rules.md              # 开盒规则与字段
├── scripts/
│   ├── box-engine.mjs            # 开盒引擎（核心）
│   └── box-engine.test.mjs       # 单元测试
└── examples/
    └── sample-output.md          # 示例结果
```

---

## 免责声明

本项目为**麦当劳程序员节创意开发大赛参赛作品**，由参赛者独立开发，**非麦当劳官方产品**。

- 项目输出仅供参考，不构成医疗、营养或其他专业建议；
- 餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准；
- 参赛声明见 [CONTEST_DECLARATION.md](./CONTEST_DECLARATION.md)。

## License

MIT
