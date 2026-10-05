import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClosureEngine, ClosureRuleError } from "../src/engine.js";
import { EventStore } from "../src/event-store.js";
import { project, obligationNumbers, gates } from "../src/projection.js";
import { buildScenario, expectRejected } from "../src/scenario.js";

const T = (d, h = "09:00") => `${d}T${h}:00+08:00`;
const C = "case-test-1";

/** 构造一个已公告、主体齐备的最小案件。 */
function freshCase() {
  const store = new EventStore();
  const eng = new ClosureEngine(store);
  eng.openCase({
    case_id: C,
    store: { store_id: "st-1", name: "测试店", business_mode: "franchise" },
    announced_channels: ["门店公告", "会员短信"],
    last_business_day: "2026-10-08",
    central_kitchen: { id: "ck", name: "中央工厂", production_horizon_days: 7 },
    occurred_at: T("2026-10-01"),
  });
  const kinds = {
    brand: ["subj-brand", "品牌方", "brand_owner"],
    operator: ["subj-op", "经营公司", "operating_entity"],
    franchisee: ["subj-fr", "加盟商", "franchisee"],
    landlord: ["subj-ll", "房东", "landlord"],
    lessor: ["subj-ls", "租赁公司", "lessor"],
    supplier: ["subj-sp", "供应商", "supplier"],
    neighbor: ["subj-nb", "邻店", "neighbor_store"],
    employees: ["subj-emp", "员工组", "employee_group"],
    customer: ["subj-cu", "顾客甲", "customer"],
  };
  for (const [subject_id, name, kind] of Object.values(kinds)) {
    eng.registerSubject(C, { subject: { subject_id, name, kind }, occurred_at: T("2026-10-01") });
  }
  return { eng, store };
}

test("未公告不能登记事实；公告必须通过渠道发出且只发一次", () => {
  const eng = new ClosureEngine(new EventStore());
  assert.throws(() => eng.registerSubject("case-x", {
    subject: { subject_id: "s1", name: "x", kind: "brand_owner" }, occurred_at: T("2026-10-01"),
  }), ClosureRuleError);
  assert.throws(() => eng.openCase({
    case_id: "case-x", store: { name: "x" }, announced_channels: [], occurred_at: T("2026-10-01"),
  }), /至少通过一个渠道/);
  eng.openCase({ case_id: "case-x", store: { name: "x" }, announced_channels: ["门店公告"], occurred_at: T("2026-10-01") });
  assert.throws(() => eng.openCase({ case_id: "case-x", store: { name: "x" }, announced_channels: ["门店公告"], occurred_at: T("2026-10-01") }), /只能发布一次/);
});

test("储值金与蛋糕定金按资金所在账户分账标记，资金位置非法被拒收", () => {
  const { eng } = freshCase();
  eng.registerClaim(C, { claim_id: "cl-1", customer: { customer_id: "u1" }, claim_kind: "stored_value", amount_minor: 10000, funds_location: "brand_escrow", liable_subject_id: "subj-brand", occurred_at: T("2026-10-02") });
  eng.registerClaim(C, { claim_id: "cl-2", customer: { customer_id: "u2" }, claim_kind: "cake_deposit", amount_minor: 5000, funds_location: "franchisee_private_account", liable_subject_id: "subj-fr", occurred_at: T("2026-10-02") });
  assert.throws(() => eng.registerClaim(C, { claim_id: "cl-3", customer: { customer_id: "u3" }, claim_kind: "stored_value", amount_minor: 1, funds_location: "cash_drawer", liable_subject_id: "subj-brand", occurred_at: T("2026-10-02") }), /未知资金所在位置/);
  const state = project(eng.store.forCase(C));
  assert.equal(state.claims.get("cl-1").funds_location, "brand_escrow");
  assert.equal(state.claims.get("cl-2").funds_location, "franchisee_private_account");
});

test("邻店承接必须取得顾客确认，且邻店必须是已登记的承接门店", () => {
  const { eng } = freshCase();
  eng.registerClaim(C, { claim_id: "cl-1", customer: { customer_id: "u1" }, claim_kind: "prepaid_order", amount_minor: 8000, funds_location: "store_entity_account", liable_subject_id: "subj-op", occurred_at: T("2026-10-02") });
  assert.throws(() => eng.recordCustomerChoice(C, "cl-1", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-nb", customer_confirmed: false, occurred_at: T("2026-10-03") }), /顾客本人明确确认/);
  assert.throws(() => eng.recordCustomerChoice(C, "cl-1", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-sp", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") }), /需要 neighbor_store/);
  eng.recordCustomerChoice(C, "cl-1", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-nb", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  // 已选择后不得重复选择
  assert.throws(() => eng.recordCustomerChoice(C, "cl-1", { choice: "refund", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") }), /不能再登记选择/);
});

test("订单转移校验产能：无申报拒入、占满后拒入，且必须与顾客确认的门店一致", () => {
  const { eng } = freshCase();
  eng.registerClaim(C, { claim_id: "cl-1", customer: { customer_id: "u1" }, claim_kind: "prepaid_order", amount_minor: 8000, funds_location: "store_entity_account", liable_subject_id: "subj-op", occurred_at: T("2026-10-02") });
  eng.registerClaim(C, { claim_id: "cl-2", customer: { customer_id: "u2" }, claim_kind: "prepaid_order", amount_minor: 8000, funds_location: "store_entity_account", liable_subject_id: "subj-op", occurred_at: T("2026-10-02") });
  for (const id of ["cl-1", "cl-2"]) {
    eng.recordCustomerChoice(C, id, { choice: "transfer_to_neighbor", neighbor_store_id: "subj-nb", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  }
  const xfer = (id, storeId = "subj-nb") => eng.transferOrder(C, id, { neighbor_store_id: storeId, service_date: "2026-10-10", product_line: "cake", transfer_order_id: `t-${id}`, customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-04") });
  assert.throws(() => xfer("cl-1", "subj-brand"), /与顾客确认的门店一致/);
  assert.throws(() => xfer("cl-1"), /尚未申报/);
  eng.declareCapacity(C, { neighbor_store_id: "subj-nb", service_date: "2026-10-10", product_line: "cake", slots_total: 1, occurred_at: T("2026-10-02") });
  xfer("cl-1");
  assert.throws(() => xfer("cl-2"), /产能已满/);
  // 邻店重新申报上调产能后，已占用的一单不丢，第二单可以进入
  eng.declareCapacity(C, { neighbor_store_id: "subj-nb", service_date: "2026-10-10", product_line: "cake", slots_total: 2, occurred_at: T("2026-10-03") });
  xfer("cl-2");
});

test("重复通知只吸收一次：会员推送重发、支付回调重放都不新增事件或流水", () => {
  const { eng, store } = freshCase();
  const fields = { claim_id: "cl-1", customer: { customer_id: "u1" }, claim_kind: "cake_deposit", amount_minor: 5000, funds_location: "franchisee_private_account", liable_subject_id: "subj-fr", source_notice_id: "wxp-1", occurred_at: T("2026-10-02") };
  const first = eng.registerClaim(C, fields);
  const second = eng.registerClaim(C, { ...fields, occurred_at: T("2026-10-02T10:00:00+08:00") });
  assert.equal(first.event_id, second.event_id);
  assert.equal(store.forCase(C).filter((e) => e.event_type === "CLAIM_REGISTERED").length, 1);

  eng.enterObligation(C, { obligation_code: "dep-1", category: "cake_deposit_refund", payee: { subject_id: "subj-cu", name: "顾客甲" }, amount_minor: 5000, incurred_at: T("2026-10-02"), claim_id: "cl-1", occurred_at: T("2026-10-03") });
  const pay = { amount_minor: 5000, paid_at: T("2026-10-05"), channel: "原路退回", reference: "r1", source_notice_id: "cb-1" };
  const p1 = eng.settlePayment(C, "dep-1", pay);
  const p2 = eng.settlePayment(C, "dep-1", { ...pay, paid_at: T("2026-10-05T11:00:00+08:00") });
  assert.equal(p1.event_id, p2.event_id);
  const state = project(store.forCase(C));
  assert.equal(state.obligations.get("pay-dep-1").paid_minor, 5000);
  assert.equal(state.obligations.get("pay-dep-1").payments.length, 1);
});

test("付款只追加流水：旧事件不可变，版本连续，超额支付被拒收", () => {
  const { eng, store } = freshCase();
  eng.enterObligation(C, { obligation_code: "w1", category: "employee_wage", payee: { subject_id: "subj-emp", name: "员工组" }, amount_minor: 10000, incurred_at: T("2026-10-01"), occurred_at: T("2026-10-01") });
  eng.settlePayment(C, "w1", { amount_minor: 6000, paid_at: T("2026-10-02"), channel: "专户" });
  assert.throws(() => eng.settlePayment(C, "w1", { amount_minor: 6000, paid_at: T("2026-10-03"), channel: "专户" }), /支付超过未付余额/);
  eng.settlePayment(C, "w1", { amount_minor: 4000, paid_at: T("2026-10-03"), channel: "专户" });
  const stream = store.stream("pay-w1");
  assert.deepEqual(stream.map((e) => e.version), [1, 2, 3]);
  assert.equal(stream[1].payload.amount_minor, 6000, "首笔流水金额不得被后续追加改动");
  assert.equal(stream[2].payload.amount_minor, 4000);
});

test("加盟争议只冻结争议金额：无争议余额可付，其他顾客退款不受牵连", () => {
  const { eng } = freshCase();
  // 顾客甲：蛋糕定金 5000，加盟商对其中 2000 提争议
  eng.registerClaim(C, { claim_id: "cl-a", customer: { customer_id: "ua" }, claim_kind: "cake_deposit", amount_minor: 5000, funds_location: "franchisee_private_account", liable_subject_id: "subj-fr", occurred_at: T("2026-10-02") });
  // 顾客乙：储值金 3000，毫无争议
  eng.registerClaim(C, { claim_id: "cl-b", customer: { customer_id: "ub" }, claim_kind: "stored_value", amount_minor: 3000, funds_location: "brand_escrow", liable_subject_id: "subj-brand", occurred_at: T("2026-10-02") });
  eng.enterObligation(C, { obligation_code: "dep-a", category: "cake_deposit_refund", payee: { subject_id: "subj-cu", name: "顾客甲" }, amount_minor: 5000, incurred_at: T("2026-10-02"), claim_id: "cl-a", occurred_at: T("2026-10-03") });
  eng.registerSubject(C, { subject: { subject_id: "subj-cu2", name: "顾客乙", kind: "customer" }, occurred_at: T("2026-10-01") });
  eng.enterObligation(C, { obligation_code: "ref-b", category: "customer_refund", payee: { subject_id: "subj-cu2", name: "顾客乙" }, amount_minor: 3000, incurred_at: T("2026-10-02"), claim_id: "cl-b", occurred_at: T("2026-10-03") });
  eng.disputeObligation(C, "dep-a", { disputed_by_subject_id: "subj-fr", disputed_amount_minor: 2000, reason: "抵扣主张", occurred_at: T("2026-10-04") });

  const state = () => project(eng.store.forCase(C));
  const n = obligationNumbers(state().obligations.get("pay-dep-a"));
  assert.equal(n.disputed, 2000);
  assert.equal(n.payable, 3000, "无争议的 3000 分仍可支付");
  // 试图把争议金额一并支付——拒收
  assert.throws(() => eng.settlePayment(C, "dep-a", { amount_minor: 5000, paid_at: T("2026-10-05"), channel: "原路" }), /只能支付无争议余额|支付顺序/);
  // 其他顾客的无争议退款照常排在最前支付
  eng.settlePayment(C, "ref-b", { amount_minor: 3000, paid_at: T("2026-10-05"), channel: "原路" });
  // 无争议部分在同顺位义务结清后可付：dep-a 与已付完的 ref-b 同为退款顺位，可付 3000
  eng.settlePayment(C, "dep-a", { amount_minor: 3000, paid_at: T("2026-10-05"), channel: "加盟商账户" });
  const cl = eng.checklist(C);
  assert.ok(cl.awaiting_payment.find((p) => p.obligation_code === "dep-a") === undefined, "无争议余额付清后不再出现在待支付");
  assert.ok(cl.liability_disputes.some((p) => p.obligation_code === "dep-a"));

  // 争议裁定：2000 全部免除
  eng.resolveDispute(C, "dep-a", { resolution: "waive", payable_amount_minor: 0, decided_by: "清算组", occurred_at: T("2026-10-06") });
  const after = obligationNumbers(project(eng.store.forCase(C)).obligations.get("pay-dep-a"));
  assert.equal(after.unpaid, 0);
  assert.equal(after.unresolved_dispute, false);
});

test("支付先后顺序：更高顺位未付时，低顺位款项不得支付", () => {
  const { eng } = freshCase();
  eng.enterObligation(C, { obligation_code: "w1", category: "employee_wage", payee: { subject_id: "subj-emp", name: "员工组" }, amount_minor: 10000, incurred_at: T("2026-10-01"), occurred_at: T("2026-10-01") });
  eng.enterObligation(C, { obligation_code: "sp1", category: "supplier_payable", payee: { subject_id: "subj-sp", name: "供应商" }, amount_minor: 8000, incurred_at: T("2026-10-01"), occurred_at: T("2026-10-01") });
  expectRejected(() => eng.settlePayment(C, "sp1", { amount_minor: 8000, paid_at: T("2026-10-02"), channel: "对公" }), "支付顺序未到");
  eng.settlePayment(C, "w1", { amount_minor: 10000, paid_at: T("2026-10-02"), channel: "专户" });
  eng.settlePayment(C, "sp1", { amount_minor: 8000, paid_at: T("2026-10-02"), channel: "对公" });
});

test("最后班次与房租持续计提：只允许 accruable 义务追加，总额累加旧数不改", () => {
  const { eng } = freshCase();
  eng.enterObligation(C, { obligation_code: "wage", category: "employee_wage", payee: { subject_id: "subj-emp", name: "员工组" }, amount_minor: 200000, accruable: true, incurred_at: T("2026-10-01"), occurred_at: T("2026-10-01") });
  eng.enterObligation(C, { obligation_code: "sev", category: "employee_severance", payee: { subject_id: "subj-emp", name: "员工组" }, amount_minor: 50000, incurred_at: T("2026-10-08"), occurred_at: T("2026-10-05") });
  assert.throws(() => eng.appendAccrual(C, "sev", { period: { from: "2026-10-06", to: "2026-10-08" }, amount_delta_minor: 100, occurred_at: T("2026-10-08") }), /不允许计提/);
  eng.appendAccrual(C, "wage", { period: { from: "2026-10-05", to: "2026-10-08" }, amount_delta_minor: 30000, basis: "收官班次", occurred_at: T("2026-10-08"), source_notice_id: "ats-1" });
  // 考勤系统重发
  eng.appendAccrual(C, "wage", { period: { from: "2026-10-05", to: "2026-10-08" }, amount_delta_minor: 30000, basis: "收官班次", occurred_at: T("2026-10-08T12:00:00+08:00"), source_notice_id: "ats-1" });
  const o = project(eng.store.forCase(C)).obligations.get("pay-wage");
  assert.equal(o.amount_total_minor, 230000);
  assert.equal(o.accruals.length, 1);
});

test("食品安全红线：禁止抵债转卖、过期食品不得调拨或捐赠、销毁须留证", () => {
  const { eng } = freshCase();
  eng.classifyInventory(C, { lots: [
    { lot_id: "f1", name: "鲜奶", category: "food", quantity: 10, unit: "盒", expiry_at: T("2026-10-10"), produced_at: T("2026-10-05"), edible: true },
    { lot_id: "f2", name: "过期面包", category: "food", quantity: 2, unit: "个", expiry_at: T("2026-10-04"), produced_at: T("2026-10-01"), edible: false },
  ], occurred_at: T("2026-10-05") });
  expectRejected(() => eng.disposeInventory(C, { lot_ids: ["f1"], method: "debt_recovery_sale", handled_at: T("2026-10-05"), occurred_at: T("2026-10-05") }), "不允许的处置方式");
  expectRejected(() => eng.disposeInventory(C, { lot_ids: ["f1"], method: "neighbor_transfer", for_debt_setoff: true, handled_at: T("2026-10-05"), neighbor_store_id: "subj-nb", occurred_at: T("2026-10-05") }), "不得用于抵债转卖");
  expectRejected(() => eng.disposeInventory(C, { lot_ids: ["f2"], method: "neighbor_transfer", handled_at: T("2026-10-05"), neighbor_store_id: "subj-nb", occurred_at: T("2026-10-05") }), "已过保质期");
  expectRejected(() => eng.disposeInventory(C, { lot_ids: ["f2"], method: "charity_donation", handled_at: T("2026-10-05"), donee: "社区点", occurred_at: T("2026-10-05") }), "已过保质期");
  expectRejected(() => eng.disposeInventory(C, { lot_ids: ["f2"], method: "safe_destruction", handled_at: T("2026-10-05"), occurred_at: T("2026-10-05") }), "evidence_ref");
  // 同批次不得重复处置
  eng.disposeInventory(C, { lot_ids: ["f1"], method: "charity_donation", handled_at: T("2026-10-05"), donee: "社区食物点", occurred_at: T("2026-10-05") });
  assert.throws(() => eng.disposeInventory(C, { lot_ids: ["f1"], method: "safe_destruction", handled_at: T("2026-10-06"), evidence_ref: "v1", occurred_at: T("2026-10-06") }), /已处置/);
  eng.disposeInventory(C, { lot_ids: ["f2"], method: "safe_destruction", handled_at: T("2026-10-05"), evidence_ref: "vid-9", occurred_at: T("2026-10-05") });
});

test("冷链不断链：仍有未处置食品时租赁冷柜不得归还，重复归还被拒收", () => {
  const { eng } = freshCase();
  eng.classifyInventory(C, { lots: [
    { lot_id: "f1", name: "蛋糕胚", category: "food", quantity: 3, unit: "个", expiry_at: T("2026-10-09"), produced_at: T("2026-10-04"), edible: true },
  ], occurred_at: T("2026-10-05") });
  eng.scheduleAssetReturn(C, { asset: { asset_id: "cold-9", name: "冷柜", refrigerated: true, owner_subject_id: "subj-ls" }, scheduled_at: T("2026-10-07"), handover_location: "店内", occurred_at: T("2026-10-05") });
  expectRejected(() => eng.returnAsset(C, "cold-9", { returned_at: T("2026-10-06"), receiver: "租赁公司", occurred_at: T("2026-10-06") }), "冷链食品未完成处置");
  eng.disposeInventory(C, { lot_ids: ["f1"], method: "safe_destruction", handled_at: T("2026-10-06"), evidence_ref: "v2", occurred_at: T("2026-10-06") });
  eng.returnAsset(C, "cold-9", { returned_at: T("2026-10-07"), receiver: "租赁公司老周", occurred_at: T("2026-10-07") });
  assert.throws(() => eng.returnAsset(C, "cold-9", { returned_at: T("2026-10-08"), receiver: "老周", occurred_at: T("2026-10-08") }), /已归还/);
});

test("未结清单四桶随事实变化：选择、承接、支付、争议各归其位", () => {
  const { eng } = freshCase();
  eng.registerClaim(C, { claim_id: "cl-1", customer: { customer_id: "u1" }, claim_kind: "stored_value", amount_minor: 7000, funds_location: "brand_escrow", liable_subject_id: "subj-brand", occurred_at: T("2026-10-02") });
  eng.registerClaim(C, { claim_id: "cl-2", customer: { customer_id: "u2" }, claim_kind: "prepaid_order", amount_minor: 9000, funds_location: "store_entity_account", liable_subject_id: "subj-op", occurred_at: T("2026-10-02") });
  let cl = eng.checklist(C);
  assert.equal(cl.awaiting_customer_choice.length, 2);

  eng.recordCustomerChoice(C, "cl-1", { choice: "refund", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  eng.enterObligation(C, { obligation_code: "r1", category: "customer_refund", payee: { subject_id: "subj-cu", name: "顾客甲" }, amount_minor: 7000, claim_id: "cl-1", incurred_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  eng.disputeObligation(C, "r1", { disputed_by_subject_id: "subj-brand", disputed_amount_minor: 2000, reason: "余额核对中", occurred_at: T("2026-10-04") });
  cl = eng.checklist(C);
  assert.equal(cl.awaiting_customer_choice.length, 1);
  // 争议 2000 进争议桶，无争议 5000 仍进待支付桶
  const item = cl.awaiting_payment.find((p) => p.obligation_code === "r1");
  assert.equal(item.unpaid_minor, 5000);
  assert.equal(cl.liability_disputes[0].disputed_minor, 2000);

  eng.recordCustomerChoice(C, "cl-2", { choice: "transfer_to_neighbor", neighbor_store_id: "subj-nb", customer_confirmed: true, confirmed_at: T("2026-10-03"), occurred_at: T("2026-10-03") });
  cl = eng.checklist(C);
  assert.ok(cl.awaiting_transfer.some((p) => p.claim_id === "cl-2" && p.capacity_declared === false));
});

test("五道闸门未全通过时禁止最终关闭；完整演练可关闭", () => {
  const { eng } = freshCase();
  // 空案件：订单/食品/员工/供应商等均未交接
  assert.throws(() => eng.closeCase(C, { occurred_at: T("2026-10-09") }), /五道交接闸门/);

  const built = buildScenario();
  const g = built.engine.gates(built.caseId);
  assert.deepEqual(Object.values(g).map((x) => x.passed), [true, true, true, true, true]);
  assert.equal(built.closeEvent.event_type, "CASE_CLOSED");
  // 关闭后不能再追加事实
  assert.throws(() => built.engine.registerSubject(built.caseId, {
    subject: { subject_id: "late", name: "迟到主体", kind: "supplier" }, occurred_at: T("2026-10-10"),
  }), /已最终关闭/);
});

test("JSONL 持久化：重建存储后投影与关闭结论一致，版本流不丢序", () => {
  const dir = mkdtempSync(join(tmpdir(), "closure-"));
  try {
    const file = join(dir, "case.jsonl");
    const a = buildScenario(new EventStore({ file }));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, a.store.forCase(a.caseId).length);

    const rebuilt = new EventStore({ file });
    const eng2 = new ClosureEngine(rebuilt);
    assert.deepEqual(
      Object.values(gates(project(rebuilt.forCase(a.caseId)))).map((x) => x.passed),
      [true, true, true, true, true],
    );
    assert.throws(() => eng2.closeCase(a.caseId, { occurred_at: T("2026-10-09") }), /案件已经关闭/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事件存储直接拒绝跳版本与跨案件混挂", () => {
  const store = new EventStore();
  const base = {
    event_type: "SUBJECT_REGISTERED", aggregate_type: "closure_case", aggregate_id: "case-z",
    case_id: "case-z", occurred_at: T("2026-10-01"), summary: "登记主体", payload: {},
  };
  assert.throws(() => store.append({ ...base, event_id: "evt-z-00000001", version: 2 }), /首事件版本必须是 1/);
  store.append({ ...base, event_id: "evt-z-00000001", version: 1 });
  assert.throws(() => store.append({ ...base, event_id: "evt-z-00000002", version: 3 }), /版本冲突/);
  assert.throws(() => store.append({
    ...base, event_id: "evt-z-00000003", version: 2, case_id: "case-other",
  }), /已属于案件/);
});
