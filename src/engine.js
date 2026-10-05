// 清算领域引擎：把品牌退场负责人面对的真实约束变成命令前置守卫。
// 引擎不保存可变状态——状态全部由 EventStore 中只追加的事件投影得到；
// 每条命令通过校验后构造事件并追加，付款只能追加流水，旧记录永不修改。

import { deriveEventId, EventStore } from "./event-store.js";
import {
  allGatesPassed,
  checklist as projectChecklist,
  gates as projectGates,
  obligationNumbers,
  project,
} from "./projection.js";

export class ClosureRuleError extends Error {}

const SUBJECT_KINDS = new Set([
  "brand_owner",
  "operating_entity",
  "franchisee",
  "central_kitchen",
  "landlord",
  "lessor",
  "supplier",
  "neighbor_store",
  "employee_group",
  "customer",
  "payment_platform",
]);

const CLAIM_KINDS = new Set(["stored_value", "cake_deposit", "prepaid_order"]);
const FUND_LOCATIONS = new Set(["store_entity_account", "franchisee_private_account", "brand_escrow"]);

const PAY_CATEGORIES = new Set([
  "customer_refund",
  "cake_deposit_refund",
  "employee_wage",
  "employee_severance",
  "rent",
  "lease_fee",
  "supplier_payable",
  "franchise_claim",
  "asset_damage",
]);

// 支付先后顺序（数字越小顺位越优先）：
// 顾客退款 → 员工工资/补偿 → 房租 → 租赁费用 → 供应商货款 → 加盟争议等剩余请求。
const PAYMENT_PRIORITY = [
  { rank: 1, categories: new Set(["customer_refund", "cake_deposit_refund"]) },
  { rank: 2, categories: new Set(["employee_wage", "employee_severance"]) },
  { rank: 3, categories: new Set(["rent"]) },
  { rank: 4, categories: new Set(["lease_fee"]) },
  { rank: 5, categories: new Set(["supplier_payable"]) },
  { rank: 6, categories: new Set(["franchise_claim", "asset_damage"]) },
];

const FOOD_DISPOSAL_METHODS = new Set([
  "neighbor_transfer",
  "charity_donation",
  "safe_destruction",
  "supplier_return",
]);

function rankOf(category) {
  return PAYMENT_PRIORITY.find((r) => r.categories.has(category))?.rank ?? 99;
}

function requireIntCents(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new ClosureRuleError(`${label} 必须是非负整数（人民币分）`);
}

export class ClosureEngine {
  /** @param {EventStore} store */
  constructor(store = new EventStore()) {
    this.store = store;
  }

  #state(caseId) {
    return project(this.store.forCase(caseId));
  }

  /** 外部通知若已吸收（来源系统重试/重复推送），直接返回既有事件，不再走业务守卫。 */
  #absorbedNotice(caseId, sourceNoticeId) {
    return sourceNoticeId ? this.store.findNotice(caseId, sourceNoticeId) : null;
  }

  #requireOpenCase(state) {
    if (!state.announced) throw new ClosureRuleError("案件尚未发布闭店公告，不能登记后续事实");
    if (state.closed) throw new ClosureRuleError("案件已最终关闭，只能查询，不能再追加事实");
  }

  #requireSubject(state, subjectId, expectedKind) {
    const s = state.subjects.get(subjectId);
    if (!s) throw new ClosureRuleError(`主体 ${subjectId} 尚未登记，请先区分经营主体与权利义务`);
    if (expectedKind && s.kind !== expectedKind) {
      throw new ClosureRuleError(`主体 ${subjectId} 类型是 ${s.kind}，需要 ${expectedKind}`);
    }
    return s;
  }

  #append(caseId, { eventType, aggregateType, aggregateId, summary, payload, occurredAt, sourceNoticeId, noticePrefix }) {
    if (Number.isNaN(Date.parse(occurredAt))) throw new ClosureRuleError("occurred_at 时间不可解析");
    const version = (this.store.aggregates.get(aggregateId)?.version ?? 0) + 1;
    const eventId = sourceNoticeId
      ? deriveEventId(noticePrefix ?? eventType.toLowerCase(), caseId, sourceNoticeId)
      : `evt-${caseId}-${aggregateId}-v${version}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const event = {
      event_id: eventId,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      case_id: caseId,
      occurred_at: occurredAt,
      version,
      summary,
      payload,
    };
    if (sourceNoticeId) event.source_notice_id = sourceNoticeId;
    const result = this.store.append(event);
    return result.event;
  }

  // —— 案件与主体 -------------------------------------------------------

  openCase({ case_id, store, announced_channels, last_business_day, central_kitchen, occurred_at, source_notice_id }) {
    const absorbed = this.#absorbedNotice(case_id, source_notice_id);
    if (absorbed) return absorbed;
    const state = this.#state(case_id);
    if (state.announced) throw new ClosureRuleError("案件公告只能发布一次");
    if (!Array.isArray(announced_channels) || announced_channels.length === 0) {
      throw new ClosureRuleError("闭店公告必须至少通过一个渠道发出（门店公告/公众号/会员短信等）");
    }
    return this.#append(case_id, {
      eventType: "CLOSURE_ANNOUNCED",
      aggregateType: "closure_case",
      aggregateId: case_id,
      summary: `${store?.name ?? "门店"}公告闭店清算`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "announce",
      payload: { store, announced_channels, last_business_day, central_kitchen },
    });
  }

  registerSubject(caseId, { subject, rights = [], obligations = [], occurred_at }) {
    const state = this.#state(caseId);
    this.#requireOpenCase(state);
    if (!subject?.subject_id || !subject?.name) throw new ClosureRuleError("主体必须有 subject_id 与 name");
    if (!SUBJECT_KINDS.has(subject.kind)) throw new ClosureRuleError(`未知主体类型：${subject.kind}`);
    if (state.subjects.has(subject.subject_id)) throw new ClosureRuleError(`主体 ${subject.subject_id} 已登记，不得重复登记`);
    return this.#append(caseId, {
      eventType: "SUBJECT_REGISTERED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      summary: `登记主体：${subject.name}（${subject.kind}）`,
      occurredAt: occurred_at,
      payload: { subject, rights, obligations },
    });
  }

  // —— 顾客权益：登记、选择、承接、放弃 ----------------------------------

  registerClaim(caseId, fields) {
    const {
      claim_id,
      customer,
      claim_kind,
      amount_minor,
      funds_location,
      liable_subject_id,
      source_channel,
      occurred_at,
      source_notice_id,
    } = fields;
    const state = this.#state(caseId);
    this.#requireOpenCase(state);
    if (state.claims.has(claim_id)) {
      const absorbed = this.#absorbedNotice(caseId, source_notice_id);
      if (absorbed) return absorbed;
      throw new ClosureRuleError(`权益单 ${claim_id} 已登记`);
    }
    if (!CLAIM_KINDS.has(claim_kind)) throw new ClosureRuleError(`未知权益类型：${claim_kind}`);
    if (!FUND_LOCATIONS.has(funds_location)) throw new ClosureRuleError(`未知资金所在位置：${funds_location}`);
    requireIntCents(amount_minor, "权益金额");
    this.#requireSubject(state, liable_subject_id);
    if (!customer?.customer_id) throw new ClosureRuleError("顾客必须有 customer_id");
    return this.#append(caseId, {
      eventType: "CLAIM_REGISTERED",
      aggregateType: "customer_claim",
      aggregateId: claim_id,
      summary: `登记顾客权益：${claim_kind}，${amount_minor} 分，资金在 ${funds_location}`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "claim",
      payload: { customer, claim_kind, amount_minor, currency: "CNY", funds_location, liable_subject_id, source_channel },
    });
  }

  recordCustomerChoice(caseId, claimId, fields) {
    const { choice, neighbor_store_id, customer_confirmed, confirmed_at, occurred_at, source_notice_id } = fields;
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const claim = state.claims.get(claimId);
    if (!claim) throw new ClosureRuleError(`权益单 ${claimId} 不存在`);
    if (claim.status !== "registered") throw new ClosureRuleError(`权益单 ${claimId} 当前状态 ${claim.status}，不能再登记选择`);
    if (!["transfer_to_neighbor", "refund", "waive"].includes(choice)) throw new ClosureRuleError("选择只能是承接、退款或放弃");
    if (customer_confirmed !== true || !confirmed_at) {
      throw new ClosureRuleError("必须取得顾客本人明确确认及确认时间，邻店和品牌方均不得代选");
    }
    if (choice === "transfer_to_neighbor") {
      if (!neighbor_store_id) throw new ClosureRuleError("选择邻店承接必须指定邻店");
      this.#requireSubject(state, neighbor_store_id, "neighbor_store");
    }
    return this.#append(caseId, {
      eventType: "CUSTOMER_CHOICE_RECORDED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      summary: `顾客选择：${choice === "transfer_to_neighbor" ? `转邻店 ${neighbor_store_id}` : choice === "refund" ? "退款" : "放弃"}`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "choice",
      payload: { choice, neighbor_store_id: neighbor_store_id ?? null, customer_confirmed, confirmed_at },
    });
  }

  declareCapacity(caseId, { neighbor_store_id, service_date, product_line, slots_total, occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    this.#requireSubject(state, neighbor_store_id, "neighbor_store");
    if (!Number.isInteger(slots_total) || slots_total < 0) throw new ClosureRuleError("承接产能必须是非负整数");
    if (!service_date || !product_line) throw new ClosureRuleError("产能申报必须指定服务日期与品类");
    return this.#append(caseId, {
      eventType: "TRANSFER_CAPACITY_DECLARED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      summary: `邻店 ${neighbor_store_id} 于 ${service_date} 承接 ${product_line} 的产能 ${slots_total} 单`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "cap",
      payload: { neighbor_store_id, service_date, product_line, slots_total },
    });
  }

  #capacityState(state, neighborStoreId, serviceDate, productLine) {
    const key = `${neighborStoreId}|${serviceDate}|${productLine}`;
    const declared = state.capacities.get(key);
    const occupied = state.occupancy.get(key) ?? 0;
    return { key, declared, occupied };
  }

  transferOrder(caseId, claimId, fields) {
    const {
      neighbor_store_id,
      service_date,
      product_line,
      transfer_order_id,
      customer_confirmed,
      confirmed_at,
      occurred_at,
      source_notice_id,
    } = fields;
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const claim = state.claims.get(claimId);
    if (!claim) throw new ClosureRuleError(`权益单 ${claimId} 不存在`);
    if (claim.status !== "choice_transfer") {
      throw new ClosureRuleError("只有顾客已确认选择邻店承接的权益单才能执行订单转移");
    }
    if (claim.choice.neighbor_store_id !== neighbor_store_id) {
      throw new ClosureRuleError("承接门店必须与顾客确认的门店一致");
    }
    if (customer_confirmed !== true || !confirmed_at) throw new ClosureRuleError("转移执行仍须携带顾客确认凭据");
    const cap = this.#capacityState(state, neighbor_store_id, service_date, product_line);
    if (!cap.declared) throw new ClosureRuleError(`邻店 ${neighbor_store_id} 尚未申报 ${service_date} ${product_line} 的产能，不能转入`);
    if (cap.occupied >= cap.declared.slots_total) {
      throw new ClosureRuleError(`邻店 ${neighbor_store_id} ${service_date} ${product_line} 产能已满（${cap.occupied}/${cap.declared.slots_total}），必须改约或请顾客重新选择`);
    }
    return this.#append(caseId, {
      eventType: "ORDER_TRANSFERRED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      summary: `订单转入邻店 ${neighbor_store_id}（${service_date} ${product_line}）`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "xfer",
      payload: {
        neighbor_store_id,
        service_date,
        product_line,
        transfer_order_id,
        customer_confirmed,
        confirmed_at,
        capacity: {
          slots_before: cap.occupied,
          slots_after: cap.occupied + 1,
          slots_total: cap.declared.slots_total,
          within_capacity: true,
        },
      },
    });
  }

  waiveClaim(caseId, claimId, { customer_confirmed, reason, occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    this.#requireOpenCase(state);
    const claim = state.claims.get(claimId);
    if (!claim) throw new ClosureRuleError(`权益单 ${claimId} 不存在`);
    if (claim.status !== "registered") throw new ClosureRuleError("只有待选择的权益单可以由顾客放弃");
    if (customer_confirmed !== true) throw new ClosureRuleError("放弃权益必须由顾客本人确认");
    this.#append(caseId, {
      eventType: "CUSTOMER_CHOICE_RECORDED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      summary: "顾客确认放弃权益",
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "choice",
      payload: { choice: "waive", customer_confirmed, reason: reason ?? null },
    });
    return this.#append(caseId, {
      eventType: "CLAIM_WAIVED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      summary: "权益单经顾客确认放弃，关闭",
      occurredAt: occurred_at,
      noticePrefix: "waive",
      payload: { customer_confirmed, reason: reason ?? null },
    });
  }

  // —— 食品与物料：分类、安全处置 ---------------------------------------

  classifyInventory(caseId, { lots, occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    if (!Array.isArray(lots) || lots.length === 0) throw new ClosureRuleError("至少登记一个批次");
    for (const lot of lots) {
      if (!lot.lot_id || !lot.name) throw new ClosureRuleError("批次必须有 lot_id 与 name");
      if (state.lots.has(lot.lot_id)) throw new ClosureRuleError(`批次 ${lot.lot_id} 已登记，不得重复入账`);
      if (!["food", "material", "packaging"].includes(lot.category)) throw new ClosureRuleError(`批次 ${lot.lot_id} 类别非法`);
      if (lot.category === "food") {
        if (!lot.expiry_at || Number.isNaN(Date.parse(lot.expiry_at))) throw new ClosureRuleError(`食品批次 ${lot.lot_id} 必须登记保质期`);
      }
    }
    return this.#append(caseId, {
      eventType: "INVENTORY_CLASSIFIED",
      aggregateType: "inventory_disposition",
      aggregateId: `disp-${caseId}`,
      summary: `登记 ${lots.length} 个库存批次（含中央工厂已备的未来七天物料）`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "classify",
      payload: { lots },
    });
  }

  disposeInventory(caseId, fields) {
    const { lot_ids, method, handled_at, evidence_ref, neighbor_store_id, donee, for_debt_setoff, occurred_at, source_notice_id } = fields;
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    if (!Array.isArray(lot_ids) || lot_ids.length === 0) throw new ClosureRuleError("处置必须指定批次");
    const lots = lot_ids.map((id) => {
      const lot = state.lots.get(id);
      if (!lot) throw new ClosureRuleError(`批次 ${id} 未登记，不能处置`);
      if (state.disposedLots.has(id)) throw new ClosureRuleError(`批次 ${id} 已处置，不能重复处置（更正请追加新批次与新事件）`);
      return lot;
    });
    // 红线：临期食品不得为抵债而转卖。
    if (for_debt_setoff === true) {
      throw new ClosureRuleError("库存（尤其临期食品）不得用于抵债转卖；处置款不得指定给任何债权人");
    }
    if (method === "debt_recovery_sale" || !FOOD_DISPOSAL_METHODS.has(method)) {
      throw new ClosureRuleError(`不允许的处置方式：${method}。食品只能邻店调拨/慈善捐赠/安全销毁/依约退货`);
    }
    const foodLots = lots.filter((l) => l.category === "food");
    if (method === "neighbor_transfer") {
      if (!neighbor_store_id) throw new ClosureRuleError("邻店调拨必须指定接收邻店");
      this.#requireSubject(state, neighbor_store_id, "neighbor_store");
      for (const lot of foodLots) {
        if (Date.parse(lot.expiry_at) <= Date.parse(handled_at)) {
          throw new ClosureRuleError(`食品批次 ${lot.lot_id} 已过保质期，不得调拨销售，只能安全销毁或依约处理`);
        }
      }
    }
    if (method === "charity_donation") {
      if (!donee) throw new ClosureRuleError("慈善捐赠必须登记受赠方");
      for (const lot of foodLots) {
        if (Date.parse(lot.expiry_at) <= Date.parse(handled_at)) {
          throw new ClosureRuleError(`食品批次 ${lot.lot_id} 已过保质期，不得捐赠`);
        }
      }
    }
    if (method === "safe_destruction" && !evidence_ref) {
      throw new ClosureRuleError("安全销毁必须留存影像或凭证 evidence_ref");
    }
    return this.#append(caseId, {
      eventType: "INVENTORY_DISPOSED",
      aggregateType: "inventory_disposition",
      aggregateId: `disp-${caseId}`,
      summary: `${lots.length} 个批次以 ${method} 方式完成处置`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "dispose",
      payload: { lot_ids, method, handled_at, evidence_ref: evidence_ref ?? null, neighbor_store_id: neighbor_store_id ?? null, donee: donee ?? null },
    });
  }

  // —— 租赁资产：排期、归还（冷链不断链） --------------------------------

  scheduleAssetReturn(caseId, fields) {
    const { asset, scheduled_at, handover_location, occurred_at } = fields;
    const state = this.#state(caseId);
    this.#requireOpenCase(state);
    if (!asset?.asset_id || !asset.name) throw new ClosureRuleError("租赁资产必须有 asset_id 与 name");
    this.#requireSubject(state, asset.owner_subject_id, "lessor");
    const aggregateId = `asset-${asset.asset_id}`;
    const existing = state.assets.get(aggregateId);
    if (existing?.returned) throw new ClosureRuleError(`资产 ${asset.asset_id} 已归还，排期终止`);
    return this.#append(caseId, {
      eventType: "LEASED_ASSET_RETURN_SCHEDULED",
      aggregateType: "inventory_disposition",
      aggregateId,
      summary: `租赁资产 ${asset.name} 排期 ${scheduled_at} 归还`,
      occurredAt: occurred_at,
      payload: { asset, scheduled_at, handover_location },
    });
  }

  returnAsset(caseId, assetId, { returned_at, condition, receiver, remark, occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const aggregateId = `asset-${assetId}`;
    const asset = state.assets.get(aggregateId);
    if (!asset?.scheduled) throw new ClosureRuleError(`资产 ${assetId} 尚未排期归还，不能直接交接`);
    if (asset.returned) throw new ClosureRuleError(`资产 ${assetId} 已归还，重复交接被拒收`);
    if (asset.refrigerated) {
      const openColdFood = [...state.lots.values()].some(
        (l) => l.category === "food" && !state.disposedLots.has(l.lot_id),
      );
      if (openColdFood) {
        throw new ClosureRuleError("店内仍有冷链食品未完成处置，归还冷柜会造成断链，请先处置食品");
      }
    }
    if (!receiver) throw new ClosureRuleError("归还必须记录接收人");
    return this.#append(caseId, {
      eventType: "LEASED_ASSET_RETURNED",
      aggregateType: "inventory_disposition",
      aggregateId,
      summary: `租赁资产 ${asset.name} 已归还 ${receiver}`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "asset-return",
      payload: { returned_at, condition: condition ?? null, receiver, remark: remark ?? null },
    });
  }

  // —— 款项：义务登记、持续计提、争议、支付（只追加流水） ------------------

  enterObligation(caseId, fields) {
    const {
      obligation_code,
      category,
      payee,
      amount_minor,
      incurred_at,
      accruable = false,
      payroll_final = false,
      claim_id = null,
      occurred_at,
      source_notice_id,
    } = fields;
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    if (!obligation_code) throw new ClosureRuleError("义务必须有 obligation_code");
    if (!PAY_CATEGORIES.has(category)) throw new ClosureRuleError(`未知款项类别：${category}`);
    requireIntCents(amount_minor, "义务金额");
    this.#requireSubject(state, payee?.subject_id);
    const aggregateId = `pay-${obligation_code}`;
    if (state.obligations.has(aggregateId)) throw new ClosureRuleError(`义务 ${obligation_code} 已登记`);
    if (claim_id) {
      const claim = state.claims.get(claim_id);
      if (!claim) throw new ClosureRuleError(`关联权益单 ${claim_id} 不存在`);
      if (category === "customer_refund" && claim.claim_kind !== "stored_value") {
        throw new ClosureRuleError("customer_refund 只能对应储值金权益；蛋糕定金退款使用 cake_deposit_refund");
      }
      if (category === "cake_deposit_refund" && claim.claim_kind !== "cake_deposit") {
        throw new ClosureRuleError("cake_deposit_refund 只能对应蛋糕定金权益");
      }
    }
    return this.#append(caseId, {
      eventType: "PAYMENT_OBLIGATION_ENTERED",
      aggregateType: "settlement_payment",
      aggregateId,
      summary: `登记应付款：${category}，收款人 ${payee.name}，${amount_minor} 分`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "oblig",
      payload: {
        obligation_code,
        category,
        payee,
        amount_minor,
        currency: "CNY",
        incurred_at,
        accruable,
        payroll_final,
        claim_id,
      },
    });
  }

  appendAccrual(caseId, obligationCode, { period, amount_delta_minor, basis, occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const o = state.obligations.get(`pay-${obligationCode}`);
    if (!o) throw new ClosureRuleError(`义务 ${obligationCode} 不存在`);
    if (!o.accruable) throw new ClosureRuleError(`义务 ${obligationCode} 不允许计提；最后班次工资与按日房租须在登记时标 accruable`);
    if (!Number.isInteger(amount_delta_minor) || amount_delta_minor <= 0) {
      throw new ClosureRuleError("计提金额必须是正整数（分）；追加流水而非改动旧金额");
    }
    if (!period?.from || !period?.to) throw new ClosureRuleError("计提必须带起止期间");
    return this.#append(caseId, {
      eventType: "ACCRUAL_APPENDED",
      aggregateType: "settlement_payment",
      aggregateId: `pay-${obligationCode}`,
      summary: `${o.category} 追加计提 ${amount_delta_minor} 分（${period.from} 至 ${period.to}）`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "accrual",
      payload: { period, amount_delta_minor, basis: basis ?? null },
    });
  }

  disputeObligation(caseId, obligationCode, { disputed_by_subject_id, disputed_amount_minor, reason, evidence_notice_ids = [], occurred_at, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const o = state.obligations.get(`pay-${obligationCode}`);
    if (!o) throw new ClosureRuleError(`义务 ${obligationCode} 不存在`);
    this.#requireSubject(state, disputed_by_subject_id);
    const n = obligationNumbers(o);
    if (n.unresolved_dispute) throw new ClosureRuleError("该义务已有未决争议，请先解决再追加新争议");
    if (!Number.isInteger(disputed_amount_minor) || disputed_amount_minor <= 0) throw new ClosureRuleError("争议金额必须是正整数");
    if (disputed_amount_minor > n.total - n.paid) {
      throw new ClosureRuleError("争议金额不能超过该义务尚未支付的金额");
    }
    if (!reason) throw new ClosureRuleError("争议必须说明理由");
    return this.#append(caseId, {
      eventType: "OBLIGATION_DISPUTED",
      aggregateType: "settlement_payment",
      aggregateId: `pay-${obligationCode}`,
      summary: `${o.category} 发生责任争议 ${disputed_amount_minor} 分，仅冻结争议金额`,
      occurredAt: occurred_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "dispute",
      payload: { disputed_by_subject_id, disputed_amount_minor, reason, evidence_notice_ids },
    });
  }

  resolveDispute(caseId, obligationCode, { resolution, payable_amount_minor, decided_by, note, occurred_at }) {
    const state = this.#state(caseId);
    this.#requireOpenCase(state);
    const o = state.obligations.get(`pay-${obligationCode}`);
    if (!o) throw new ClosureRuleError(`义务 ${obligationCode} 不存在`);
    const n = obligationNumbers(o);
    if (!n.unresolved_dispute) throw new ClosureRuleError("该义务没有未决争议");
    if (!["pay", "waive", "partial"].includes(resolution)) throw new ClosureRuleError("裁定结果只能是 pay/waive/partial");
    requireIntCents(payable_amount_minor, "裁定应付金额");
    if (resolution === "waive" && payable_amount_minor !== 0) throw new ClosureRuleError("裁定免除时应付金额必须为 0");
    if (resolution === "pay" && payable_amount_minor !== o.dispute.disputed_amount_minor) {
      throw new ClosureRuleError("裁定全额支付时应付金额必须等于争议金额");
    }
    if (resolution === "partial" && (payable_amount_minor <= 0 || payable_amount_minor >= o.dispute.disputed_amount_minor)) {
      throw new ClosureRuleError("部分支付裁定价必须在 0 与争议金额之间");
    }
    return this.#append(caseId, {
      eventType: "DISPUTE_RESOLVED",
      aggregateType: "settlement_payment",
      aggregateId: `pay-${obligationCode}`,
      summary: `争议裁定：${resolution}，应付 ${payable_amount_minor} 分`,
      occurredAt: occurred_at,
      payload: { resolution, payable_amount_minor, decided_by, note: note ?? null },
    });
  }

  settlePayment(caseId, obligationCode, { amount_minor, paid_at, channel, reference, source_notice_id }) {
    const state = this.#state(caseId);
    const absorbed = this.#absorbedNotice(caseId, source_notice_id);
    if (absorbed) return absorbed;
    this.#requireOpenCase(state);
    const o = state.obligations.get(`pay-${obligationCode}`);
    if (!o) throw new ClosureRuleError(`义务 ${obligationCode} 不存在`);
    if (!Number.isInteger(amount_minor) || amount_minor <= 0) throw new ClosureRuleError("支付金额必须是正整数");
    const n = obligationNumbers(o);
    if (n.unresolved_dispute && amount_minor > n.payable - n.paid) {
      throw new ClosureRuleError("存在未决争议：只能支付无争议余额，争议金额不得提前支付");
    }
    if (amount_minor > n.unpaid) throw new ClosureRuleError(`支付超过未付余额（未付 ${n.unpaid} 分），拒收`);

    // 先后顺序：存在更高顺位的未付无争议义务时，低顺位款项不得支付。
    const myRank = rankOf(o.category);
    const blockers = [];
    for (const other of state.obligations.values()) {
      if (other.pay_id === o.pay_id || rankOf(other.category) >= myRank) continue;
      const on = obligationNumbers(other);
      if (on.unpaid > 0) blockers.push({ obligation_code: other.code, category: other.category, unpaid_minor: on.unpaid });
    }
    if (blockers.length) {
      throw new ClosureRuleError(
        `支付顺序未到 ${o.category}：仍有更高顺位未付款 ${blockers.map((b) => `${b.obligation_code}(${b.category})`).join("、")}`,
      );
    }
    return this.#append(caseId, {
      eventType: "PAYMENT_SETTLED",
      aggregateType: "settlement_payment",
      aggregateId: `pay-${obligationCode}`,
      summary: `支付 ${o.category} ${amount_minor} 分（追加流水，不改旧记录）`,
      occurredAt: paid_at,
      sourceNoticeId: source_notice_id,
      noticePrefix: "pay",
      payload: { amount_minor, paid_at, channel, reference: reference ?? null },
    });
  }

  // —— 读取投影与最终关闭 -----------------------------------------------

  checklist(caseId) {
    return projectChecklist(this.#state(caseId));
  }

  gates(caseId) {
    return projectGates(this.#state(caseId));
  }

  closeCase(caseId, { occurred_at }) {
    const state = this.#state(caseId);
    if (!state.announced) throw new ClosureRuleError("未公告的案件不能关闭");
    if (state.closed) throw new ClosureRuleError("案件已经关闭");

    const gateResult = projectGates(state);
    if (!allGatesPassed(state)) {
      throw new ClosureRuleError(`五道交接闸门未全部通过：${JSON.stringify(gateResult, null, 0)}`);
    }
    // 五道名状闸门之外，房租、租赁费用等一切无争议款项也必须结清，争议必须有结论。
    const financial = [];
    for (const o of state.obligations.values()) {
      const n = obligationNumbers(o);
      if (n.unpaid > 0 || n.unresolved_dispute) {
        financial.push({ obligation_code: o.code, category: o.category, unpaid_minor: n.unpaid, unresolved_dispute: n.unresolved_dispute });
      }
    }
    if (financial.length) throw new ClosureRuleError(`仍有未结清款项或未决争议：${JSON.stringify(financial)}`);

    return this.#append(caseId, {
      eventType: "CASE_CLOSED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      summary: "五道交接闸门全部通过，款项与争议结清，门店最终关闭",
      occurredAt: occurred_at,
      payload: { gates: Object.fromEntries(Object.entries(gateResult).map(([k, v]) => [k, v.passed])), financial_clear: true },
    });
  }
}
