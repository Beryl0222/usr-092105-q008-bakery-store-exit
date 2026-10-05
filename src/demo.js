import { ClosurePlatform } from "./platform.js";
import { GATES, OPEN_BUCKETS, projectCase } from "./projection.js";

/**
 * 端到端走查：麦香时光文三路店退场清算。
 * 运行：node src/demo.js
 *
 * 困局起点：
 *  - 储值金是品牌会员体系，可跨店消费；
 *  - 蛋糕定金进了加盟商王某个人账户；
 *  - 冷柜属于冰源冷链租赁公司；
 *  - 中央工厂还在按未来七天备料；
 *  - 员工最后班次与商场房租每天仍在产生。
 */

let clock = new Date("2026-10-05T09:00:00+08:00");
const advance = (iso) => { clock = new Date(iso); };

const p = new ClosurePlatform({ now: () => clock, idSalt: "wensan" });
const CASE = "case-wensan-001";

const E = {
  brand: "ent-brand",
  franchisee: "ent-franchisee-wang",
  lessor: "ent-coldchain-leasing",
  factory: "ent-central-factory",
  landlord: "ent-mall",
  supplier: "ent-flour-supplier",
  staff: "ent-store-staff",
};

const line = (t = "") => console.log(t);
const h1 = (t) => line(`\n=== ${t} ===`);
const money = (c) => `¥${(c / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`;

function showOpenList(tag) {
  const v = projectCase(CASE, p.store.events, clock);
  line(`\n── 未结清单（${tag}）──`);
  for (const [key, label] of Object.entries(OPEN_BUCKETS)) {
    line(`[${label}] ${v.open_counts[key]} 项`);
  }
  for (const item of v.open_items) line(`  · (${OPEN_BUCKETS[item.bucket]}) ${item.label}`);
  line(
    `专户：已划入 ${v.funds_label.deposited}｜已付 ${v.funds_label.paid_out}｜提存 ${v.funds_label.escrowed}｜可用 ${v.funds_label.available}`
  );
}

function showGates() {
  const v = projectCase(CASE, p.store.events, clock);
  line("\n── 五个交接闸门 ──");
  const name = {
    ORDERS: "订单与顾客权益",
    FOOD: "食品与库存",
    EMPLOYEE_PAY: "员工款项",
    LEASED_ASSETS: "租赁资产",
    SUPPLIER_DEBT: "供应商责任",
  };
  for (const g of GATES) {
    const s = v.gate_status[g];
    line(`  ${s.closed ? "✅" : s.evidenced ? "⚠️ 声明已关但事实未齐" : s.facts_ready ? "🔵 事实已齐，待关闸凭据" : "⬜"} ${name[g]}`);
  }
}

// ── 1. 公告与主体区分 ─────────────────────────────────────────
h1("1. 公告启动，并先区分经营主体与各自权利义务");
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
  entity_id: E.brand, kind: "BRAND", name: "麦香时光品牌管理公司",
  rights: ["会员储值系统余额管理权", "加盟管理权"],
  obligations: ["清算组织与公告责任", "储值金跨店兑付兜底"],
});
p.identifyEntity(CASE, {
  entity_id: E.franchisee, kind: "FRANCHISEE", name: "加盟商王某",
  rights: ["加盟合同项下结算请求权"],
  obligations: ["门店实际经营责任", "已收蛋糕定金退赔责任", "工资房租与货款承担"],
  holds_funds_note: "蛋糕定金由门店收款码直接进入加盟商个人账户",
});
p.identifyEntity(CASE, {
  entity_id: E.lessor, kind: "LEASING_COMPANY", name: "冰源冷链租赁公司",
  rights: ["冷柜等租赁设备所有权", "租金与损坏赔偿请求权"], obligations: ["接收设备、结清押金"],
});
p.identifyEntity(CASE, {
  entity_id: E.factory, kind: "CENTRAL_FACTORY", name: "中央工厂（临平）",
  rights: ["原材料货款请求权"], obligations: ["接收获退回的预生产物料"],
});
p.identifyEntity(CASE, { entity_id: E.landlord, kind: "LANDLORD", name: "文三路商场", rights: ["租金请求权"], obligations: ["提供撤场便利"] });
p.identifyEntity(CASE, { entity_id: E.supplier, kind: "SUPPLIER", name: "丰穗面粉", rights: ["到期货款请求权"], obligations: ["按方案接收未结货款"] });
line("品牌管储值体系；王某收走蛋糕定金；冷柜是租赁公司的；工厂还在备料——四件事四个主体，不混同。");

// ── 2. 邻店产能、持续计提、工厂停料 ───────────────────────────
h1("2. 开放邻店承接产能；工资房租继续计提；通知中央工厂停止七天备料");
p.openTransferAvailability(CASE, {
  store_id: "store-wulin", store_name: "麦香时光武林店", daily_capacity_orders: 3,
  products_supported: ["储值余额", "现烤面包", "裱花蛋糕"], active_from: "2026-10-06T08:00:00+08:00",
});
p.openTransferAvailability(CASE, {
  store_id: "store-genshan", store_name: "麦香时光艮山店", daily_capacity_orders: 5,
  products_supported: ["储值余额", "现烤面包"], active_from: "2026-10-06T08:00:00+08:00",
});
p.recordAccrual(CASE, {
  accrual_id: "ACC-wage-w43", kind: "WAGES", amount_cents: 4200000,
  period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-25T22:00:00+08:00",
  responsible_entity_id: E.franchisee, note: "含公告后最后班次，按实际打卡持续计提",
});
p.recordAccrual(CASE, {
  accrual_id: "ACC-rent-oct", kind: "RENT", amount_cents: 2600000,
  period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-25T22:00:00+08:00",
  responsible_entity_id: E.franchisee, note: "撤场前租金按日继续产生",
});
p.haltCentralFactory(CASE, {
  factory_entity_id: E.factory,
  halt_at: "2026-10-06T00:00:00+08:00",
  seven_day_prep_note: "已按未来 7 天备好的奶油、面团停止调拨，可退回的退回工厂，不可退的计入食品处置",
  returned_batch_ids: ["B-flour-02"],
  cancelled_purchase_order_ids: ["PO-7741", "PO-7742"],
});

// ── 3. 顾客申报：重复通知吸收；选择与默认退款 ─────────────────
h1("3. 顾客申报（多渠道来函只立一案），顾客自主选择");
const li = p.ingestCustomerNotice(CASE, {
  notice_id: "N-1001-门店登记", customer_id: "cust-li", customer_name: "李女士",
  instrument: "STORED_VALUE", amount_cents: 32800, holding_entity_id: E.brand, order_ids: ["ORD-9001"],
});
p.ingestCustomerNotice(CASE, {
  notice_id: "N-1002-客服工单", customer_id: "cust-li", customer_name: "李女士",
  instrument: "STORED_VALUE", amount_cents: 32800, holding_entity_id: E.brand, order_ids: ["ORD-9001"],
}); // 重复通知，被吸收
line(`李女士门店登记 + 客服工单合并为同一笔：${li.claim_id}`);

const zhao = p.ingestCustomerNotice(CASE, {
  notice_id: "N-2001", customer_id: "cust-zhao", customer_name: "赵先生",
  instrument: "CAKE_DEPOSIT", amount_cents: 20000, holding_entity_id: E.franchisee,
});
const sun = p.ingestCustomerNotice(CASE, {
  notice_id: "N-3001", customer_id: "cust-sun", customer_name: "孙女士",
  instrument: "STORED_VALUE", amount_cents: 50000, holding_entity_id: E.brand, order_ids: ["ORD-9002"],
});
const zhou = p.ingestCustomerNotice(CASE, {
  notice_id: "N-4001", customer_id: "cust-zhou", customer_name: "周女士",
  instrument: "PREPAID_ORDER", amount_cents: 15000, holding_entity_id: E.franchisee,
});
line("赵先生 200 元蛋糕定金——钱在加盟商账户；周女士 150 元预订单同样由门店收款。");

p.makeChoice(CASE, li.claim_id, { choice: "TRANSFER", target_store_id: "store-wulin" });
p.confirmTransfer(CASE, li.claim_id, { confirmed_via: "会员小程序二次确认" });
p.transferOrders(CASE, li.claim_id, ["ORD-9001"], { fulfillment_date: "2026-10-08T10:00:00+08:00" });
line("李女士的储值与订单：本人确认 + 武林店产能校验通过，订单已移交。");

p.makeChoice(CASE, sun.claim_id, { choice: "TRANSFER", target_store_id: "store-genshan" });
p.confirmTransfer(CASE, sun.claim_id);
p.transferOrders(CASE, sun.claim_id, ["ORD-9002"], { fulfillment_date: "2026-10-09T15:00:00+08:00" });
line("孙女士的储值订单移交艮山店。");

p.makeChoice(CASE, zhao.claim_id, { choice: "REFUND" });
line("赵先生选择退款——退款义务将记在加盟商王某名下。");

advance("2026-10-21T09:00:00+08:00"); // 选择期已过
p.expireDueChoices(CASE);
line("选择期届满：周女士未表态，按公告默认退款，门店无权替她转给邻店。");
p.approveRefund(CASE, zhao.claim_id);
p.approveRefund(CASE, zhou.claim_id);
showOpenList("顾客选择处理后");

// ── 4. 库存安全处置与租赁设备归还 ─────────────────────────────
h1("4. 库存：食品安全优先；租赁冷柜只归还不变卖");
p.recordInventory(CASE, {
  batch_id: "B-cream-01", kind: "NEAR_EXPIRY_FOOD", name: "临期淡奶油",
  quantity: 40, unit: "升", owner_entity_id: E.franchisee, expiry_at: "2026-10-07T23:59:59+08:00",
});
p.recordInventory(CASE, {
  batch_id: "B-flour-02", kind: "SHELF_STABLE_FOOD", name: "高筋面粉",
  quantity: 220, unit: "公斤", owner_entity_id: E.factory,
});
p.recordInventory(CASE, {
  batch_id: "B-pack-01", kind: "PACKAGING_MATERIAL", name: "品牌包装与定制刀叉",
  quantity: 6, unit: "箱", owner_entity_id: E.franchisee,
});
p.recordInventory(CASE, {
  batch_id: "B-fridge-01", kind: "LEASED_EQUIPMENT", name: "立式风冷展示冷柜",
  quantity: 2, unit: "台", owner_entity_id: E.lessor, asset_tag: "BL-7781/7782",
});

try {
  p.disposeInventory(CASE, "B-cream-01", { method: "折价转卖抵债给供应商", food_safety_confirmed: true });
} catch (e) {
  line(`被拦下：${e.message}`);
}
p.disposeInventory(CASE, "B-cream-01", {
  method: "DONATION", food_safety_confirmed: true, channel: "社区食物银行", witness: "值班店长+社工双签",
});
p.disposeInventory(CASE, "B-flour-02", {
  method: "RETURN_TO_FACTORY", food_safety_confirmed: true, channel: "中央工厂临平仓", witness: "工厂签收单 FT-3320",
});
p.disposeInventory(CASE, "B-pack-01", {
  method: "DESTRUCTION", food_safety_confirmed: true, channel: "有资质销毁单位", witness: "销毁影像留存",
});
line("临期淡奶油捐赠食物银行；面粉退回工厂；包装销毁——没有一批食品被拿去抵债转卖。");

try {
  p.disposeInventory(CASE, "B-fridge-01", { method: "DESTRUCTION", food_safety_confirmed: true });
} catch (e) {
  line(`被拦下：${e.message}`);
}
p.scheduleAssetReturn(CASE, "B-fridge-01", "2026-10-24T14:00:00+08:00");
p.returnAsset(CASE, "B-fridge-01", {
  lessor_confirmed: true, condition_note: "外观完好，运行正常，押金按约结清", handover_proof: "签收单 BL-RCV-0091",
});
line("两台冷柜按约归还冰源冷链，租赁公司签收确认。");

// ── 5. 款项登记、资金归集、争议与冻结边界 ─────────────────────
h1("5. 登记款项与清算顺位，归集资金；加盟争议不得冻结无争议余额");
p.registerAccrualObligation(CASE, { accrual_id: "ACC-wage-w43", payee_entity_id: E.staff, payee_name: "门店员工（8 人）", obligation_id: "obl-wage-01" });
p.registerAccrualObligation(CASE, { accrual_id: "ACC-rent-oct", payee_entity_id: E.landlord, payee_name: "文三路商场", obligation_id: "obl-rent-01" });
p.registerObligation(CASE, {
  obligation_id: "obl-util-01", category: "UTILITY", payee_entity_id: E.landlord, payee_name: "商场物业",
  amount_cents: 80000, responsible_entity_id: E.franchisee,
});
p.registerObligation(CASE, {
  obligation_id: "obl-sup-01", category: "SUPPLIER", payee_entity_id: E.supplier, payee_name: "丰穗面粉",
  amount_cents: 1500000, responsible_entity_id: E.franchisee,
});
p.registerObligation(CASE, {
  obligation_id: "obl-fra-01", category: "FRANCHISEE_SETTLEMENT", payee_entity_id: E.franchisee, payee_name: "加盟商王某",
  amount_cents: 1200000, responsible_entity_id: E.brand,
});
p.depositFunds(CASE, 6000000, E.brand, "品牌储值兑付兜底与加盟结算资金");
p.depositFunds(CASE, 9000000, E.franchisee, "加盟商承担的定金退款、工资、房租、水电、货款");

// 供应商就 7 天备料损失 60 万提出争议
p.fileDispute(CASE, {
  dispute_id: "DSP-factory-prep",
  between_entity_ids: [E.franchisee, E.supplier],
  subject: "中央工厂 7 天备料损失 60 万由谁承担",
  disputed_amount_cents: 600000,
  obligation_ids: ["obl-sup-01"],
});
p.escrowDisputed(CASE, "DSP-factory-prep", "杭州市公证处监管账户");
line("供应商争议的 60 万按额提存公证账户；其余 90 万无争议货款照常支付。");

// 加盟商试图借加盟争议冻结整个专户
p.fileDispute(CASE, {
  dispute_id: "DSP-franchise-exit",
  between_entity_ids: [E.brand, E.franchisee],
  subject: "提前解约装修补偿争议",
  disputed_amount_cents: 800000,
  obligation_ids: ["obl-fra-01"],
});
try {
  p.requestFreeze(CASE, { requested_by_entity_id: E.franchisee, requested_amount_cents: 12000000 });
} catch (e) {
  line(`超范围冻结被拒：${e.message}`);
}
p.escrowDisputed(CASE, "DSP-franchise-exit", "杭州市公证处监管账户");
line("加盟争议的 80 万同样只按额提存；顾客退款、员工工资、房租一分未被冻结。");
showOpenList("争议提存后");

// ── 6. 按瀑布付款 ────────────────────────────────────────────
h1("6. 清算瀑布：顾客退款 → 工资 → 房租水电 → 供应商 → 加盟结算");
const v0 = projectCase(CASE, p.store.events, clock);
const refundZhao = [...v0.obligations.values()].find((o) => o.ref_id === zhao.claim_id).obligation_id;
const refundZhou = [...v0.obligations.values()].find((o) => o.ref_id === zhou.claim_id).obligation_id;
p.settle(CASE, refundZhao, 20000);
p.settle(CASE, refundZhou, 15000);
p.closeClaim(CASE, zhao.claim_id);
p.closeClaim(CASE, zhou.claim_id);
line("第一顺位：蛋糕定金 200 元（加盟商承担）、预订单 150 元退款到账，顾客权益结案。");

const wageObl = [...projectCase(CASE, p.store.events, clock).obligations.values()].find((o) => o.category === "WAGES").obligation_id;
p.settle(CASE, wageObl, 4200000);
line("第二顺位：8 名员工含最后班次工资 42,000 元足额代发。");

p.settle(CASE, "obl-rent-01", 2600000);
p.settle(CASE, "obl-util-01", 80000);
line("第三顺位：商场房租 26,000 元、水电物业 800 元结清。");

p.settle(CASE, "obl-sup-01", 900000);
line("第四顺位：丰穗面粉无争议货款 9,000 元支付；争议 6,000 元在公证账户。");

// 争议认定：备料损失由加盟商承担，提存解付
p.resolveDispute(CASE, {
  dispute_id: "DSP-factory-prep", resolution: "FRANCHISEE_BEARS", resolution_amount_cents: 600000,
});
p.settle(CASE, "obl-sup-01", 600000, { method: "公证提存解付", from_escrow: true });
line("备料损失争议认定由加盟商承担，提存 6,000 元解付给供应商，供应商责任结清。");
p.acknowledgeSupplierPlan(CASE, ["obl-sup-01"], "货款已全额结清，无后续争议");

p.settle(CASE, "obl-fra-01", 400000);
line("第五顺位：加盟结算款无争议部分 4,000 元支付；争议 8,000 元留公证账户待裁断，不拖累关店。");

showOpenList("全部款项处理后");

// ── 7. 闸门与最终关闭 ────────────────────────────────────────
h1("7. 五个交接闸门逐项关闸，最终关闭");
showGates();
for (const [gate, proof] of [
  ["ORDERS", "2 笔转移订单邻店履约完成，2 笔退款到账，全部顾客权益结案"],
  ["FOOD", "淡奶油捐赠、面粉退厂、包装销毁，工厂停料并签收退料"],
  ["EMPLOYEE_PAY", "工资流水与签收名册齐备"],
  ["LEASED_ASSETS", "冷柜两台归还，租赁公司签收单 BL-RCV-0091"],
  ["SUPPLIER_DEBT", "无争议货款付清，争议经认定并由提存解付，供应商书面确认"],
]) {
  p.closeGate(CASE, gate, proof);
  line(`关闸：${gate} —— ${proof}`);
}
showGates();

try {
  p.closeCase(CASE);
  line("✅ 案件进入最终关闭状态（加盟装修补偿争议 8,000 元已公证提存，另行裁断，不影响关店）。");
} catch (e) {
  line(`无法关闭：${e.message}`);
}

// ── 8. 审计轨迹：流水只追加 ──────────────────────────────────
h1("8. 清算专户流水（只追加，红冲也另起一条）");
const vf = projectCase(CASE, p.store.events, clock);
for (const e of p.store.events.filter((e) => e.aggregate_id === `pay::${CASE}` && e.payload.entry_seq)) {
  const p2 = e.payload;
  const kind = { PAYMENT_SETTLED: "支付", PAYMENT_REVERSED: "红冲", AMOUNT_ESCROWED: "提存" }[e.event_type];
  line(`  #${String(p2.entry_seq).padStart(3, "0")} ${kind} ${money(p2.amount_cents)}  ${e.summary.replace(/^流水 #\d+：/, "")}`);
}
line(`\n事件总数 ${p.store.events.length} 条，全部只追加；案件状态：${vf.status}，关闭时间 ${vf.closed_at}`);
