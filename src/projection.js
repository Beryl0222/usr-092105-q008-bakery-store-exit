// 投影：把一个案件的只追加事件流折叠成"当前事实"。
// 投影结果不持久化也可以随时重算；未结清单与关闭闸门全部来自这里，
// 任何人工状态都不得绕过事件直接写入。

const EMPLOYEE_CATEGORIES = new Set(["employee_wage", "employee_severance"]);
const SUPPLIER_CATEGORIES = new Set(["supplier_payable"]);
const FOOD_METHODS = new Set([
  "neighbor_transfer",
  "charity_donation",
  "safe_destruction",
  "supplier_return",
]);

export function project(events) {
  const state = {
    announced: null,
    closed: null,
    subjects: new Map(),
    claims: new Map(),
    /** key `${neighbor}|${date}|${line}` -> {slots_total, at} */
    capacities: new Map(),
    /** 同 key 上已成功转移的订单数（来自 ORDER_TRANSFERRED） */
    occupancy: new Map(),
    lots: new Map(),
    disposedLots: new Set(),
    dispositions: [],
    assets: new Map(),
    obligations: new Map(),
  };

  for (const e of events) apply(state, e);
  return state;
}

function apply(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "CLOSURE_ANNOUNCED":
      state.announced = { at: e.occurred_at, ...p };
      break;
    case "CASE_CLOSED":
      state.closed = { at: e.occurred_at, ...p };
      break;
    case "SUBJECT_REGISTERED":
      state.subjects.set(p.subject.subject_id, {
        ...p.subject,
        rights: p.rights ?? [],
        obligations: p.obligations ?? [],
      });
      break;

    case "CLAIM_REGISTERED": {
      state.claims.set(e.aggregate_id, {
        claim_id: e.aggregate_id,
        customer: p.customer,
        claim_kind: p.claim_kind,
        amount_minor: p.amount_minor,
        funds_location: p.funds_location,
        liable_subject_id: p.liable_subject_id,
        status: "registered",
        choice: null,
        transfer: null,
      });
      break;
    }
    case "CUSTOMER_CHOICE_RECORDED": {
      const c = state.claims.get(e.aggregate_id);
      if (c) {
        c.status = p.choice === "transfer_to_neighbor" ? "choice_transfer" : `choice_${p.choice}`;
        c.choice = { ...p, at: e.occurred_at };
      }
      break;
    }
    case "ORDER_TRANSFERRED": {
      const c = state.claims.get(e.aggregate_id);
      if (c) {
        c.status = "transferred";
        c.transfer = { ...p, at: e.occurred_at };
      }
      const key = capKey(p.neighbor_store_id, p.service_date, p.product_line);
      state.occupancy.set(key, (state.occupancy.get(key) ?? 0) + 1);
      break;
    }
    case "CLAIM_WAIVED": {
      const c = state.claims.get(e.aggregate_id);
      if (c) c.status = "waived";
      break;
    }
    case "TRANSFER_CAPACITY_DECLARED": {
      const key = capKey(p.neighbor_store_id, p.service_date, p.product_line);
      state.capacities.set(key, { slots_total: p.slots_total, declared_at: e.occurred_at });
      break;
    }

    case "INVENTORY_CLASSIFIED":
      for (const lot of p.lots ?? []) state.lots.set(lot.lot_id, lot);
      break;
    case "INVENTORY_DISPOSED":
      state.dispositions.push({ at: e.occurred_at, ...p });
      for (const id of p.lot_ids ?? []) state.disposedLots.add(id);
      break;

    case "LEASED_ASSET_RETURN_SCHEDULED": {
      const a = state.assets.get(e.aggregate_id) ?? { asset_id: p.asset?.asset_id };
      state.assets.set(e.aggregate_id, {
        ...a,
        ...p.asset,
        scheduled: { scheduled_at: p.scheduled_at, handover_location: p.handover_location, at: e.occurred_at },
      });
      break;
    }
    case "LEASED_ASSET_RETURNED": {
      const a = state.assets.get(e.aggregate_id) ?? {};
      state.assets.set(e.aggregate_id, { ...a, returned: { ...p, at: e.occurred_at } });
      break;
    }

    case "PAYMENT_OBLIGATION_ENTERED": {
      state.obligations.set(e.aggregate_id, {
        pay_id: e.aggregate_id,
        code: p.obligation_code,
        category: p.category,
        payee: p.payee,
        amount_total_minor: p.amount_minor,
        currency: p.currency ?? "CNY",
        accruable: p.accruable ?? false,
        payroll_final: p.payroll_final ?? false,
        claim_id: p.claim_id ?? null,
        accruals: [],
        paid_minor: 0,
        payments: [],
        dispute: null,
        resolution: null,
      });
      // 兜底退款义务后补登记时，已退款完成的权益单回到待退款态，直至新义务也付清。
      if (p.claim_id) {
        const linked = state.claims.get(p.claim_id);
        if (linked?.status === "refunded") linked.status = "choice_refund";
      }
      break;
    }
    case "ACCRUAL_APPENDED": {
      const o = state.obligations.get(e.aggregate_id);
      if (o) {
        o.amount_total_minor += p.amount_delta_minor;
        o.accruals.push({ ...p, at: e.occurred_at });
      }
      break;
    }
    case "OBLIGATION_DISPUTED": {
      const o = state.obligations.get(e.aggregate_id);
      if (o) o.dispute = { ...p, at: e.occurred_at, resolved: false };
      break;
    }
    case "DISPUTE_RESOLVED": {
      const o = state.obligations.get(e.aggregate_id);
      if (o) {
        o.resolution = { ...p, at: e.occurred_at };
        if (o.dispute) o.dispute.resolved = true;
      }
      break;
    }
    case "PAYMENT_SETTLED": {
      const o = state.obligations.get(e.aggregate_id);
      if (o) {
        o.paid_minor += p.amount_minor;
        o.payments.push({ ...p, at: e.occurred_at });
        // 退款义务付清（含品牌兜底另立的同 claim 义务）后，顾客权益单完成。
        if (o.claim_id) {
          const claim = state.claims.get(o.claim_id);
          if (claim && claim.status === "choice_refund") {
            const allForClaim = [...state.obligations.values()].filter((x) => x.claim_id === o.claim_id);
            const allPaid = allForClaim.every((x) => obligationNumbers(x).unpaid === 0 && !obligationNumbers(x).unresolved_dispute);
            if (allPaid) claim.status = "refunded";
          }
        }
      }
      break;
    }
  }
}

function capKey(storeId, date, line) {
  return `${storeId}|${date}|${line}`;
}

/** 一笔义务在当前事实下的金额分解。 */
export function obligationNumbers(o) {
  const total = o.amount_total_minor;
  const disputed = o.dispute && !o.dispute.resolved ? o.dispute.disputed_amount_minor : 0;
  // 争议未决：争议金额冻结，其余可付；争议已决：争议部分按裁定金额重新计入。
  const payable = o.dispute
    ? o.dispute.resolved && o.resolution
      ? total - o.dispute.disputed_amount_minor + o.resolution.payable_amount_minor
      : total - disputed
    : total;
  const payableClamped = Math.max(payable, 0);
  return {
    total,
    disputed,
    payable: payableClamped,
    paid: o.paid_minor,
    unpaid: Math.max(payableClamped - o.paid_minor, 0),
    unresolved_dispute: Boolean(o.dispute && !o.dispute.resolved),
    waived: Boolean(o.resolution && o.resolution.resolution === "waive"),
  };
}

/**
 * 随事实变化的未结清单，四个法定/约定桶加一个操作交接桶：
 * 等待顾客选择 / 等待承接 / 待支付 / 责任争议 / 操作交接（食品与租赁资产）。
 */
export function checklist(state) {
  const buckets = {
    awaiting_customer_choice: [],
    awaiting_transfer: [],
    awaiting_payment: [],
    liability_disputes: [],
    operational_handover: [],
  };

  for (const c of state.claims.values()) {
    if (c.status === "registered") {
      buckets.awaiting_customer_choice.push({ claim_id: c.claim_id, claim_kind: c.claim_kind });
    } else if (c.status === "choice_transfer") {
      const hasAnyCapacity = [...state.capacities.keys()].some(
        (key) => key.startsWith(`${c.choice.neighbor_store_id}|`),
      );
      buckets.awaiting_transfer.push({
        claim_id: c.claim_id,
        neighbor_store_id: c.choice.neighbor_store_id,
        capacity_declared: hasAnyCapacity,
      });
    }
  }

  for (const o of state.obligations.values()) {
    const n = obligationNumbers(o);
    const item = {
      pay_id: o.pay_id,
      obligation_code: o.code,
      category: o.category,
      payee: o.payee?.name,
      amount_total_minor: n.total,
      unpaid_minor: n.unpaid,
      disputed_minor: n.disputed,
    };
    if (n.unresolved_dispute) buckets.liability_disputes.push(item);
    // 争议只冻结争议金额：无争议部分照样进入待支付桶。
    const openNonDisputed = o.resolution ? n.unpaid : n.total - n.disputed - n.paid;
    if (openNonDisputed > 0) buckets.awaiting_payment.push(item);
  }

  for (const lot of state.lots.values()) {
    if (!state.disposedLots.has(lot.lot_id)) {
      buckets.operational_handover.push({ type: "food_or_material_lot", lot_id: lot.lot_id, name: lot.name });
    }
  }
  for (const [assetAggId, a] of state.assets) {
    if (!a.returned) {
      buckets.operational_handover.push({
        type: "leased_asset",
        asset_aggregate_id: assetAggId,
        asset_id: a.asset_id,
        name: a.name,
        refrigerated: a.refrigerated,
        scheduled: Boolean(a.scheduled),
      });
    }
  }

  return buckets;
}

/** 五道交接闸门：订单、食品、员工款项、租赁资产、供应商责任。 */
export function gates(state) {
  const result = {};

  // 订单/顾客权益：每张权益单必须转入完成、退款付清或顾客明确放弃。
  const openClaims = [...state.claims.values()].filter((c) =>
    ["registered", "choice_transfer", "choice_refund", "choice_waive"].includes(c.status),
  );
  // 选择退款的权益单还要看退款义务是否付清。
  const refundObligationByClaim = new Map();
  for (const o of state.obligations.values()) {
    if (o.claim_id) refundObligationByClaim.set(o.claim_id, o);
  }
  const unpaidRefundClaims = [...state.claims.values()].filter((c) => {
    if (c.status !== "choice_refund") return false;
    const o = refundObligationByClaim.get(c.claim_id);
    if (!o) return true;
    return obligationNumbers(o).unpaid > 0;
  });
  result.orders = {
    passed: state.claims.size > 0 && openClaims.length === 0 && unpaidRefundClaims.length === 0,
    claims_total: state.claims.size,
    open_claims: openClaims.map((c) => ({ claim_id: c.claim_id, status: c.status })),
    unpaid_refunds: unpaidRefundClaims.map((c) => c.claim_id),
  };

  // 食品：每个食品批次都必须有安全处置去向；必须有食品实际登记并处置完毕，不能凭"没登记"通过。
  const foodLots = [...state.lots.values()].filter((l) => l.category === "food");
  const openFoodLots = foodLots
    .filter((l) => !state.disposedLots.has(l.lot_id))
    .map((l) => ({ lot_id: l.lot_id, name: l.name, expiry_at: l.expiry_at }));
  const unsafeDispositions = state.dispositions
    .filter((d) => d.for_debt_setoff === true || !FOOD_METHODS.has(d.method))
    .map((d) => ({ lot_ids: d.lot_ids, method: d.method }));
  const disposedFoodCount = foodLots.filter((l) => state.disposedLots.has(l.lot_id)).length;
  result.food_safety = {
    passed: foodLots.length > 0 && openFoodLots.length === 0 && unsafeDispositions.length === 0,
    food_lots_total: foodLots.length,
    disposed_food_lots: disposedFoodCount,
    open_food_lots: openFoodLots,
    unsafe_dispositions: unsafeDispositions,
  };

  // 员工款项：工资与经济补偿的无争议/已决金额全部付清，争议已结清；必须有实际款项交接。
  const employeeAll = [...state.obligations.values()].filter((o) => EMPLOYEE_CATEGORIES.has(o.category));
  const employeeOpen = [];
  for (const o of employeeAll) {
    const n = obligationNumbers(o);
    if (n.unpaid > 0 || n.unresolved_dispute) {
      employeeOpen.push({ obligation_code: o.code, unpaid_minor: n.unpaid, unresolved_dispute: n.unresolved_dispute });
    }
  }
  result.employee_payments = {
    passed: employeeAll.length > 0 && employeeOpen.length === 0,
    obligations_total: employeeAll.length,
    open: employeeOpen,
  };

  // 租赁资产：逐台归还并留交接记录；登记了租赁资产就必须全部归还。
  const openAssets = [...state.assets.entries()]
    .filter(([, a]) => !a.returned)
    .map(([id, a]) => ({ asset_aggregate_id: id, asset_id: a.asset_id, name: a.name }));
  result.leased_assets = {
    passed: state.assets.size > 0 && openAssets.length === 0,
    assets_total: state.assets.size,
    open: openAssets,
  };

  // 供应商责任：货款付清或争议有结论后结清；必须有实际责任交接（含退货冲减后免除）。
  const supplierAll = [...state.obligations.values()].filter((o) => SUPPLIER_CATEGORIES.has(o.category));
  const supplierOpen = [];
  for (const o of supplierAll) {
    const n = obligationNumbers(o);
    if (n.unpaid > 0 || n.unresolved_dispute) {
      supplierOpen.push({ obligation_code: o.code, unpaid_minor: n.unpaid, unresolved_dispute: n.unresolved_dispute });
    }
  }
  result.supplier_liabilities = {
    passed: supplierAll.length > 0 && supplierOpen.length === 0,
    obligations_total: supplierAll.length,
    open: supplierOpen,
  };

  return result;
}

export function allGatesPassed(state) {
  return Object.values(gates(state)).every((g) => g.passed);
}
