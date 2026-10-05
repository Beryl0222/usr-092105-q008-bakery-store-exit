import { validateEvent } from "./validator.js";

/** 业务规则被违反时抛出，message 可直接展示给操作人员。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

const streamCase = (aggregateType, aggregateId, payload) => {
  if (aggregateType === "closure_case") return aggregateId;
  if (aggregateType === "customer_claim") return undefined; // 由 CLAIM_REGISTERED 建立 claim→case 索引
  if (aggregateType === "inventory_disposition" || aggregateType === "settlement_payment") {
    return aggregateId.includes("::") ? aggregateId.split("::")[1] : payload?.case_id;
  }
  return payload?.case_id;
};

/**
 * 只追加事件日志。
 * - event_id 全局唯一：同一标识重试且内容一致 => 幂等吸收；内容不一致 => 拒绝。
 * - version 在每个聚合内从 1 单调递增。
 * - 外部通知编号（payload.notice_id / source_notice_ids）按案件去重，供重复申报合并。
 */
export class EventStore {
  constructor() {
    this.events = [];
    this._byId = new Map();
    this._nextVersion = new Map();
    this._notices = new Map(); // caseId|noticeId -> event
    this._claimCase = new Map(); // claimId -> caseId
  }

  hasNotice(caseId, noticeId) {
    return this._notices.has(`${caseId}|${noticeId}`);
  }

  noticeEvent(caseId, noticeId) {
    return this._notices.get(`${caseId}|${noticeId}`);
  }

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new DomainError("INVALID_EVENT", errors.join("；"));

    const existing = this._byId.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new DomainError("EVENT_ID_CONFLICT", `事件标识 ${event.event_id} 已被不同内容占用，旧记录不可修改`);
      }
      return { duplicate: true, event: existing };
    }

    const current = this._nextVersion.get(event.aggregate_id) ?? 0;
    if (event.version !== current + 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `聚合 ${event.aggregate_id} 下一版本应为 ${current + 1}，收到 ${event.version}`
      );
    }

    this._nextVersion.set(event.aggregate_id, event.version);
    this.events.push(event);
    this._byId.set(event.event_id, event);

    if (event.event_type === "CLAIM_REGISTERED") {
      this._claimCase.set(event.aggregate_id, event.payload.case_id);
      if (event.payload.notice_id) {
        this._notices.set(`${event.payload.case_id}|${event.payload.notice_id}`, event);
      }
    }
    const caseId =
      event.aggregate_type === "customer_claim"
        ? this._claimCase.get(event.aggregate_id)
        : streamCase(event.aggregate_type, event.aggregate_id, event.payload);
    for (const noticeId of event.source_notice_ids ?? []) {
      if (caseId) this._notices.set(`${caseId}|${noticeId}`, event);
    }
    return { duplicate: false, event };
  }

  nextVersion(aggregateId) {
    return (this._nextVersion.get(aggregateId) ?? 0) + 1;
  }

  eventsForCase(caseId) {
    return this.events.filter((e) => {
      if (e.aggregate_type === "closure_case") return e.aggregate_id === caseId;
      if (e.aggregate_type === "customer_claim") return this._claimCase.get(e.aggregate_id) === caseId;
      if (e.aggregate_type === "inventory_disposition") return e.aggregate_id === `inv::${caseId}`;
      if (e.aggregate_type === "settlement_payment") return e.aggregate_id === `pay::${caseId}`;
      return false;
    });
  }
}
