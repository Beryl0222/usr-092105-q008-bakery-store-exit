# 领域事件约定（payload）

所有跨机构交换的事实都使用 `contracts/domain.schema.json` 的信封，且只能归入四个聚合之一：

| 聚合 | aggregate_id 约定 | 承载事实 |
| --- | --- | --- |
| `closure_case` | 案件标识（如 `case-001`） | 公告、主体与权责登记、邻店产能申报、最终关闭 |
| `customer_claim` | 顾客权益单项标识（如 `claim-0007`） | 储值金/蛋糕定金/预付订单登记、顾客选择、订单转移 |
| `inventory_disposition` | 食品处置流 `disp-<案件>`；租赁资产归还流 `asset-<资产编号>` | 临期食品分类与安全处置、租赁冷柜等资产交接 |
| `settlement_payment` | 付款义务流 `pay-<义务编号>` | 应付义务登记、持续计提、争议、支付流水 |

事件**只追加**：版本按聚合从 1 递增；任何更正都通过追加新事件表达，
支付永远追加 `PAYMENT_SETTLED` 流水，不修改旧支付记录。

金额一律使用 `amount_minor`（人民币分，整数）与 `currency: "CNY"`。

## closure_case

### CLOSURE_ANNOUNCED（v1，案件首事件）
```json
{
  "store": {"store_id": "st-042", "name": "麦穗烘焙·云栖店", "address": "…", "business_mode": "franchise"},
  "announced_channels": ["门店公告", "微信公众号", "会员短信"],
  "last_business_day": "2026-10-08",
  "central_kitchen": {"id": "ck-01", "name": "中央工厂", "production_horizon_days": 7}
}
```

### SUBJECT_REGISTERED
`payload.subject`：`{subject_id, name, kind}`，kind ∈
`brand_owner / operating_entity / franchisee / central_kitchen / landlord / lessor /
supplier / neighbor_store / employee_group / customer / payment_platform`。
`payload.rights[]` 与 `payload.obligations[]` 描述该主体在本店的权利与义务
（义务编号随后以 `pay-<义务编号>` 成为付款流）。**先分清"钱在谁账户、东西归谁"，再谈处置。**

### TRANSFER_CAPACITY_DECLARED
`{neighbor_store_id, service_date, product_line, slots_total}`。
邻店每次申报在投影中替换该门店/日期/品类的总产能；已占用产能不因重报而丢失。

### CASE_CLOSED
`{gates: {orders, food_safety, employee_payments, leased_assets, supplier_liabilities}}`，
五项必须全部为 `passed`（由引擎在关闭时核对，拒收手填结果）。

## customer_claim

### CLAIM_REGISTERED（v1）
`{customer: {customer_id, contact_masked}, claim_kind, amount_minor, currency,
funds_location, liable_subject_id, source_channel}`
- claim_kind ∈ `stored_value / cake_deposit / prepaid_order`
- funds_location ∈ `store_entity_account / franchisee_private_account / brand_escrow`
  —— 蛋糕定金进了加盟商私人账户，与在品牌监管户的储值金必须分账标记。

### CUSTOMER_CHOICE_RECORDED
`{choice: transfer_to_neighbor | refund | waive, neighbor_store_id?,
customer_confirmed: true, confirmed_at}`。
没有顾客明确确认，不得选择承接门店。

### ORDER_TRANSFERRED
`{neighbor_store_id, service_date, product_line, transfer_order_id,
customer_confirmed: true, capacity: {slots_before, slots_after, within_capacity: true}}`。
前置：顾客已确认转入该邻店，且该日期/品类仍有产能。

### CLAIM_WAIVED
`{customer_confirmed: true, reason}`，顾客明确放弃时的终态事件。

## inventory_disposition

### INVENTORY_CLASSIFIED
`{lots: [{lot_id, name, category: food|material|packaging, quantity, unit,
produced_at, expiry_at, source: central_kitchen|supplier|self, edible}]}`。
中央工厂按未来七天备好的料同样必须逐批登记，不得直接丢弃或抵债。

### INVENTORY_DISPOSED
`{lot_ids, method, handled_at, evidence_ref, neighbor_store_id?, donee?}`。
食品（category=food）允许的 method：
- `neighbor_transfer`：邻店调拨继续销售/使用，须仍在保质期内、接收方有食品经营资质，
  且 `for_debt_setoff` 必须为缺省/false——**临期食品不得为抵债而转卖**；
- `charity_donation`：临保但仍可安全食用，登记受赠方与时间；
- `safe_destruction`：过期或不适宜食用，安全销毁并留证；
- `supplier_return`：依据协议退货。

引擎明确拒收 `debt_recovery_sale`（抵债转卖）以及任何把食品处置款指定给债权人的做法。

### LEASED_ASSET_RETURN_SCHEDULED / LEASED_ASSET_RETURNED
aggregate_id 使用 `asset-<资产编号>`，每条资产独立版本流。
`{asset: {asset_id, name, serial, refrigerated: true|false,
owner_subject_id, lease_contract_no}, scheduled_at, handover_location}`；
归还事件携带 `{returned_at, condition, receiver, remark}`。
冷藏资产在店内仍有未处置冷链食品时不得归还（断链责任）。

## settlement_payment

### PAYMENT_OBLIGATION_ENTERED（v1）
`{obligation_code, category, payee: {subject_id, name}, amount_minor, currency,
incurred_at, accruable: true|false, payroll_final: true|false, source_notice_id?}`
category ∈ `customer_refund / cake_deposit_refund / employee_wage /
employee_severance / rent / lease_fee / supplier_payable /
franchise_claim / asset_damage`。

### ACCRUAL_APPENDED
`{period: {from, to}, amount_delta_minor, basis, source_notice_id?}`。
只允许 accruable 的义务（员工最后班次工资、按日产生的房租）追加计提；
总额由投影累加，旧数字不改。

### OBLIGATION_DISPUTED
`{disputed_by_subject_id, disputed_amount_minor, reason, evidence_notice_ids[]}`。
**争议只冻结争议金额**：`可付余额 = 应付总额 − 争议金额`，无争议部分照常进入待支付清单并可支付。
品牌方与加盟商之间的定金/会员金争议，不得冻结其他顾客的无争议退款，
也不得冻结品牌监管户内与本案无关的余额。

### DISPUTE_RESOLVED
`{resolution: pay|waive|partial, payable_amount_minor, decided_by, note}`。

### PAYMENT_SETTLED
`{amount_minor, paid_at, channel, reference, source_notice_id?}`。
支付流水只追加；重复的支付回调凭 `source_notice_id` 或同一 `event_id` 只吸收一次。
引擎按法定/约定先后校验支付顺序：顾客退款 → 员工款项 → 房租 → 租赁费用 →
供应商货款；存在更高顺位的未付无争议义务时，低顺位支付被拒收。
