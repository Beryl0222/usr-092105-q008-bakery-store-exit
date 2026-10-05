// 领域事件信封的基础校验：只检查公共约定，不解读业务流转。
// 业务流转的守卫（先后顺序、产能、争议余额等）在 src/engine.js 中。

const REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "case_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
];

export const EVENT_TYPES = [
  "CLOSURE_ANNOUNCED",
  "CASE_CLOSED",
  "SUBJECT_REGISTERED",
  "CLAIM_REGISTERED",
  "CLAIM_WAIVED",
  "CUSTOMER_CHOICE_RECORDED",
  "TRANSFER_CAPACITY_DECLARED",
  "ORDER_TRANSFERRED",
  "INVENTORY_CLASSIFIED",
  "INVENTORY_DISPOSED",
  "LEASED_ASSET_RETURN_SCHEDULED",
  "LEASED_ASSET_RETURNED",
  "PAYMENT_OBLIGATION_ENTERED",
  "ACCRUAL_APPENDED",
  "OBLIGATION_DISPUTED",
  "DISPUTE_RESOLVED",
  "PAYMENT_SETTLED",
];

export const AGGREGATE_TYPES = [
  "closure_case",
  "customer_claim",
  "inventory_disposition",
  "settlement_payment",
];

// 每种事件允许归属的聚合类型，防止把付款流水错挂到顾客权益上。
const EVENT_AGGREGATE = {
  CLOSURE_ANNOUNCED: ["closure_case"],
  CASE_CLOSED: ["closure_case"],
  SUBJECT_REGISTERED: ["closure_case"],
  TRANSFER_CAPACITY_DECLARED: ["closure_case"],
  CLAIM_REGISTERED: ["customer_claim"],
  CLAIM_WAIVED: ["customer_claim"],
  CUSTOMER_CHOICE_RECORDED: ["customer_claim"],
  ORDER_TRANSFERRED: ["customer_claim"],
  INVENTORY_CLASSIFIED: ["inventory_disposition"],
  INVENTORY_DISPOSED: ["inventory_disposition"],
  LEASED_ASSET_RETURN_SCHEDULED: ["inventory_disposition"],
  LEASED_ASSET_RETURNED: ["inventory_disposition"],
  PAYMENT_OBLIGATION_ENTERED: ["settlement_payment"],
  ACCRUAL_APPENDED: ["settlement_payment"],
  OBLIGATION_DISPUTED: ["settlement_payment"],
  DISPUTE_RESOLVED: ["settlement_payment"],
  PAYMENT_SETTLED: ["settlement_payment"],
};

/** 返回可以直接展示给接入方的中文错误；无错误时返回空数组。 */
export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map(
    (name) => `缺少字段：${name}`,
  );
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length < 8) {
    errors.push("event_id 至少 8 个字符，重试必须沿用原标识");
  }
  if (!EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) {
    errors.push("aggregate_id 不能为空");
  }
  if (typeof record.case_id !== "string" || !record.case_id) {
    errors.push("case_id 不能为空");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是从 1 开始的正整数");
  }
  if (typeof record.summary !== "string" || record.summary.length < 2) {
    errors.push("summary 至少 2 个字符的中文事实摘要");
  }
  if (Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是可解析的时间");
  }
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    errors.push("payload 必须是事实明细对象");
  }
  const allowed = EVENT_AGGREGATE[record.event_type];
  if (allowed && !allowed.includes(record.aggregate_type)) {
    errors.push(
      `事件 ${record.event_type} 不能挂在聚合 ${record.aggregate_type} 上，只允许：${allowed.join(" / ")}`,
    );
  }
  return errors;
}
