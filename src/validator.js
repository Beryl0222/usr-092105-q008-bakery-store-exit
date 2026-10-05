const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 各事件类型所属聚合。 */
export const EVENT_AGGREGATE = {
  CLOSURE_ANNOUNCED: "closure_case",
  LEGAL_ENTITY_IDENTIFIED: "closure_case",
  ACCRUAL_RECORDED: "closure_case",
  TRANSFER_AVAILABILITY_OPENED: "closure_case",
  FACT_RECONCILED: "closure_case",
  CENTRAL_FACTORY_HALT_ACKNOWLEDGED: "closure_case",
  HANDOVER_GATE_CLOSED: "closure_case",
  CASE_CLOSED: "closure_case",

  CLAIM_REGISTERED: "customer_claim",
  CLAIM_NOTICE_MERGED: "customer_claim",
  CLAIM_CHOICE_MADE: "customer_claim",
  CLAIM_CHOICE_EXPIRED: "customer_claim",
  CLAIM_TRANSFER_CONFIRMED: "customer_claim",
  ORDER_TRANSFERRED: "customer_claim",
  REFUND_APPROVED: "customer_claim",
  CLAIM_CLOSED: "customer_claim",

  INVENTORY_RECORDED: "inventory_disposition",
  DISPOSITION_PROPOSED: "inventory_disposition",
  INVENTORY_DISPOSED: "inventory_disposition",
  DISPOSITION_RULE_VIOLATION_REJECTED: "inventory_disposition",
  ASSET_RETURN_SCHEDULED: "inventory_disposition",
  ASSET_RETURNED: "inventory_disposition",

  OBLIGATION_REGISTERED: "settlement_payment",
  FUNDS_DEPOSITED: "settlement_payment",
  DISPUTE_FILED: "settlement_payment",
  FREEZE_REQUEST_REJECTED: "settlement_payment",
  PAYMENT_SETTLED: "settlement_payment",
  PAYMENT_REVERSED: "settlement_payment",
  AMOUNT_ESCROWED: "settlement_payment",
  DISPUTE_RESOLVED: "settlement_payment",
  SUPPLIER_PLAN_ACKNOWLEDGED: "settlement_payment",
};

/** 各事件类型 payload 必填字段。 */
const PAYLOAD_REQUIRED = {
  CLOSURE_ANNOUNCED: ["store_name", "notice_channels", "choice_deadline", "refund_policy"],
  LEGAL_ENTITY_IDENTIFIED: ["entity_id", "kind", "name"],
  ACCRUAL_RECORDED: ["accrual_id", "kind", "amount_cents", "period_from", "period_to", "responsible_entity_id"],
  TRANSFER_AVAILABILITY_OPENED: ["store_id", "store_name", "daily_capacity_orders"],
  FACT_RECONCILED: [],
  CENTRAL_FACTORY_HALT_ACKNOWLEDGED: ["factory_entity_id", "halt_at"],
  HANDOVER_GATE_CLOSED: ["gate"],
  CASE_CLOSED: [],

  CLAIM_REGISTERED: ["case_id", "customer_id", "customer_name", "instrument", "amount_cents", "holding_entity_id"],
  CLAIM_NOTICE_MERGED: ["merged_into_claim_id", "notice_id"],
  CLAIM_CHOICE_MADE: ["choice"],
  CLAIM_CHOICE_EXPIRED: ["default_choice"],
  CLAIM_TRANSFER_CONFIRMED: ["target_store_id", "customer_confirmed", "capacity_remaining_orders"],
  ORDER_TRANSFERRED: ["target_store_id", "order_ids"],
  REFUND_APPROVED: ["obligation_id", "amount_cents"],
  CLAIM_CLOSED: [],

  INVENTORY_RECORDED: ["batch_id", "kind", "owner_entity_id"],
  DISPOSITION_PROPOSED: ["batch_id", "method"],
  INVENTORY_DISPOSED: ["batch_id", "method", "food_safety_confirmed"],
  DISPOSITION_RULE_VIOLATION_REJECTED: ["batch_id", "attempted_method", "reason"],
  ASSET_RETURN_SCHEDULED: ["batch_id", "lessor_entity_id", "scheduled_at"],
  ASSET_RETURNED: ["batch_id", "lessor_entity_id", "lessor_confirmed"],

  OBLIGATION_REGISTERED: ["obligation_id", "category", "payee_entity_id", "amount_cents", "priority", "responsible_entity_id"],
  FUNDS_DEPOSITED: ["amount_cents", "source_entity_id"],
  DISPUTE_FILED: ["dispute_id", "between_entity_ids", "subject", "disputed_amount_cents", "obligation_ids"],
  FREEZE_REQUEST_REJECTED: ["requested_by_entity_id", "requested_amount_cents", "matched_dispute_amount_cents", "reason"],
  PAYMENT_SETTLED: ["entry_seq", "obligation_id", "amount_cents", "payee_entity_id", "category"],
  PAYMENT_REVERSED: ["entry_seq", "reverses_entry_seq", "obligation_id", "amount_cents", "reason"],
  AMOUNT_ESCROWED: ["entry_seq", "obligation_ids", "amount_cents", "escrow_account", "reason"],
  DISPUTE_RESOLVED: ["dispute_id", "resolution", "resolution_amount_cents"],
  SUPPLIER_PLAN_ACKNOWLEDGED: ["obligation_ids", "plan"],
};

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !(record.event_type in EVENT_AGGREGATE)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (
    "event_type" in record &&
    "aggregate_type" in record &&
    record.event_type in EVENT_AGGREGATE &&
    EVENT_AGGREGATE[record.event_type] !== record.aggregate_type
  ) {
    errors.push(
      `事件 ${record.event_type} 只能归属聚合 ${EVENT_AGGREGATE[record.event_type]}，不能写入 ${record.aggregate_type}`
    );
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法时间");
  }

  const need = PAYLOAD_REQUIRED[record.event_type];
  if (need && need.length > 0) {
    const payload = record.payload ?? {};
    for (const name of need) {
      if (!(name in payload)) errors.push(`缺少 payload 字段：${name}`);
    }
  }
  return errors;
}
