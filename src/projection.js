/** 五个最终交接闸门。 */
export const GATES = ["ORDERS", "FOOD", "EMPLOYEE_PAY", "LEASED_ASSETS", "SUPPLIER_DEBT"];

/** 未结清单的四个分类。 */
export const OPEN_BUCKETS = {
  WAITING_CUSTOMER_CHOICE: "等待顾客选择",
  WAITING_TRANSFER: "等待承接",
  PENDING_PAYMENT: "待支付",
  RESPONSIBILITY_DISPUTE: "责任争议",
};

const FOOD_KINDS = new Set(["NEAR_EXPIRY_FOOD", "SHELF_STABLE_FOOD"]);

function yen(cents) {
  return `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * 把一个案件的全部事件折叠为当前事实视图。
 * 纯函数：不修改事件，付款以追加流水呈现，旧记录始终保留。
 */
export function projectCase(caseId, events, now = new Date()) {
  const caseEvents = events.filter(
    (e) => e.aggregate_type !== "closure_case" || e.aggregate_id === caseId
  );

  const view = {
    case_id: caseId,
    status: "DRAFT",
    announced: null,
    entities: new Map(),
    accruals: new Map(),
    transferStores: new Map(),
    factoryHalt: null,
    claims: new Map(),
    batches: new Map(),
    obligations: new Map(),
    disputes: new Map(),
    escrowedByObl: new Map(),
    supplierPlans: [],
    ledger: [],
    funds_total_cents: 0,
    gates: Object.fromEntries(GATES.map((g) => [g, false])),
    closed_at: null,
  };

  const claimById = (id) => view.claims.get(id);

  for (const e of caseEvents) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "CLOSURE_ANNOUNCED":
        view.announced = { ...p, announced_at: e.occurred_at };
        view.status = "ANNOUNCED";
        break;
      case "LEGAL_ENTITY_IDENTIFIED":
        view.entities.set(p.entity_id, {
          entity_id: p.entity_id,
          kind: p.kind,
          name: p.name,
          rights: p.rights ?? [],
          obligations: p.obligations ?? [],
          holds_funds_note: p.holds_funds_note ?? null,
        });
        break;
      case "ACCRUAL_RECORDED":
        view.accruals.set(p.accrual_id, p);
        break;
      case "TRANSFER_AVAILABILITY_OPENED":
        view.transferStores.set(p.store_id, {
          store_id: p.store_id,
          store_name: p.store_name,
          daily_capacity_orders: p.daily_capacity_orders,
          products_supported: p.products_supported ?? [],
          reserved_orders: 0,
        });
        break;
      case "CENTRAL_FACTORY_HALT_ACKNOWLEDGED":
        view.factoryHalt = p;
        break;
      case "HANDOVER_GATE_CLOSED":
        view.gates[p.gate] = true;
        break;
      case "CASE_CLOSED":
        view.status = "CLOSED";
        view.closed_at = e.occurred_at;
        break;

      case "CLAIM_REGISTERED": {
        view.claims.set(e.aggregate_id, {
          claim_id: e.aggregate_id,
          status: "REGISTERED",
          ...p,
          merged_notices: [],
          choice: null,
          target_store_id: null,
          transferred_order_ids: [],
          refund_obligation_id: null,
          closed: false,
        });
        break;
      }
      case "CLAIM_NOTICE_MERGED": {
        const target = view.claims.get(p.merged_into_claim_id);
        if (target) target.merged_notices.push(p.notice_id);
        break;
      }
      case "CLAIM_CHOICE_MADE": {
        const c = claimById(e.aggregate_id);
        if (c) {
          c.choice = p.choice;
          c.target_store_id = p.target_store_id ?? null;
          c.status = p.choice === "TRANSFER" ? "AWAITING_TRANSFER" : "REFUND_CHOSEN";
        }
        break;
      }
      case "CLAIM_CHOICE_EXPIRED": {
        const c = claimById(e.aggregate_id);
        if (c) {
          c.choice = "REFUND";
          c.status = "CHOICE_EXPIRED_REFUND";
        }
        break;
      }
      case "CLAIM_TRANSFER_CONFIRMED": {
        const c = claimById(e.aggregate_id);
        if (c) {
          const store = view.transferStores.get(p.target_store_id);
          if (store) store.reserved_orders += 1;
          c.target_store_id = p.target_store_id;
          c.customer_confirmed = true;
          c.status = "TRANSFER_CONFIRMED";
        }
        break;
      }
      case "ORDER_TRANSFERRED": {
        const c = claimById(e.aggregate_id);
        if (c) {
          c.transferred_order_ids.push(...p.order_ids);
          c.status = "TRANSFERRED";
          c.closed = true;
        }
        break;
      }
      case "REFUND_APPROVED": {
        const c = claimById(e.aggregate_id);
        if (c) {
          c.refund_obligation_id = p.obligation_id;
          c.status = "REFUND_APPROVED";
        }
        break;
      }
      case "CLAIM_CLOSED": {
        const c = claimById(e.aggregate_id);
        if (c) c.closed = true;
        break;
      }

      case "INVENTORY_RECORDED":
        view.batches.set(p.batch_id, {
          ...p,
          status: "RECORDED",
          disposition_method: null,
          returned_to: null,
        });
        break;
      case "DISPOSITION_PROPOSED": {
        const b = view.batches.get(p.batch_id);
        if (b) {
          b.proposed_method = p.method;
          b.status = "PROPOSED";
        }
        break;
      }
      case "INVENTORY_DISPOSED": {
        const b = view.batches.get(p.batch_id);
        if (b) {
          b.status = "DISPOSED";
          b.disposition_method = p.method;
          b.food_safety_confirmed = p.food_safety_confirmed;
          b.channel = p.channel ?? null;
        }
        break;
      }
      case "DISPOSITION_RULE_VIOLATION_REJECTED": {
        const b = view.batches.get(p.batch_id);
        if (b) b.rejection = p;
        break;
      }
      case "ASSET_RETURN_SCHEDULED": {
        const b = view.batches.get(p.batch_id);
        if (b) {
          b.status = "RETURN_SCHEDULED";
          b.scheduled_at = p.scheduled_at;
        }
        break;
      }
      case "ASSET_RETURNED": {
        const b = view.batches.get(p.batch_id);
        if (b) {
          b.status = "RETURNED";
          b.returned_to = p.lessor_entity_id;
          b.lessor_confirmed = true;
          b.handover_proof = p.handover_proof ?? null;
        }
        break;
      }

      case "OBLIGATION_REGISTERED":
        view.obligations.set(p.obligation_id, {
          ...p,
          paid_cents: 0,
          disputed_cents: 0,
        });
        break;
      case "FUNDS_DEPOSITED":
        view.funds_total_cents += p.amount_cents;
        break;
      case "DISPUTE_FILED": {
        view.disputes.set(p.dispute_id, { ...p, open: true, resolution: null });
        // 争议只挂起有争议的部分：争议总额在所列款项间按剩余金额分摊、逐笔封顶；
        // 无争议余额继续可付。
        let left = p.disputed_amount_cents;
        for (const id of p.obligation_ids) {
          if (left <= 0) break;
          const o = view.obligations.get(id);
          if (!o) continue;
          const share = Math.min(o.amount_cents - o.paid_cents, left);
          o.disputed_cents = share;
          left -= share;
        }
        break;
      }
      case "FREEZE_REQUEST_REJECTED":
        view.overreachFreeze = p;
        break;
      case "PAYMENT_SETTLED": {
        const o = view.obligations.get(p.obligation_id);
        if (o) o.paid_cents += p.amount_cents;
        if (p.source === "ESCROW") {
          // 从提存账户支付：提存余额同步释放，不再占用可用额度。
          view.ledger.push({ ...p, kind: "PAYMENT_FROM_ESCROW" });
          view.escrowedByObl.set(p.obligation_id, Math.max(0, (view.escrowedByObl.get(p.obligation_id) ?? 0) - p.amount_cents));
        } else {
          view.ledger.push({ ...p, kind: "PAYMENT" });
        }
        break;
      }
      case "PAYMENT_REVERSED": {
        const o = view.obligations.get(p.obligation_id);
        if (o) o.paid_cents = Math.max(0, o.paid_cents - p.amount_cents);
        view.ledger.push({ ...p, kind: "REVERSAL" });
        break;
      }
      case "AMOUNT_ESCROWED":
        view.ledger.push({ ...p, kind: "ESCROW" });
        // 提存后争议部分由监管账户担保，从"未决争议"转为"已担保争议"，不再拖住无争议的清算。
        for (const id of p.obligation_ids) {
          const o = view.obligations.get(id);
          if (o && o.disputed_cents > 0) {
            const share = Math.min(o.disputed_cents, p.amount_cents);
            view.escrowedByObl.set(id, (view.escrowedByObl.get(id) ?? 0) + share);
          }
        }
        break;
      case "DISPUTE_RESOLVED": {
        const d = view.disputes.get(p.dispute_id);
        if (d) {
          d.open = false;
          d.resolution = p.resolution;
          d.resolution_amount_cents = p.resolution_amount_cents;
          // 责任一经认定，挂起的争议金额释放为可付余额。
          for (const id of d.obligation_ids) {
            const o = view.obligations.get(id);
            if (o) o.disputed_cents = 0;
          }
        }
        break;
      }
      case "SUPPLIER_PLAN_ACKNOWLEDGED":
        view.supplierPlans.push(p);
        break;
    }
  }

  // ---- 派生：储值/订单转移产能 ----
  for (const store of view.transferStores.values()) {
    store.capacity_remaining_orders = Math.max(0, store.daily_capacity_orders - store.reserved_orders);
  }

  // ---- 派生：清算专户余额（只由追加流水计算）----
  const settled = view.ledger
    .filter((l) => l.kind === "PAYMENT" || l.kind === "PAYMENT_FROM_ESCROW")
    .reduce((s, l) => s + l.amount_cents, 0);
  const reversed = view.ledger.filter((l) => l.kind === "REVERSAL").reduce((s, l) => s + l.amount_cents, 0);
  const escrowIn = view.ledger.filter((l) => l.kind === "ESCROW").reduce((s, l) => s + l.amount_cents, 0);
  const escrowOut = view.ledger.filter((l) => l.kind === "PAYMENT_FROM_ESCROW").reduce((s, l) => s + l.amount_cents, 0);
  const escrowed = escrowIn - escrowOut;
  view.funds = {
    deposited_cents: view.funds_total_cents,
    paid_out_cents: settled - reversed,
    escrowed_cents: escrowed,
    available_cents: view.funds_total_cents - (settled - reversed) - escrowed,
  };

  // ---- 派生：未结清单（四分类）----
  const openItems = [];
  const nowIso = new Date(now).toISOString();

  for (const c of view.claims.values()) {
    if (c.closed) continue;
    if (c.status === "REGISTERED") {
      const overdue = view.announced && new Date(c.deadline_override ?? view.announced.choice_deadline) < new Date(nowIso);
      openItems.push({
        bucket: "WAITING_CUSTOMER_CHOICE",
        ref: c.claim_id,
        label: `${c.customer_name} 的${c.instrument === "STORED_VALUE" ? "储值余额" : c.instrument === "CAKE_DEPOSIT" ? "蛋糕定金" : "预付费订单"} ${yen(c.amount_cents)} 等待选择承接或退款`,
        overdue,
      });
    } else if (["AWAITING_TRANSFER", "TRANSFER_CONFIRMED"].includes(c.status)) {
      openItems.push({
        bucket: "WAITING_TRANSFER",
        ref: c.claim_id,
        label: `${c.customer_name} 的订单待${c.status === "TRANSFER_CONFIRMED" ? "邻店实际履约" : "顾客确认与产能校验"}，目标店 ${c.target_store_id ?? "未定"}`,
      });
    } else if (!c.refund_obligation_id) {
      // 退款义务一旦核定，待支付事项由该义务统一呈现，避免与顾客权益重复计数。
      openItems.push({
        bucket: "PENDING_PAYMENT",
        ref: c.claim_id,
        label: `${c.customer_name} 的退款 ${yen(c.amount_cents)} 待核定支付义务${c.status === "CHOICE_EXPIRED_REFUND" ? "（选择期已过，按退款处理）" : ""}`,
      });
    }
  }

  for (const o of view.obligations.values()) {
    const remaining = o.amount_cents - o.paid_cents;
    if (remaining <= 0) continue;
    const escrowed = view.escrowedByObl.get(o.obligation_id) ?? 0;
    const disputedPending = Math.max(0, o.disputed_cents - escrowed);
    const undisputed = remaining - o.disputed_cents;
    const payee = o.payee_name ?? view.entities.get(o.payee_entity_id)?.name ?? o.payee_entity_id;
    if (disputedPending > 0) {
      if (undisputed > 0) {
        openItems.push({
          bucket: "PENDING_PAYMENT",
          ref: o.obligation_id,
          label: `${payee} 的${categoryLabel(o.category)}无争议部分 ${yen(undisputed)} 待支付（争议不得冻结此部分）`,
        });
      }
      openItems.push({
        bucket: "RESPONSIBILITY_DISPUTE",
        ref: o.obligation_id,
        label: `${payee} 的${categoryLabel(o.category)}争议部分 ${yen(disputedPending)} 待责任认定`,
      });
    } else {
      const amountDue = remaining - escrowed;
      if (amountDue <= 0) continue; // 剩余部分已全额提存，等待认定结果，不再是未结事项
      const note = escrowed > 0 ? `（另 ${yen(escrowed)} 已提存，不冻结其他款项）` : "";
      openItems.push({
        bucket: "PENDING_PAYMENT",
        ref: o.obligation_id,
        label: `${payee} 的${categoryLabel(o.category)} ${yen(amountDue)} 待支付${note}`,
      });
    }
  }

  view.open_items = openItems;
  view.open_counts = Object.fromEntries(
    Object.keys(OPEN_BUCKETS).map((b) => [b, openItems.filter((i) => i.bucket === b).length])
  );

  // ---- 派生：五个交接闸门是否齐备 ----
  const allClaimsDone = [...view.claims.values()].every((c) => c.closed);
  const foodBatches = [...view.batches.values()].filter((b) => FOOD_KINDS.has(b.kind) || b.kind === "PACKAGING_MATERIAL");
  const leasedAssets = [...view.batches.values()].filter((b) => b.kind === "LEASED_EQUIPMENT");
  const wageAccruals = [...view.accruals.values()].filter((a) => a.kind === "WAGES");
  const wageObligationsCovered = wageAccruals.every((a) =>
    [...view.obligations.values()].some((o) => o.ref_id === a.accrual_id)
  );
  const wagesPaid =
    wageObligationsCovered &&
    [...view.obligations.values()]
      .filter((o) => o.category === "WAGES")
      .every((o) => o.paid_cents >= o.amount_cents);

  const supplierObligations = [...view.obligations.values()].filter((o) => o.category === "SUPPLIER");
  const plannedIds = new Set(view.supplierPlans.flatMap((pl) => pl.obligation_ids));
  const suppliersHandled =
    view.factoryHalt !== null &&
    supplierObligations.every((o) => {
      const unpaid = o.amount_cents - o.paid_cents;
      const escrowed = view.escrowedByObl.get(o.obligation_id) ?? 0;
      const undisputedUnpaid = Math.max(0, unpaid - o.disputed_cents);
      const disputedCovered = escrowed >= o.disputed_cents;
      // 无争议部分：当场付清，或已有供应商书面确认的清偿方案；争议部分：必须已提存。
      return disputedCovered && (undisputedUnpaid === 0 || plannedIds.has(o.obligation_id));
    });

  const computedGates = {
    ORDERS: allClaimsDone,
    FOOD: view.factoryHalt !== null && foodBatches.every((b) => b.status === "DISPOSED"),
    EMPLOYEE_PAY: wageAccruals.length > 0 && wagesPaid,
    LEASED_ASSETS: leasedAssets.every((b) => b.status === "RETURNED" && b.lessor_confirmed),
    SUPPLIER_DEBT: supplierObligations.length > 0 && suppliersHandled,
  };
  // HANDOVER_GATE_CLOSED 事件是各方交接凭据；事件标记与事实齐备同时满足才算数。
  view.gate_status = Object.fromEntries(
    GATES.map((g) => [g, { evidenced: view.gates[g], facts_ready: computedGates[g], closed: view.gates[g] && computedGates[g] }])
  );
  view.all_gates_closed = GATES.every((g) => view.gate_status[g].closed);

  if (view.status === "CLOSED") {
    view.can_close = true;
  } else {
    view.can_close = view.all_gates_closed && openItems.length === 0 && view.announced !== null;
  }
  view.funds_label = {
    deposited: yen(view.funds.deposited_cents),
    paid_out: yen(view.funds.paid_out_cents),
    escrowed: yen(view.funds.escrowed_cents),
    available: yen(view.funds.available_cents),
  };
  return view;
}

function categoryLabel(category) {
  return {
    REFUND: "顾客退款",
    WAGES: "工资",
    RENT: "房租",
    UTILITY: "水电",
    SUPPLIER: "供应商货款",
    FRANCHISEE_SETTLEMENT: "加盟结算",
    OTHER: "其他款项",
  }[category] ?? category;
}
