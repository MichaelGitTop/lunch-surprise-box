# 麦当劳 MCP 工具速查（午餐惊喜盒用到的部分）

数据来源：麦当劳 MCP Server `https://mcp.mcd.cn`

---

## 一、按场景分组

### 会话 / 时间

| Tool | 用途 | 关键入参 |
|---|---|---|
| `now-time-info` | 取服务器当前时间，判断午市 / 预约 | 无 |

### 门店

| Tool | 用途 | 关键入参 |
|---|---|---|
| `query-nearby-stores` | 到店 / 得来速门店（收藏或按位置搜） | `searchType`(1收藏/2搜索)、`beType`(1/5)、`city`、`keyword` |
| `delivery-query-stores` | 外送 / 团餐门店 | — |
| `delivery-query-addresses` | 外送地址列表 | — |

### 餐品 / 营养

| Tool | 用途 | 关键入参 |
|---|---|---|
| `query-meals` | 在售餐品列表（含价格、随单购） | `storeCode`、`orderType`、`beType`、`beCode` |
| `query-meal-detail` | 餐品组成 / 特调项 | `storeCode`、`orderType`、`beType`、`code` |
| `list-nutrition-foods` | 餐品营养成分（能量 / 蛋白质 / 脂肪 / 碳水 / 钠 / 钙） | 无 |

### 优惠

| Tool | 用途 | 关键入参 |
|---|---|---|
| `available-coupons` | 当前可领取的券 | 无 |
| `auto-bind-coupons` | 一键领取全部可领券 | 无 |
| `query-my-coupons` | 用户卡包中的券资产 | `page`、`pageSize` |
| `query-store-coupons` | **指定门店 + 场景下真正可用的券**（最准） | `storeCode`、`orderType`、`beType`、`beCode` |
| `query-promotions` | 团餐场景满减 / 满折规则 | `storeCode`、`beCode`、`orderType=2`、`beType=6` |
| `campaign-calendar` | 当月营销活动日历 | `specifiedDate`(可选) |

### 下单

| Tool | 用途 | 关键入参 |
|---|---|---|
| `calculate-price` | 算价（含券），返回 `takeWayList[].code` | `storeCode`、`orderType`、`beType`、`items[]` |
| `create-order` | 创建订单 | `storeCode`、`orderType`、`beType`、`items[]`、`takeWayCode`、`addressId`(外送) |
| `order-list` / `query-order` | 历史订单 / 订单详情 | — |

---

## 二、`beType` × `orderType` 传递规则（易错点）

| 取餐方式 | `beType` | `orderType` | `beCode` |
|---|:--:|:--:|---|
| 到店自取 | 1 | 1 | **不传**（传了会报错） |
| 得来速 DT | 5 | 1 | **必传**（来自 `query-nearby-stores`） |
| 麦乐送 | 2 | 2 | **必传**（来自 `delivery-query-stores`） |
| 企业团餐 | 6 | 2 | **必传**，另需 `gmServiceCode` |

> ⚠️ 金额字段单位是**分**，展示时需 ÷100。
> ⚠️ 到店自取下 `beCode` 是无效参数，传了会报错。

---

## 三、午餐惊喜盒的调用链

```
now-time-info
      ↓
query-nearby-stores / delivery-query-stores ──▶ storeCode (+beCode)
      ↓
available-coupons → auto-bind-coupons → query-my-coupons → query-store-coupons ──▶ coupons[]
      ↓
query-meals (+ list-nutrition-foods) ──▶ meals[]
      ↓
      ┌───────────────────────────────┐
      │  scripts/box-engine.mjs 开盒    │  ← 本地确定性计算
      └───────────────────────────────┘
      ↓
calculate-price ──▶ create-order ──▶ 支付
```
