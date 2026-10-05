// 端到端演练：麦穗烘焙·云栖店闭店清算。
// 把品牌退场负责人面对的真实困局逐条落成事实：
// 储值金跨店、蛋糕定金在加盟商账户、冷柜是租赁资产、中央工厂备了七天料、
// 最后班次与房租持续计提。运行：node src/scenario.js
//
// 本文件同时被测试复用（导出 buildScenario）。

import { ClosureEngine, ClosureRuleError } from "./engine.js";
import { EventStore } from "./event-store.js";

const CASE = "case-yunqi-001";
const T = (d) => `${d}T09:00:00+08:00`;

export function buildScenario(store = new EventStore()) {
  const eng = new ClosureEngine(store);
  const log = [];
  const note = (text) => log.push(text);

  // 0. 公告：三个渠道同时发出，最后营业日 2026-10-08。
  eng.openCase({
    case_id: CASE,
    store: { store_id: "st-042", name: "麦穗烘焙·云栖店", address: "云栖路 88 号", business_mode: "franchise" },
    announced_channels: ["门店公告", "微信公众号", "会员短信"],
    last_business_day: "2026-10-08",
    central_kitchen: { id: "ck-01", name: "中央工厂", production_horizon_days: 7 },
    occurred_at: T("2026-10-01"),
  });

  // 1. 先分清经营主体与每一类权利义务——钱在谁账户、东西归谁。
  const subjects = [
    { subject: { subject_id: "subj-brand", name: "麦穗品牌管理有限公司", kind: "brand_owner" },
      rights: ["品牌监管户内储值金管理权"], obligations: ["储值金跨店承接与退款的兜底责任"] },
    { subject: { subject_id: "subj-operator", name: "云栖餐饮管理有限公司", kind: "operating_entity" },
      rights: ["门店设备使用权"], obligations: ["员工工资", "房租结算", "供应商货款"] },
    { subject: { subject_id: "subj-franchisee", name: "加盟商周某", kind: "franchisee" },
      rights: ["加盟保证金返还请求权"], obligations: ["已收取蛋糕定金的退款责任"] },
    { subject: { subject_id: "subj-ck", name: "中央工厂", kind: "central_kitchen" },
      rights: ["已备料货款请求权"], obligations: ["未来七天备料的调拨与退货配合"] },
    { subject: { subject_id: "subj-landlord", name: "云栖物业管理有限公司", kind: "landlord" },
      rights: ["按日收取租金"], obligations: ["退还押金配合交接"] },
    { subject: { subject_id: "subj-lessor", name: "冰锋冷链设备租赁公司", kind: "lessor" },
      rights: ["收回租赁冷柜与租金"], obligations: ["配合交接验收"] },
    { subject: { subject_id: "subj-flour", name: "麦香原料商行", kind: "supplier" },
      rights: ["到期货款请求权"], obligations: ["未拆封原料退货受理"] },
    { subject: { subject_id: "subj-pack", name: "新艺包装厂", kind: "supplier" },
      rights: ["到期货款请求权"], obligations: [] },
    { subject: { subject_id: "subj-rl", name: "麦穗烘焙·人民路店", kind: "neighbor_store" },
      rights: ["自主申报承接产能"], obligations: ["按承接订单履约"] },
    { subject: { subject_id: "subj-employees", name: "云栖店员工组（8人）", kind: "employee_group" },
      rights: ["最后班次工资与经济补偿请求权"], obligations: ["值守至最后营业日"] },
    { subject: { subject_id: "subj-cust-b", name: "顾客B", kind: "customer" }, rights: ["蛋糕定金返还请求权"], obligations: [] },
    { subject: { subject_id: "subj-cust-c", name: "顾客C", kind: "customer" }, rights: ["储值金余额返还请求权"], obligations: [] },
    { subject: { subject_id: "subj-platform", name: "支付平台", kind: "payment_platform" }, rights: [], obligations: ["按指令原路退款"] },
  ];
  subjects.forEach((s, i) =>
    eng.registerSubject(CASE, { ...s, occurred_at: T(`2026-10-01`) }),
  );

  // 2. 登记顾客权益：储值金在品牌监管户；蛋糕定金进了加盟商私人账户——分账标记。
  //    会员系统微信推送重复送达两次，同一 source_notice_id 只吸收一次。
  const claimFields = [
    { claim_id: "claim-001", customer: { customer_id: "cust-a", contact_masked: "138****0001" }, claim_kind: "stored_value", amount_minor: 30000, funds_location: "brand_escrow", liable_subject_id: "subj-brand", source_channel: "会员系统" },
    { claim_id: "claim-002", customer: { customer_id: "cust-b", contact_masked: "139****0002" }, claim_kind: "cake_deposit", amount_minor: 5000, funds_location: "franchisee_private_account", liable_subject_id: "subj-franchisee", source_notice_id: "wxp-push-7782", source_channel: "门店蛋糕订单" },
    { claim_id: "claim-003", customer: { customer_id: "cust-c", contact_masked: "137****0003" }, claim_kind: "stored_value", amount_minor: 12800, funds_location: "brand_escrow", liable_subject_id: "subj-brand", source_channel: "会员系统" },
    { claim_id: "claim-004", customer: { customer_id: "cust-d", contact_masked: "136****0004" }, claim_kind: "prepaid_order", amount_minor: 8000, funds_location: "store_entity_account", liable_subject_id: "subj-operator", source_channel: "会员系统" },
    { claim_id: "claim-005", customer: { customer_id: "cust-e", contact_masked: "135****0005" }, claim_kind: "stored_value", amount_minor: 5000, funds_location: "brand_escrow", liable_subject_id: "subj-brand", source_channel: "会员系统" },
  ];
  for (const f of claimFields) eng.registerClaim(CASE, { ...f, occurred_at: T("2026-10-02") });
  const retry = eng.registerClaim(CASE, { ...claimFields[1], occurred_at: T("2026-10-02T09:05:00+08:00") });
  note(`重复通知吸收：第二次推送返回既有事件 ${retry.event_id}，权益单仍只有 5 张`);

  // 3. 邻店申报产能；顾客逐一作出选择（必须本人确认）。
  eng.declareCapacity(CASE, { neighbor_store_id: "subj-rl", service_date: "2026-10-10", product_line: "birthday_cake", slots_total: 2, occurred_at: T("2026-10-02") });

  eng.recordCustomerChoice(CASE, "claim-001", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-rl", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03"), source_notice_id: "choice-a-001" });
  eng.recordCustomerChoice(CASE, "claim-002", { choice: "refund", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  eng.recordCustomerChoice(CASE, "claim-003", { choice: "refund", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  eng.recordCustomerChoice(CASE, "claim-004", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-rl", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  eng.waiveClaim(CASE, "claim-005", { customer_confirmed: true, reason: "顾客主动放弃小额余额", occurred_at: T("2026-10-04") });

  // 4. 订单转移：确认 + 产能双校验，两单把 10-10 蛋糕产能占满 2/2。
  eng.transferOrder(CASE, "claim-001", { neighbor_store_id: "subj-rl", service_date: "2026-10-10", product_line: "birthday_cake", transfer_order_id: "rl-x-1001", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-04") });
  eng.transferOrder(CASE, "claim-004", { neighbor_store_id: "subj-rl", service_date: "2026-10-10", product_line: "birthday_cake", transfer_order_id: "rl-x-1002", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-04") });

  // 5. 库存逐批登记——包括中央工厂按未来七天备好的淡奶油与蛋糕胚。
  eng.classifyInventory(CASE, {
    lots: [
      { lot_id: "lot-bread-1007", name: "当日鲜面包", category: "food", quantity: 24, unit: "个", produced_at: T("2026-10-05"), expiry_at: T("2026-10-07"), source: "self", edible: true },
      { lot_id: "lot-base-1009", name: "戚风蛋糕胚", category: "food", quantity: 6, unit: "个", produced_at: T("2026-10-04"), expiry_at: T("2026-10-09"), source: "central_kitchen", edible: true },
      { lot_id: "lot-cream-1012", name: "淡奶油（中央工厂七天备料）", category: "food", quantity: 12, unit: "升", produced_at: T("2026-10-04"), expiry_at: T("2026-10-12"), source: "central_kitchen", edible: true },
      { lot_id: "lot-yogurt-1004", name: "冷藏酸奶", category: "food", quantity: 8, unit: "瓶", produced_at: T("2026-09-28"), expiry_at: T("2026-10-04"), source: "supplier", edible: false },
      { lot_id: "lot-flour", name: "高筋面粉（未拆封）", category: "material", quantity: 20, unit: "袋", source: "supplier" },
      { lot_id: "lot-box", name: "品牌包装盒", category: "packaging", quantity: 300, unit: "个", source: "supplier" },
    ],
    occurred_at: T("2026-10-02"),
  });

  // 6. 租赁冷柜先排期归还；冷柜归租赁公司，店里说了不算。
  eng.scheduleAssetReturn(CASE, {
    asset: { asset_id: "cold-01", name: "立式风冷冷藏柜", serial: "BF-2024-0077", refrigerated: true, owner_subject_id: "subj-lessor", lease_contract_no: "ZL-2025-031" },
    scheduled_at: T("2026-10-07"), handover_location: "云栖路 88 号店内", occurred_at: T("2026-10-02"),
  });

  // 7. 登记应付款；工资与房租标 accruable，随后持续追加计提。
  eng.enterObligation(CASE, { obligation_code: "ref-c-003", category: "customer_refund", payee: { subject_id: "subj-cust-c", name: "顾客C" }, amount_minor: 12800, incurred_at: T("2026-10-03"), claim_id: "claim-003", occurred_at: T("2026-10-03") });
  eng.enterObligation(CASE, { obligation_code: "cake-b-002", category: "cake_deposit_refund", payee: { subject_id: "subj-cust-b", name: "顾客B" }, amount_minor: 5000, incurred_at: T("2026-09-25"), claim_id: "claim-002", occurred_at: T("2026-10-03") });
  eng.enterObligation(CASE, { obligation_code: "wage-09", category: "employee_wage", payee: { subject_id: "subj-employees", name: "云栖店员工组" }, amount_minor: 250000, incurred_at: T("2026-09-30"), accruable: true, occurred_at: T("2026-10-01") });
  eng.enterObligation(CASE, { obligation_code: "sev-01", category: "employee_severance", payee: { subject_id: "subj-employees", name: "云栖店员工组" }, amount_minor: 120000, incurred_at: T("2026-10-08"), payroll_final: true, occurred_at: T("2026-10-05") });
  eng.enterObligation(CASE, { obligation_code: "rent-10", category: "rent", payee: { subject_id: "subj-landlord", name: "云栖物业" }, amount_minor: 0, incurred_at: T("2026-10-01"), accruable: true, occurred_at: T("2026-10-01") });
  eng.enterObligation(CASE, { obligation_code: "lease-01", category: "lease_fee", payee: { subject_id: "subj-lessor", name: "冰锋租赁" }, amount_minor: 15000, incurred_at: T("2026-10-07"), occurred_at: T("2026-10-02") });
  eng.enterObligation(CASE, { obligation_code: "sup-flour", category: "supplier_payable", payee: { subject_id: "subj-flour", name: "麦香原料" }, amount_minor: 90000, incurred_at: T("2026-09-30"), occurred_at: T("2026-10-02") });
  eng.enterObligation(CASE, { obligation_code: "fr-deposit", category: "franchise_claim", payee: { subject_id: "subj-franchisee", name: "加盟商周某" }, amount_minor: 100000, incurred_at: T("2026-10-01"), occurred_at: T("2026-10-01") });

  // 8. 最后班次与房租继续产生——只追加计提，旧金额不动。
  eng.appendAccrual(CASE, "wage-09", { period: { from: "2026-10-01", to: "2026-10-04" }, amount_delta_minor: 68800, basis: "8人最后值守班次", occurred_at: T("2026-10-05"), source_notice_id: "ats-1005" });
  eng.appendAccrual(CASE, "wage-09", { period: { from: "2026-10-05", to: "2026-10-08" }, amount_delta_minor: 68800, basis: "8人收官班次", occurred_at: T("2026-10-08"), source_notice_id: "ats-1008" });
  eng.appendAccrual(CASE, "rent-10", { period: { from: "2026-10-01", to: "2026-10-05" }, amount_delta_minor: 100000, basis: "日租 200 元/天 × 5 天", occurred_at: T("2026-10-05") });
  eng.appendAccrual(CASE, "rent-10", { period: { from: "2026-10-06", to: "2026-10-08" }, amount_delta_minor: 60000, basis: "日租 200 元/天 × 3 天", occurred_at: T("2026-10-08") });

  // 9. 责任争议：蛋糕定金争议与面粉退货争议各只冻结争议金额。
  eng.disputeObligation(CASE, "cake-b-002", { disputed_by_subject_id: "subj-franchisee", disputed_amount_minor: 5000, reason: "加盟商主张定金已抵扣品牌管理费，拒绝全额退款", evidence_notice_ids: ["wxp-push-7782"], occurred_at: T("2026-10-04") });
  eng.disputeObligation(CASE, "sup-flour", { disputed_by_subject_id: "subj-operator", disputed_amount_minor: 30000, reason: "20 袋未拆封面粉退货，对应货款应冲减", evidence_notice_ids: [], occurred_at: T("2026-10-05") });

  // 10. 食品与物料的安全处置：能卖的调邻店、能吃的捐赠、过期的销毁、能退的退货。
  eng.disposeInventory(CASE, { lot_ids: ["lot-base-1009", "lot-cream-1012"], method: "neighbor_transfer", handled_at: T("2026-10-05"), neighbor_store_id: "subj-rl", occurred_at: T("2026-10-05") });
  eng.disposeInventory(CASE, { lot_ids: ["lot-bread-1007"], method: "charity_donation", handled_at: T("2026-10-05"), donee: "云栖社区食物分享点", occurred_at: T("2026-10-05") });
  eng.disposeInventory(CASE, { lot_ids: ["lot-flour"], method: "supplier_return", handled_at: T("2026-10-06"), occurred_at: T("2026-10-06"), evidence_ref: "退货签收单 TH-2207" });
  eng.disposeInventory(CASE, { lot_ids: ["lot-box"], method: "supplier_return", handled_at: T("2026-10-06"), occurred_at: T("2026-10-06"), evidence_ref: "包装厂入库回执" });
  eng.disposeInventory(CASE, { lot_ids: ["lot-yogurt-1004"], method: "safe_destruction", handled_at: T("2026-10-06"), evidence_ref: "销毁影像 VID-20261006-03", occurred_at: T("2026-10-06") });

  // 11. 冷链食品全部处置完毕后，冷柜才能归还（不断链）。
  eng.returnAsset(CASE, "cold-01", { returned_at: T("2026-10-07"), condition: "外观完好，制冷正常", receiver: "冰锋租赁验收员钱某", remark: "押钥匙当面交接", occurred_at: T("2026-10-07"), source_notice_id: "asset-7781" });

  // 12. 支付按顺位执行：顾客退款 → 员工 → 房租 → 租赁费 → 供应商 → 加盟余额。
  //     储值金退款不受蛋糕定金争议影响，照常支付。
  eng.settlePayment(CASE, "ref-c-003", { amount_minor: 12800, paid_at: T("2026-10-06"), channel: "支付平台原路退回", reference: "RF-20261006-01", source_notice_id: "paycb-6601" });
  // 支付平台重复回调：同一 source_notice_id 只入账一次。
  const payRetry = eng.settlePayment(CASE, "ref-c-003", { amount_minor: 12800, paid_at: T("2026-10-06"), channel: "支付平台原路退回", reference: "RF-20261006-01", source_notice_id: "paycb-6601" });
  note(`支付回调重放：第二次回调未新增流水（${payRetry.event_id}）`);

  eng.settlePayment(CASE, "wage-09", { amount_minor: 387600, paid_at: T("2026-10-08"), channel: "工资专户", reference: "PAY-20261008-W1" });
  eng.settlePayment(CASE, "sev-01", { amount_minor: 120000, paid_at: T("2026-10-08"), channel: "工资专户", reference: "PAY-20261008-S1" });
  eng.settlePayment(CASE, "rent-10", { amount_minor: 160000, paid_at: T("2026-10-08"), channel: "对公转账", reference: "PAY-20261008-R1" });
  eng.settlePayment(CASE, "lease-01", { amount_minor: 15000, paid_at: T("2026-10-08"), channel: "对公转账", reference: "PAY-20261008-L1" });

  // 面粉争议裁定：退货部分免除，余额支付。
  eng.resolveDispute(CASE, "sup-flour", { resolution: "waive", payable_amount_minor: 0, decided_by: "品牌退场清算组", note: "退货冲减 30000 分", occurred_at: T("2026-10-08") });
  eng.settlePayment(CASE, "sup-flour", { amount_minor: 60000, paid_at: T("2026-10-08"), channel: "对公转账", reference: "PAY-20261008-F1" });

  // 蛋糕定金争议部分成立：加盟商承担 3000 分，其余品牌兜底，顾客拿到 3000 分；
  // 品牌兜底部分另立义务支付（保持该义务金额语义单一）。
  eng.resolveDispute(CASE, "cake-b-002", { resolution: "partial", payable_amount_minor: 3000, decided_by: "品牌与加盟商联合清算纪要", note: "3000 分由加盟商承担，2000 分品牌兜底另付", occurred_at: T("2026-10-08") });
  eng.settlePayment(CASE, "cake-b-002", { amount_minor: 3000, paid_at: T("2026-10-09"), channel: "加盟商账户原路退回", reference: "RF-20261009-B1" });
  eng.enterObligation(CASE, { obligation_code: "cake-b-002b", category: "cake_deposit_refund", payee: { subject_id: "subj-cust-b", name: "顾客B" }, amount_minor: 2000, incurred_at: T("2026-10-08"), claim_id: "claim-002", occurred_at: T("2026-10-09") });
  eng.settlePayment(CASE, "cake-b-002b", { amount_minor: 2000, paid_at: T("2026-10-09"), channel: "品牌监管户兜底退款", reference: "RF-20261009-B2" });

  // 加盟保证金：最低顺位，争议部分裁定后支付余额。
  eng.disputeObligation(CASE, "fr-deposit", { disputed_by_subject_id: "subj-brand", disputed_amount_minor: 40000, reason: "会员通知与交接协助费用拟从保证金扣减", occurred_at: T("2026-10-09") });
  eng.resolveDispute(CASE, "fr-deposit", { resolution: "partial", payable_amount_minor: 20000, decided_by: "加盟合同清算纪要", note: "扣减 20000 分", occurred_at: T("2026-10-09") });
  eng.settlePayment(CASE, "fr-deposit", { amount_minor: 80000, paid_at: T("2026-10-09"), channel: "品牌监管户", reference: "PAY-20261009-D1" });

  const closeEvent = eng.closeCase(CASE, { occurred_at: T("2026-10-09") });

  return { engine: eng, store, caseId: CASE, closeEvent, log, note };
}

/** 演练中常用的"尝试一条应被拒收的命令"。 */
export function expectRejected(fn, fragment) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClosureRuleError && (!fragment || err.message.includes(fragment))) return err.message;
    throw err;
  }
  throw new Error(`命令应当被拒收${fragment ? `（含“${fragment}”）` : ""}，但却成功了`);
}

const runningDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (runningDirectly) {
  const { engine, caseId, store, closeEvent, log } = buildScenario();

  console.log("=== 麦穗烘焙·云栖店退场清算演练 ===\n");
  for (const line of log) console.log(`· ${line}\n`);

  // 在支付开始前取一张未结清单快照，展示四桶分类。
  const midEngine = (() => {
    // 用截至 10-06 的事件重建一台引擎，呈现"等待顾客选择已清空、款项仍待支付"的中段状态。
    const cutoff = new Date("2026-10-06T23:59:59+08:00").getTime();
    const partial = new EventStore();
    for (const e of store.forCase(caseId)) if (Date.parse(e.occurred_at) <= cutoff) partial.append(structuredClone(e));
    return new ClosureEngine(partial);
  })();
  const cl = midEngine.checklist(caseId);
  console.log("=== 10-06 晚间未结清单快照 ===");
  console.log("等待顾客选择：", cl.awaiting_customer_choice.length, "项");
  console.log("等待承接：", cl.awaiting_transfer);
  console.log("待支付：", cl.awaiting_payment.map((p) => `${p.obligation_code} 未付${p.unpaid_minor}分`).join("；"));
  console.log("责任争议：", cl.liability_disputes.map((p) => `${p.obligation_code} 争议${p.disputed_minor}分`).join("；"));
  console.log("操作交接：", cl.operational_handover.map((p) => p.type).join("；"), "\n");

  console.log("=== 最终关闭时五道闸门 ===");
  for (const [name, result] of Object.entries(engine.gates(caseId))) {
    console.log(`${name}: ${result.passed ? "通过" : "未通过"}`);
  }
  console.log(`\n关闭事件：${closeEvent.event_type}（${closeEvent.event_id}）`);
  console.log(`事件总数：${store.forCase(caseId).length}，全部只追加，无旧记录被修改。`);
}
