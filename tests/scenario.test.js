import assert from "node:assert/strict";
import test from "node:test";

import { ClosurePlatform, DomainError } from "../src/platform.js";
import { projectCase } from "../src/projection.js";

const CASE = "case-wensan-001";
const ENT = {
  brand: "ent-brand",
  franchisee: "ent-franchisee-wang",
  lessorEquip: "ent-coldchain-leasing",
  factory: "ent-central-factory",
  landlord: "ent-mall",
  supplier: "ent-flour-supplier",
  staffPool: "ent-store-staff",
};

/** 搭出一个真实困局案件主体，返回平台与各业务编号。 */
function setupCase(p) {
  p.announceClosure(CASE, {
    store_name: "麦香时光文三路店",
    store_address: "杭州市文三路 88 号",
    brand_name: "麦香时光",
    notice_channels: ["门店公告", "公众号", "会员短信", "商场告示栏"],
    choice_deadline: "2026-10-20T23:59:59+08:00",
    planned_close_date: "2026-10-25T22:00:00+08:00",
    refund_policy: "选择期内可选择邻店承接或原价退款；逾期未选择按退款处理",
  });
  p.identifyEntity(CASE, {
    entity_id: ENT.brand, kind: "BRAND", name: "麦香时光品牌管理公司",
    rights: ["会员储值系统余额管理权", "品牌加盟管理权"],
    obligations: ["公告与清算组织责任", "储值金跨店兑付兜底"],
  });
  p.identifyEntity(CASE, {
    entity_id: ENT.franchisee, kind: "FRANCHISEE", name: "加盟商王某（文三路店）",
    rights: ["加盟合同项下结算请求权"],
    obligations: ["门店实际经营责任", "已收取蛋糕定金的退赔责任"],
    holds_funds_note: "蛋糕定金由门店收款码直接进入加盟商个人账户",
  });
  p.identifyEntity(CASE, {
    entity_id: ENT.lessorEquip, kind: "LEASING_COMPANY", name: "冰源冷链租赁公司",
    rights: ["冷柜等租赁设备所有权", "租金与损坏赔偿请求权"],
    obligations: ["接收归还设备并结清押金"],
  });
  p.identifyEntity(CASE, {
    entity_id: ENT.factory, kind: "CENTRAL_FACTORY", name: "中央工厂（临平）",
    rights: ["原材料货款请求权"],
    obligations: ["接收获退回的预生产物料"],
  });
  p.identifyEntity(CASE, { entity_id: ENT.landlord, kind: "LANDLORD", name: "文三路商场", rights: ["租金请求权"], obligations: ["提供撤场便利"] });
  p.identifyEntity(CASE, { entity_id: ENT.supplier, kind: "SUPPLIER", name: "丰穗面粉供应商", rights: ["到期货款请求权"], obligations: ["按方案接收未结货款"] });
  return CASE;
}

function expectError(fn, codeIncludes) {
  try {
    fn();
    assert.fail("应当抛出业务错误");
  } catch (e) {
    assert.ok(e instanceof DomainError, `期望 DomainError，实际 ${e.constructor.name}: ${e.message}`);
    if (codeIncludes) assert.ok(e.code.includes(codeIncludes) || e.message.includes(codeIncludes), `错误 ${e.code} 不符合预期片段 ${codeIncludes}`);
  }
}

test("先区分经营主体：蛋糕定金的实际持有人是加盟商而非品牌", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.entities.get(ENT.franchisee).holds_funds_note.includes("加盟商个人账户"), true);
  assert.equal(v.entities.get(ENT.lessorEquip).rights.some((r) => r.includes("所有权")), true);
});

test("公告期与顾客选择截止时间随公告确定", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.announced.choice_deadline, "2026-10-20T23:59:59+08:00");
  assert.deepEqual(v.open_counts, {
    WAITING_CUSTOMER_CHOICE: 0,
    WAITING_TRANSFER: 0,
    PENDING_PAYMENT: 0,
    RESPONSIBILITY_DISPUTE: 0,
  });
});

test("同一顾客多渠道重复通知被吸收，不重复立案", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  const a = p.ingestCustomerNotice(CASE, {
    notice_id: "N-1001", customer_id: "cust-li", customer_name: "李女士", contact: "138****0001",
    instrument: "STORED_VALUE", amount_cents: 32800, holding_entity_id: ENT.brand,
  });
  const b = p.ingestCustomerNotice(CASE, {
    notice_id: "N-1002", customer_id: "cust-li", customer_name: "李女士", contact: "138****0001",
    instrument: "STORED_VALUE", amount_cents: 32800, holding_entity_id: ENT.brand,
  });
  const c = p.ingestCustomerNotice(CASE, {
    notice_id: "N-1001", customer_id: "cust-li", customer_name: "李女士",
    instrument: "STORED_VALUE", amount_cents: 32800, holding_entity_id: ENT.brand,
  }); // 同一 notice_id 重发
  assert.equal(a.merged, false);
  assert.equal(b.merged, true);
  assert.equal(b.claim_id, a.claim_id);
  assert.equal(c.merged, true);
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.claims.size, 1);
  assert.deepEqual(v.claims.get(a.claim_id).merged_notices, ["N-1002"]);
});

test("储值金可跨店：邻店承接必须顾客确认且校验产能", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  p.openTransferAvailability(CASE, {
    store_id: "store-wulin", store_name: "麦香时光武林店",
    daily_capacity_orders: 1, products_supported: ["储值余额", "现烤面包"], active_from: "2026-10-06T08:00:00+08:00",
  });
  const { claim_id } = p.ingestCustomerNotice(CASE, {
    notice_id: "N-2001", customer_id: "cust-zhao", customer_name: "赵先生",
    instrument: "STORED_VALUE", amount_cents: 50000, holding_entity_id: ENT.brand, order_ids: ["ORD-9001"],
  });
  p.makeChoice(CASE, claim_id, { choice: "TRANSFER", target_store_id: "store-wulin" });
  // 未确认直接转移订单：拒绝
  expectError(() => p.transferOrders(CASE, claim_id, ["ORD-9001"]), "NOT_CONFIRMED");
  p.confirmTransfer(CASE, claim_id);

  // 第二单超过产能：拒绝
  const c2 = p.ingestCustomerNotice(CASE, {
    notice_id: "N-2002", customer_id: "cust-sun", customer_name: "孙女士",
    instrument: "STORED_VALUE", amount_cents: 12000, holding_entity_id: ENT.brand,
  });
  p.makeChoice(CASE, c2.claim_id, { choice: "TRANSFER", target_store_id: "store-wulin" });
  expectError(() => p.confirmTransfer(CASE, c2.claim_id), "CAPACITY_EXCEEDED");

  // 第一单完成实际履约后结案
  p.transferOrders(CASE, claim_id, ["ORD-9001"], { fulfillment_date: "2026-10-08T10:00:00+08:00" });
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.claims.get(claim_id).closed, true);
  assert.equal(v.transferStores.get("store-wulin").reserved_orders, 1);
});

test("未在选择期表态的顾客按公告默认退款，门店不得替其选择转移", () => {
  let now = new Date("2026-10-10T09:00:00+08:00");
  const p = new ClosurePlatform({ now: () => now });
  setupCase(p);
  const { claim_id } = p.ingestCustomerNotice(CASE, {
    notice_id: "N-3001", customer_id: "cust-zhou", customer_name: "周女士",
    instrument: "STORED_VALUE", amount_cents: 8800, holding_entity_id: ENT.brand,
  });
  now = new Date("2026-10-21T09:00:00+08:00"); // 已过截止
  p.expireDueChoices(CASE);
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.claims.get(claim_id).status, "CHOICE_EXPIRED_REFUND");
  // 逾期后再选转移：拒绝
  expectError(() => p.makeChoice(CASE, claim_id, { choice: "TRANSFER", target_store_id: "store-x" }), "CHOICE_DEADLINE_PASSED");
});

test("蛋糕定金退款义务挂在加盟商名下，品牌储值退款由品牌兜底", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  const cake = p.ingestCustomerNotice(CASE, {
    notice_id: "N-4001", customer_id: "cust-wu", customer_name: "吴女士",
    instrument: "CAKE_DEPOSIT", amount_cents: 20000, holding_entity_id: ENT.franchisee,
  });
  const stored = p.ingestCustomerNotice(CASE, {
    notice_id: "N-4002", customer_id: "cust-zheng", customer_name: "郑先生",
    instrument: "STORED_VALUE", amount_cents: 15000, holding_entity_id: ENT.brand,
  });
  p.makeChoice(CASE, cake.claim_id, { choice: "REFUND" });
  p.makeChoice(CASE, stored.claim_id, { choice: "REFUND" });
  p.approveRefund(CASE, cake.claim_id);
  p.approveRefund(CASE, stored.claim_id);
  const v = projectCase(CASE, p.store.events);
  const cakeObl = [...v.obligations.values()].find((o) => o.ref_id === cake.claim_id);
  const storedObl = [...v.obligations.values()].find((o) => o.ref_id === stored.claim_id);
  assert.equal(cakeObl.responsible_entity_id, ENT.franchisee);
  assert.equal(storedObl.responsible_entity_id, ENT.brand);
  assert.equal(cakeObl.priority, 1);
});

test("租赁冷柜不属于门店：处置请求被拒绝并留痕，只能约归还且需租赁公司签收", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  p.recordInventory(CASE, {
    batch_id: "B-fridge-01", kind: "LEASED_EQUIPMENT", name: "立式风冷展示冷柜",
    quantity: 2, unit: "台", owner_entity_id: ENT.lessorEquip, asset_tag: "BL-7781/7782",
  });
  expectError(() => p.disposeInventory(CASE, "B-fridge-01", {
    method: "DESTRUCTION", food_safety_confirmed: true,
  }), "LEASED_ASSET_NOT_DISPOSABLE");
  p.scheduleAssetReturn(CASE, "B-fridge-01", "2026-10-24T14:00:00+08:00");
  expectError(() => p.returnAsset(CASE, "B-fridge-01", {
    lessor_confirmed: false, condition_note: "门店自称完好",
  }), "LESSOR_NOT_CONFIRMED");
  p.returnAsset(CASE, "B-fridge-01", {
    lessor_confirmed: true, condition_note: "外观完好，运行正常", handover_proof: "签收单 BL-RCV-0091",
  });
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.batches.get("B-fridge-01").status, "RETURNED");
  assert.ok(v.batches.get("B-fridge-01").rejection);
});

test("临期食品不得为抵债转卖，只能走安全处置渠道并确认食品安全", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  p.recordInventory(CASE, {
    batch_id: "B-food-01", kind: "NEAR_EXPIRY_FOOD", name: "鲜奶吐司",
    quantity: 60, unit: "袋", owner_entity_id: ENT.franchisee, expiry_at: "2026-10-06T23:59:59+08:00",
  });
  expectError(() => p.disposeInventory(CASE, "B-food-01", {
    method: "折价转卖抵债", food_safety_confirmed: true, channel: "供应商自行拉走",
  }), "FOOD_SALE_FOR_DEBT_FORBIDDEN");
  expectError(() => p.disposeInventory(CASE, "B-food-01", {
    method: "DONATION", food_safety_confirmed: false, channel: "社区食物银行",
  }), "FOOD_SAFETY_UNCONFIRMED");
  p.disposeInventory(CASE, "B-food-01", {
    method: "DONATION", food_safety_confirmed: true, channel: "社区食物银行", witness: "值班店长+社工",
  });
  const v = projectCase(CASE, p.store.events);
  assert.equal(v.batches.get("B-food-01").status, "DISPOSED");
});

test("工资与房租持续计提：最后班次工资成为第二顺位义务", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  p.recordAccrual(CASE, {
    accrual_id: "ACC-wage-w42", kind: "WAGES", amount_cents: 4200000,
    period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-25T22:00:00+08:00",
    responsible_entity_id: ENT.franchisee, note: "含公告后最后班次",
  });
  p.registerAccrualObligation(CASE, { accrual_id: "ACC-wage-w42", payee_entity_id: ENT.staffPool, payee_name: "门店员工（8人）" });
  const v = projectCase(CASE, p.store.events);
  const obl = [...v.obligations.values()].find((o) => o.ref_id === "ACC-wage-w42");
  assert.equal(obl.category, "WAGES");
  assert.equal(obl.priority, 2);
});

test("付款瀑布：退款与工资未付时，房租与供应商不得插队支付", () => {
  const p = fundedCase();
  const ids = p._ids;
  expectError(() => p.settle(CASE, ids.rent, 10000), "WATERFALL_ORDER");
  expectError(() => p.settle(CASE, ids.supplier, 10000), "WATERFALL_ORDER");
});

test("加盟争议不能冻结无争议余额：超范围冻结被拒且留痕", () => {
  const p = fundedCase();
  const ids = p._ids;
  // 加盟商就加盟结算款中的 8000 元提出争议，却要求冻结专户 120000 元
  p.fileDispute(CASE, {
    dispute_id: "DSP-01", between_entity_ids: [ENT.brand, ENT.franchisee],
    subject: "加盟合同提前解约的装修补偿与定金归属争议",
    disputed_amount_cents: 800000, obligation_ids: [ids.franchiseeSettle],
  });
  expectError(() => p.requestFreeze(CASE, { requested_by_entity_id: ENT.franchisee, requested_amount_cents: 12000000 }), "FREEZE_OVERREACH_REJECTED");
  const v = projectCase(CASE, p.store.events);
  assert.ok(v.overreachFreeze);
  // 无争议的顾客退款、员工工资照常支付（按瀑布顺序）
  assert.doesNotThrow(() => p.settle(CASE, ids.refundA, 20000));
  assert.doesNotThrow(() => p.settle(CASE, ids.refundB, 30000));
  assert.doesNotThrow(() => p.settle(CASE, ids.wages, 4200000));
  const v2 = projectCase(CASE, p.store.events);
  // 争议款项的无争议部分仍可付
  assert.equal(v2.obligations.get(ids.franchiseeSettle).disputed_cents, 800000);
});

test("争议部分只能按额提存，提存后不阻塞无争议清算与门店关闭", () => {
  const p = fundedCase();
  const ids = p._ids;
  p.fileDispute(CASE, {
    dispute_id: "DSP-02", between_entity_ids: [ENT.brand, ENT.franchisee],
    subject: "7 天备料损失分担争议", disputed_amount_cents: 600000, obligation_ids: [ids.supplier],
  });
  p.escrowDisputed(CASE, "DSP-02", "杭州市公证处监管账户");
  const v = projectCase(CASE, p.store.events);
  // 未结清单不再出现该争议项
  assert.equal(v.open_items.some((i) => i.bucket === "RESPONSIBILITY_DISPUTE"), false);
  assert.equal(v.funds.escrowed_cents, 600000);
  // 供应商无争议部分照付（其闸门也可凭分期方案关闭）
  assert.equal(v.obligations.get(ids.supplier).amount_cents - v.obligations.get(ids.supplier).disputed_cents, 900000);
});

test("付款只追加流水：错付红冲不改旧记录，余额由流水派生", () => {
  const p = fundedCase();
  const ids = p._ids;
  p.settle(CASE, ids.refundA, 20000);
  p.reversePayment(CASE, 1, "收款人信息有误，退回重付");
  const v = projectCase(CASE, p.store.events);
  const seqTypes = p.store.events
    .filter((e) => e.aggregate_id === `pay::${CASE}`)
    .map((e) => [e.event_type, e.payload.entry_seq]);
  assert.deepEqual(seqTypes.filter(([t]) => t === "PAYMENT_SETTLED").length, 1);
  assert.deepEqual(seqTypes.filter(([t]) => t === "PAYMENT_REVERSED").length, 1);
  assert.equal(v.obligations.get(ids.refundA).paid_cents, 0);
  // 重新支付仍是新流水号
  const again = p.settle(CASE, ids.refundA, 20000);
  assert.equal(again.payload.entry_seq, 3);
});

test("五个闸门未全部齐备时无法关闭，且不能凭声明跳过事实", () => {
  const p = fundedCase();
  expectError(() => p.closeGate(CASE, "ORDERS", "口头说都处理完了"), "GATE_FACTS_NOT_READY");
  expectError(() => p.closeCase(CASE), "GATES_PENDING");
});

test("同一 event_id 重试内容不一致被拒绝，一致时幂等吸收", () => {
  const p = new ClosurePlatform();
  setupCase(p);
  const { event } = p.ingestCustomerNotice(CASE, {
    notice_id: "N-9001", customer_id: "cust-x", customer_name: "某顾客",
    instrument: "STORED_VALUE", amount_cents: 100, holding_entity_id: ENT.brand,
  });
  assert.doesNotThrow(() => p.store.append({ ...event }));
  const tampered = { ...event, summary: "被篡改的摘要" };
  expectError(() => p.store.append(tampered), "EVENT_ID_CONFLICT");
});

/** 构造一个带资金、款项与争议前置数据的案件。 */
function fundedCase() {
  const p = new ClosurePlatform();
  setupCase(p);
  // 两笔顾客退款：定金（加盟商）+ 储值（品牌）
  const a = p.ingestCustomerNotice(CASE, {
    notice_id: "N-5001", customer_id: "cust-a", customer_name: "顾客甲",
    instrument: "CAKE_DEPOSIT", amount_cents: 20000, holding_entity_id: ENT.franchisee,
  });
  const b = p.ingestCustomerNotice(CASE, {
    notice_id: "N-5002", customer_id: "cust-b", customer_name: "顾客乙",
    instrument: "STORED_VALUE", amount_cents: 30000, holding_entity_id: ENT.brand,
  });
  p.makeChoice(CASE, a.claim_id, { choice: "REFUND" });
  p.makeChoice(CASE, b.claim_id, { choice: "REFUND" });
  p.approveRefund(CASE, a.claim_id);
  p.approveRefund(CASE, b.claim_id);
  const v0 = projectCase(CASE, p.store.events);
  const refundA = [...v0.obligations.values()].find((o) => o.ref_id === a.claim_id).obligation_id;
  const refundB = [...v0.obligations.values()].find((o) => o.ref_id === b.claim_id).obligation_id;

  p.recordAccrual(CASE, {
    accrual_id: "ACC-w1", kind: "WAGES", amount_cents: 4200000,
    period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-25T22:00:00+08:00",
    responsible_entity_id: ENT.franchisee,
  });
  p.registerAccrualObligation(CASE, { accrual_id: "ACC-w1", payee_entity_id: ENT.staffPool, payee_name: "门店员工" });
  p.registerObligation(CASE, {
    obligation_id: "obl-rent-01", category: "RENT", payee_entity_id: ENT.landlord, payee_name: "文三路商场",
    amount_cents: 2600000, responsible_entity_id: ENT.franchisee,
  });
  p.registerObligation(CASE, {
    obligation_id: "obl-sup-01", category: "SUPPLIER", payee_entity_id: ENT.supplier, payee_name: "丰穗面粉",
    amount_cents: 1500000, responsible_entity_id: ENT.franchisee,
  });
  p.registerObligation(CASE, {
    obligation_id: "obl-fra-01", category: "FRANCHISEE_SETTLEMENT", payee_entity_id: ENT.franchisee, payee_name: "加盟商王某",
    amount_cents: 1200000, responsible_entity_id: ENT.brand,
  });
  // 责任方把钱划入清算专户（品牌+加盟商各自承担）
  p.depositFunds(CASE, 10000000, ENT.brand, "品牌储值兑付与清算兜底资金");
  p.depositFunds(CASE, 9000000, ENT.franchisee, "加盟商应承担的定金、工资、房租与货款");

  const v1 = projectCase(CASE, p.store.events);
  const wages = [...v1.obligations.values()].find((o) => o.category === "WAGES").obligation_id;
  p._ids = {
    refundA, refundB, wages,
    rent: "obl-rent-01", supplier: "obl-sup-01", franchiseeSettle: "obl-fra-01",
    claimA: a.claim_id, claimB: b.claim_id,
  };
  return p;
}
