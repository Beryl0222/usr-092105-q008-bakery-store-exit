import { DomainError, EventStore } from "./event-store.js";
import { GATES, projectCase } from "./projection.js";

export { DomainError };

const CATEGORY_BY_ACCRUAL = { WAGES: "WAGES", RENT: "RENT", UTILITY: "UTILITY", OTHER: "OTHER" };
const PRIORITY_BY_CATEGORY = {
  REFUND: 1,
  WAGES: 2,
  RENT: 3,
  UTILITY: 3,
  SUPPLIER: 4,
  FRANCHISEE_SETTLEMENT: 5,
  OTHER: 5,
};
/** 临期食品允许的安全处置方式：任何"卖了抵债"都不在其中。 */
const SAFE_FOOD_METHODS = new Set(["DONATION", "EMPLOYEE_SAFE_USE", "DESTRUCTION", "RETURN_TO_FACTORY"]);
const SALE_PATTERN = /售|卖|转售|变卖|抵债|折价出售/i;

/**
 * 门店关闭清算平台。
 * 全部业务动作都以事件落到 EventStore：命令可以重放，事实不可改写，
 * 付款只追加 PAYMENT_SETTLED / PAYMENT_REVERSED 流水。
 */
export class ClosurePlatform {
  constructor({ now = () => new Date(), idSalt = "x" } = {}) {
    this.store = new EventStore();
    this._now = now;
    this._salt = idSalt;
    this._seq = 0;
  }

  _tick() {
    this._seq += 1;
    return String(this._seq).padStart(4, "0");
  }

  _append({ type, aggregateType, aggregateId, payload = {}, summary, eventId, sourceNotices }) {
    const eid = eventId ?? `evt-${this._salt}-${this._tick()}`;
    const event = {
      event_id: eid,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this._now().toISOString(),
      version: this.store.nextVersion(aggregateId),
      summary,
      payload,
    };
    if (sourceNotices?.length) event.source_notice_ids = sourceNotices;
    this.store.append(event);
    return event;
  }

  _case(caseId) {
    return projectCase(caseId, this.store.events, this._now());
  }

  // ---------- 案件、主体与持续发生的费用 ----------

  announceClosure(caseId, { store_name, store_address, brand_name, notice_channels, choice_deadline, planned_close_date, refund_policy }) {
    return this._append({
      type: "CLOSURE_ANNOUNCED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: { store_name, store_address, brand_name, notice_channels, choice_deadline, planned_close_date, refund_policy },
      summary: `${store_name} 启动退场清算，已在${notice_channels.join("、")}公告，顾客选择截止 ${choice_deadline}`,
    });
  }

  identifyEntity(caseId, entity) {
    return this._append({
      type: "LEGAL_ENTITY_IDENTIFIED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: entity,
      summary: `区分经营主体：${entity.name}（${entity.kind}）`,
    });
  }

  /** 员工最后班次、房租等在关闭期间仍持续产生，按期计提并锁定承担主体。 */
  recordAccrual(caseId, accrual) {
    return this._append({
      type: "ACCRUAL_RECORDED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: accrual,
      summary: `计提 ${accrual.period_from} 至 ${accrual.period_to} 的${accrual.kind === "WAGES" ? "员工班次工资" : accrual.kind.toLowerCase()}`,
    });
  }

  openTransferAvailability(caseId, store) {
    return this._append({
      type: "TRANSFER_AVAILABILITY_OPENED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: store,
      summary: `邻店 ${store.store_name} 开放承接，每日余量 ${store.daily_capacity_orders} 单`,
    });
  }

  haltCentralFactory(caseId, payload) {
    return this._append({
      type: "CENTRAL_FACTORY_HALT_ACKNOWLEDGED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload,
      summary: `中央工厂确认自 ${payload.halt_at} 停止为关闭门店备料`,
    });
  }

  // ---------- 顾客申报：重复通知被吸收，而不是重复立案 ----------

  /**
   * 接收任一渠道（门店登记、客服工单、商场转告、加盟商名单）的顾客通知。
   * 同一顾客同一凭证金额的再来函并入既有 claim，只记一条 CLAIM_NOTICE_MERGED。
   */
  ingestCustomerNotice(caseId, notice) {
    if (this.store.hasNotice(caseId, notice.notice_id)) {
      return { merged: true, event: this.store.noticeEvent(caseId, notice.notice_id) };
    }
    const view = this._case(caseId);
    const existing = [...view.claims.values()].find(
      (c) => c.customer_id === notice.customer_id && c.instrument === notice.instrument && c.amount_cents === notice.amount_cents
    );
    if (existing) {
      const ev = this._append({
        type: "CLAIM_NOTICE_MERGED",
        aggregateType: "customer_claim",
        aggregateId: existing.claim_id,
        payload: { merged_into_claim_id: existing.claim_id, notice_id: notice.notice_id },
        summary: `顾客 ${notice.customer_name} 的重复通知（${notice.notice_id}）并入 ${existing.claim_id}`,
      });
      return { merged: true, event: ev, claim_id: existing.claim_id };
    }
    const claimId = `claim-${caseId}-${String(view.claims.size + 1).padStart(3, "0")}`;
    const ev = this._append({
      type: "CLAIM_REGISTERED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: {
        case_id: caseId,
        customer_id: notice.customer_id,
        customer_name: notice.customer_name,
        contact: notice.contact,
        instrument: notice.instrument,
        amount_cents: notice.amount_cents,
        holding_entity_id: notice.holding_entity_id,
        order_ids: notice.order_ids ?? [],
        notice_id: notice.notice_id,
      },
      summary: `登记顾客 ${notice.customer_name} 的${labelInstrument(notice.instrument)} ${cents(notice.amount_cents)}，资金持有方 ${notice.holding_entity_id}`,
    });
    return { merged: false, event: ev, claim_id: claimId };
  }

  makeChoice(caseId, claimId, { choice, target_store_id }) {
    const view = this._case(caseId);
    const claim = view.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `未找到顾客权益记录 ${claimId}`);
    if (claim.closed) throw new DomainError("CLAIM_CLOSED_ALREADY", `${claimId} 已结案，不能再变更选择`);
    if (new Date(this._now()) > new Date(view.announced.choice_deadline)) {
      throw new DomainError("CHOICE_DEADLINE_PASSED", "选择期已过，未选择的权益按公告默认退款处理");
    }
    if (choice === "TRANSFER" && !target_store_id) throw new DomainError("TARGET_STORE_REQUIRED", "选择跨店承接必须指定邻店");
    if (choice === "TRANSFER" && !view.transferStores.has(target_store_id)) {
      throw new DomainError("STORE_NOT_AVAILABLE", "目标门店不在可承接名单内");
    }
    return this._append({
      type: "CLAIM_CHOICE_MADE",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: { choice, target_store_id, chosen_at: this._now().toISOString() },
      summary: `${claim.customer_name} 选择${choice === "TRANSFER" ? `由 ${target_store_id} 承接` : "退款"}`,
    });
  }

  /** 公告选择期结束：未选择者一律按退款，不允许门店替顾客默认转给邻店。 */
  expireDueChoices(caseId) {
    const view = this._case(caseId);
    const out = [];
    for (const claim of view.claims.values()) {
      if (claim.status !== "REGISTERED") continue;
      if (new Date(view.announced.choice_deadline) >= new Date(this._now())) continue;
      out.push(
        this._append({
          type: "CLAIM_CHOICE_EXPIRED",
          aggregateType: "customer_claim",
          aggregateId: claim.claim_id,
          payload: { default_choice: "REFUND" },
          summary: `${claim.customer_name} 选择期届满未表态，按公告默认退款`,
        })
      );
    }
    return out;
  }

  /** 邻店承接：必须顾客本人确认，且邻店当日仍有产能。 */
  confirmTransfer(caseId, claimId, { confirmed_via = "门店扫码确认" } = {}) {
    const view = this._case(caseId);
    const claim = view.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `未找到 ${claimId}`);
    if (claim.choice !== "TRANSFER") throw new DomainError("NOT_TRANSFER_CHOICE", "顾客未选择跨店承接，禁止擅自转移订单");
    const store = view.transferStores.get(claim.target_store_id);
    if (!store) throw new DomainError("STORE_NOT_AVAILABLE", "目标邻店未开放承接");
    if (store.capacity_remaining_orders <= 0) {
      throw new DomainError("CAPACITY_EXCEEDED", `${store.store_name} 当日承接产能已满（${store.daily_capacity_orders} 单），不能再接收`);
    }
    return this._append({
      type: "CLAIM_TRANSFER_CONFIRMED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: {
        target_store_id: store.store_id,
        customer_confirmed: true,
        capacity_remaining_orders: store.capacity_remaining_orders - 1,
        confirmed_via,
      },
      summary: `${claim.customer_name} 确认由 ${store.store_name} 承接，校验后邻店剩余产能 ${store.capacity_remaining_orders - 1} 单`,
    });
  }

  transferOrders(caseId, claimId, orderIds, { fulfillment_date } = {}) {
    const view = this._case(caseId);
    const claim = view.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `未找到 ${claimId}`);
    if (claim.status !== "TRANSFER_CONFIRMED") throw new DomainError("NOT_CONFIRMED", "订单转移前必须取得顾客确认并通过产能校验");
    const known = new Set(claim.order_ids);
    const unknown = orderIds.filter((id) => !known.has(id));
    if (unknown.length) throw new DomainError("ORDER_NOT_IN_CLAIM", `订单不属于该顾客：${unknown.join("、")}`);
    return this._append({
      type: "ORDER_TRANSFERRED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: { target_store_id: claim.target_store_id, order_ids: orderIds, fulfillment_date },
      summary: `${claim.customer_name} 的 ${orderIds.length} 笔订单移交 ${claim.target_store_id}`,
    });
  }

  /** 核定退款：付款义务挂在实际持有资金的主体名下（如加盟商收走的蛋糕定金）。 */
  approveRefund(caseId, claimId) {
    const view = this._case(caseId);
    const claim = view.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `未找到 ${claimId}`);
    if (claim.choice !== "REFUND") throw new DomainError("NOT_REFUND_CHOICE", "只有选择退款（含默认退款）的权益才能核定退款");
    if (claim.refund_obligation_id) throw new DomainError("REFUND_ALREADY_APPROVED", "退款义务已核定，重复申请应并入既有记录");
    const obligationId = `obl-refund-${String(view.obligations.size + 1).padStart(3, "0")}`;
    this._append({
      type: "OBLIGATION_REGISTERED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: {
        obligation_id: obligationId,
        category: "REFUND",
        payee_entity_id: claim.customer_id,
        payee_name: claim.customer_name,
        amount_cents: claim.amount_cents,
        priority: 1,
        responsible_entity_id: claim.holding_entity_id,
        ref_id: claimId,
      },
      summary: `核定 ${claim.customer_name} 退款 ${cents(claim.amount_cents)}，最终承担主体 ${claim.holding_entity_id}`,
    });
    return this._append({
      type: "REFUND_APPROVED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: { obligation_id: obligationId, amount_cents: claim.amount_cents },
      summary: `${claim.customer_name} 的退款已核定，进入清算瀑布第一顺位`,
    });
  }

  /** 退款流水到账后结案；未付清不得关闭顾客权益。 */
  closeClaim(caseId, claimId) {
    const view = this._case(caseId);
    const claim = view.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND", `未找到 ${claimId}`);
    if (claim.closed) throw new DomainError("CLAIM_CLOSED_ALREADY", `${claimId} 已结案`);
    if (claim.choice === "REFUND") {
      const obl = view.obligations.get(claim.refund_obligation_id);
      if (!obl || obl.paid_cents < obl.amount_cents) {
        throw new DomainError("REFUND_NOT_PAID", `${claim.customer_name} 的退款尚未付清，不能结案`);
      }
    }
    return this._append({
      type: "CLAIM_CLOSED",
      aggregateType: "customer_claim",
      aggregateId: claimId,
      payload: {},
      summary: `${claim.customer_name} 的顾客权益已全部交接完成`,
    });
  }

  // ---------- 库存与租赁资产 ----------
  recordInventory(caseId, batch) {
    return this._append({
      type: "INVENTORY_RECORDED",
      aggregateType: "inventory_disposition",
      aggregateId: `inv::${caseId}`,
      payload: batch,
      summary: `登记批次 ${batch.batch_id}（${batch.kind}），所有权归属 ${batch.owner_entity_id}`,
    });
  }

  /**
   * 安全处置。
   * - 租赁设备不属于门店，任何处置都拒绝并留痕；
   * - 临期食品只能捐赠/员工安全食用/销毁/退回工厂，禁止为抵债转卖；
   * - 食品处置必须确认食品安全。
   */
  disposeInventory(caseId, batchId, { method, food_safety_confirmed, channel, witness }) {
    const view = this._case(caseId);
    const batch = view.batches.get(batchId);
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", `未找到批次 ${batchId}`);
    if (batch.kind === "LEASED_EQUIPMENT") {
      const reason = `${batch.name ?? "租赁设备"} 所有权属于 ${batch.owner_entity_id}，门店无权处置，只能约归还`;
      this._append({
        type: "DISPOSITION_RULE_VIOLATION_REJECTED",
        aggregateType: "inventory_disposition",
        aggregateId: `inv::${caseId}`,
        payload: { batch_id: batchId, attempted_method: method, reason },
        summary: `拒绝处置租赁资产：${reason}`,
      });
      throw new DomainError("LEASED_ASSET_NOT_DISPOSABLE", reason);
    }
    if (SALE_PATTERN.test(method)) {
      const reason = "临期食品不得以任何销售、变卖、抵债方式流出，只能走安全处置渠道";
      this._append({
        type: "DISPOSITION_RULE_VIOLATION_REJECTED",
        aggregateType: "inventory_disposition",
        aggregateId: `inv::${caseId}`,
        payload: { batch_id: batchId, attempted_method: method, reason },
        summary: `拒绝违法处置：${reason}`,
      });
      throw new DomainError("FOOD_SALE_FOR_DEBT_FORBIDDEN", reason);
    }
    if (!SAFE_FOOD_METHODS.has(method)) {
      throw new DomainError("UNSAFE_DISPOSITION_METHOD", `不支持的食品处置方式：${method}`);
    }
    if (food_safety_confirmed !== true) {
      throw new DomainError("FOOD_SAFETY_UNCONFIRMED", "食品出库处置必须确认食品安全并留痕");
    }
    return this._append({
      type: "INVENTORY_DISPOSED",
      aggregateType: "inventory_disposition",
      aggregateId: `inv::${caseId}`,
      payload: { batch_id: batchId, method, food_safety_confirmed, channel, witness },
      summary: `批次 ${batchId} 以 ${method} 完成安全处置，去向 ${channel ?? "未记录"}`,
    });
  }

  scheduleAssetReturn(caseId, batchId, scheduled_at) {
    const view = this._case(caseId);
    const batch = view.batches.get(batchId);
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", `未找到批次 ${batchId}`);
    if (batch.kind !== "LEASED_EQUIPMENT") throw new DomainError("NOT_LEASED_ASSET", `${batchId} 不是租赁资产`);
    return this._append({
      type: "ASSET_RETURN_SCHEDULED",
      aggregateType: "inventory_disposition",
      aggregateId: `inv::${caseId}`,
      payload: { batch_id: batchId, lessor_entity_id: batch.owner_entity_id, scheduled_at },
      summary: `租赁资产 ${batchId} 约定 ${scheduled_at} 向 ${batch.owner_entity_id} 归还`,
    });
  }

  returnAsset(caseId, batchId, { lessor_confirmed, condition_note, handover_proof }) {
    const view = this._case(caseId);
    const batch = view.batches.get(batchId);
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", `未找到批次 ${batchId}`);
    if (batch.status !== "RETURN_SCHEDULED") throw new DomainError("RETURN_NOT_SCHEDULED", "需先与租赁公司约定归还时间");
    if (lessor_confirmed !== true) throw new DomainError("LESSOR_NOT_CONFIRMED", "设备归还必须由租赁公司确认签收");
    return this._append({
      type: "ASSET_RETURNED",
      aggregateType: "inventory_disposition",
      aggregateId: `inv::${caseId}`,
      payload: { batch_id: batchId, lessor_entity_id: batch.owner_entity_id, lessor_confirmed: true, condition_note, handover_proof },
      summary: `租赁资产 ${batchId} 已归还 ${batch.owner_entity_id} 并经其签收确认`,
    });
  }

  // ---------- 清算专户、争议与付款瀑布 ----------

  registerObligation(caseId, payload) {
    const priority = payload.priority ?? PRIORITY_BY_CATEGORY[payload.category];
    if (!priority) throw new DomainError("PRIORITY_REQUIRED", "款项必须归入清算顺位");
    return this._append({
      type: "OBLIGATION_REGISTERED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: { ...payload, priority },
      summary: `登记对 ${payload.payee_name ?? payload.payee_entity_id} 的${labelCategory(payload.category)} ${cents(payload.amount_cents)}（第 ${priority} 顺位）`,
    });
  }

  /** 把工资/房租计提转成付款义务（仍由责任主体承担）。 */
  registerAccrualObligation(caseId, { accrual_id, payee_entity_id, payee_name, obligation_id }) {
    const view = this._case(caseId);
    const accrual = view.accruals.get(accrual_id);
    if (!accrual) throw new DomainError("ACCRUAL_NOT_FOUND", `未找到计提 ${accrual_id}`);
    const category = CATEGORY_BY_ACCRUAL[accrual.kind];
    const id = obligation_id ?? `obl-${category.toLowerCase()}-${String(view.obligations.size + 1).padStart(3, "0")}`;
    return this.registerObligation(caseId, {
      obligation_id: id,
      category,
      payee_entity_id,
      payee_name,
      amount_cents: accrual.amount_cents,
      responsible_entity_id: accrual.responsible_entity_id,
      ref_id: accrual_id,
    });
  }

  depositFunds(caseId, amount_cents, source_entity_id, purpose) {
    return this._append({
      type: "FUNDS_DEPOSITED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: { amount_cents, source_entity_id, purpose },
      summary: `${source_entity_id} 向清算专户划入 ${cents(amount_cents)}：${purpose ?? "清算资金"}`,
    });
  }

  fileDispute(caseId, { dispute_id, between_entity_ids, subject, disputed_amount_cents, obligation_ids }) {
    const view = this._case(caseId);
    for (const id of obligation_ids) {
      if (!view.obligations.has(id)) throw new DomainError("OBLIGATION_NOT_FOUND", `争议指向不存在的款项 ${id}`);
    }
    return this._append({
      type: "DISPUTE_FILED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: { dispute_id, between_entity_ids, subject, disputed_amount_cents, obligation_ids },
      summary: `登记争议：${subject}；仅挂起争议金额 ${cents(disputed_amount_cents)}，无争议余额照常支付`,
    });
  }

  /**
   * 加盟争议中若要求冻结超过争议金额的资金：拒绝并留痕。
   * 无争议余额（顾客退款、员工工资等）不得被一起冻结。
   */
  requestFreeze(caseId, { requested_by_entity_id, requested_amount_cents }) {
    const view = this._case(caseId);
    const disputedTotal = [...view.obligations.values()].reduce((s, o) => s + o.disputed_cents, 0);
    if (requested_amount_cents <= disputedTotal) {
      throw new DomainError("FREEZE_WITHIN_DISPUTE", `冻结请求未超过争议金额 ${cents(disputedTotal)}，请改用争议提存流程`);
    }
    this._append({
      type: "FREEZE_REQUEST_REJECTED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: {
        requested_by_entity_id,
        requested_amount_cents,
        matched_dispute_amount_cents: disputedTotal,
        reason: "加盟争议只能就争议金额提存，不得冻结无争议的顾客退款、工资与其他余额",
      },
      summary: `拒绝超范围冻结：申请 ${cents(requested_amount_cents)}，争议仅 ${cents(disputedTotal)}`,
    });
    throw new DomainError("FREEZE_OVERREACH_REJECTED", "冻结范围超过争议金额，已拒绝并留痕");
  }

  _nextEntrySeq(caseId) {
    return this.store.events.filter((e) => e.aggregate_id === `pay::${caseId}` && e.payload?.entry_seq).length + 1;
  }

  /**
   * 付款瀑布：1 顾客退款 → 2 工资 → 3 房租水电 → 4 供应商 → 5 加盟结算。
   * 高顺位存在无争议未付款时，低顺位不得支付；任何款项的支付不得超过其无争议余额。
   * 流水只追加；错付用 reversePayment 红冲，旧记录保留。
   */
  settle(caseId, obligation_id, amount_cents, { method = "专户代发", from_escrow = false } = {}) {
    const view = this._case(caseId);
    const target = view.obligations.get(obligation_id);
    if (!target) throw new DomainError("OBLIGATION_NOT_FOUND", `未找到款项 ${obligation_id}`);
    const remaining = target.amount_cents - target.paid_cents;
    const escrowedFor = view.escrowedByObl.get(obligation_id) ?? 0;
    const payable = remaining - target.disputed_cents;
    if (amount_cents <= 0) throw new DomainError("AMOUNT_INVALID", "支付金额必须为正");
    if (from_escrow) {
      if (target.disputed_cents > 0) throw new DomainError("DISPUTE_STILL_OPEN", "争议尚未认定，提存款不得提前支付");
      if (amount_cents > escrowedFor) throw new DomainError("ESCROW_INSUFFICIENT", `${obligation_id} 的提存余额仅 ${cents(escrowedFor)}`);
    } else if (amount_cents > payable) {
      throw new DomainError(
        "AMOUNT_EXCEEDS_UNDISPUTED",
        `${obligation_id} 无争议可付余额为 ${cents(payable)}（争议部分 ${cents(target.disputed_cents)} 未决）`
      );
    }
    const blocking = [...view.obligations.values()].filter(
      (o) => o.priority < target.priority && o.amount_cents - o.paid_cents - o.disputed_cents > 0
    );
    if (blocking.length > 0) {
      throw new DomainError(
        "WATERFALL_ORDER",
        `第 ${target.priority} 顺位支付前，必须先付清更高顺位无争议款项：${blocking.map((o) => o.obligation_id).join("、")}`
      );
    }
    if (!from_escrow && view.funds.available_cents < amount_cents) {
      throw new DomainError("INSUFFICIENT_FUNDS", `清算专户可用余额仅 ${cents(view.funds.available_cents)}`);
    }
    const seq = this._nextEntrySeq(caseId);
    return this._append({
      type: "PAYMENT_SETTLED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: {
        entry_seq: seq,
        obligation_id,
        amount_cents,
        payee_entity_id: target.payee_entity_id,
        category: target.category,
        method,
        ...(from_escrow ? { source: "ESCROW" } : {}),
      },
      summary: `流水 #${seq}：向 ${target.payee_name ?? target.payee_entity_id} 支付${labelCategory(target.category)} ${cents(amount_cents)}${from_escrow ? "（提存账户解付）" : ""}`,
    });
  }

  reversePayment(caseId, entry_seq, reason) {
    const original = this.store.events.find(
      (e) => e.aggregate_id === `pay::${caseId}` && e.event_type === "PAYMENT_SETTLED" && e.payload.entry_seq === entry_seq
    );
    if (!original) throw new DomainError("ENTRY_NOT_FOUND", `流水 #${entry_seq} 不存在`);
    const seq = this._nextEntrySeq(caseId);
    return this._append({
      type: "PAYMENT_REVERSED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: {
        entry_seq: seq,
        reverses_entry_seq: entry_seq,
        obligation_id: original.payload.obligation_id,
        amount_cents: original.payload.amount_cents,
        reason,
      },
      summary: `流水 #${seq}：红冲 #${entry_seq}（${reason}），原流水保留不删改`,
    });
  }

  /** 争议金额提存到第三方监管账户：只锁争议部分，不冻结其他余额。 */
  escrowDisputed(caseId, dispute_id, escrow_account) {
    const view = this._case(caseId);
    const dispute = view.disputes.get(dispute_id);
    if (!dispute || !dispute.open) throw new DomainError("DISPUTE_NOT_OPEN", `争议 ${dispute_id} 不存在或已解决`);
    if (view.funds.available_cents < dispute.disputed_amount_cents) {
      throw new DomainError("INSUFFICIENT_FUNDS", "专户余额不足以提存争议金额");
    }
    const seq = this._nextEntrySeq(caseId);
    return this._append({
      type: "AMOUNT_ESCROWED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: {
        entry_seq: seq,
        obligation_ids: dispute.obligation_ids,
        amount_cents: dispute.disputed_amount_cents,
        escrow_account,
        reason: dispute.subject,
      },
      summary: `流水 #${seq}：争议金额 ${cents(dispute.disputed_amount_cents)} 提存至 ${escrow_account}，无争议余额不受影响`,
    });
  }

  resolveDispute(caseId, { dispute_id, resolution, resolution_amount_cents }) {
    const view = this._case(caseId);
    const dispute = view.disputes.get(dispute_id);
    if (!dispute) throw new DomainError("DISPUTE_NOT_FOUND", `未找到争议 ${dispute_id}`);
    return this._append({
      type: "DISPUTE_RESOLVED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: { dispute_id, resolution, resolution_amount_cents },
      summary: `争议 ${dispute_id} 已认定：${resolution}，金额 ${cents(resolution_amount_cents)}`,
    });
  }

  acknowledgeSupplierPlan(caseId, obligation_ids, plan) {
    return this._append({
      type: "SUPPLIER_PLAN_ACKNOWLEDGED",
      aggregateType: "settlement_payment",
      aggregateId: `pay::${caseId}`,
      payload: { obligation_ids, plan },
      summary: `供应商债务清偿方案已确认：${plan}`,
    });
  }

  // ---------- 交接闸门与最终关闭 ----------

  closeGate(caseId, gate, proof) {
    if (!GATES.includes(gate)) throw new DomainError("UNKNOWN_GATE", `未知交接闸门 ${gate}`);
    const view = this._case(caseId);
    const status = view.gate_status[gate];
    if (status.evidenced) throw new DomainError("GATE_ALREADY_CLOSED", `闸门 ${gate} 已关闭`);
    if (!status.facts_ready) throw new DomainError("GATE_FACTS_NOT_READY", `闸门 ${gate} 的事实交接尚未齐备，不能仅凭声明关闭`);
    return this._append({
      type: "HANDOVER_GATE_CLOSED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: { gate, proof },
      summary: `交接闸门 ${gate} 关闭：${proof}`,
    });
  }

  closeCase(caseId) {
    const view = this._case(caseId);
    if (!view.announced) throw new DomainError("NOT_ANNOUNCED", "案件尚未公告");
    const pendingGates = GATES.filter((g) => !view.gate_status[g].closed);
    if (pendingGates.length) throw new DomainError("GATES_PENDING", `以下交接未完成，不能最终关闭：${pendingGates.join("、")}`);
    if (view.open_items.length) {
      throw new DomainError("OPEN_ITEMS_PENDING", `未结清单仍有 ${view.open_items.length} 项，不能最终关闭`);
    }
    return this._append({
      type: "CASE_CLOSED",
      aggregateType: "closure_case",
      aggregateId: caseId,
      payload: {},
      summary: `五个交接闸门全部关闭、未结清单清空，门店进入最终关闭状态`,
    });
  }
}

function cents(v) {
  return `¥${(v / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function labelInstrument(i) {
  return { STORED_VALUE: "储值余额", CAKE_DEPOSIT: "蛋糕定金", PREPAID_ORDER: "预付费订单" }[i] ?? i;
}
function labelCategory(c) {
  return {
    REFUND: "顾客退款",
    WAGES: "工资",
    RENT: "房租",
    UTILITY: "水电",
    SUPPLIER: "供应商货款",
    FRANCHISEE_SETTLEMENT: "加盟结算款",
    OTHER: "其他款项",
  }[c] ?? c;
}
