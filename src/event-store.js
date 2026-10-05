// 只追加事件存储：
// - 同一聚合的 version 必须从 1 连续递增；
// - event_id 全局唯一，重复提交返回既有事件（来源系统重试安全）；
// - source_notice_id 用于吸收各方重复通知（同一案件 + 同一通知标识只入库一次）；
// - 可选 JSONL 文件持久化，重启后按序回放。
// 本模块不做业务守卫，业务守卫见 engine.js。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { validateEvent } from "./validator.js";

export class EventStore {
  constructor({ file } = {}) {
    this.file = file;
    /** @type {Array<object>} */
    this.events = [];
    this.byEventId = new Map();
    this.noticeIndex = new Map(); // `${case_id}|${source_notice_id}` -> event
    /** 每个聚合的当前版本与所属案件 */
    this.aggregates = new Map(); // aggregate_id -> {version, case_id, type}
    if (file && existsSync(file)) this.#load();
  }

  #load() {
    const text = readFileSync(this.file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.#ingest(JSON.parse(line), { replay: true });
    }
  }

  #ingest(event, { replay }) {
    if (this.byEventId.has(event.event_id)) {
      return { status: "duplicate", event: this.byEventId.get(event.event_id) };
    }
    if (event.source_notice_id) {
      const key = `${event.case_id}|${event.source_notice_id}`;
      if (this.noticeIndex.has(key)) {
        return { status: "duplicate_notice", event: this.noticeIndex.get(key) };
      }
    }

    const agg = this.aggregates.get(event.aggregate_id);
    if (agg) {
      if (agg.case_id !== event.case_id) {
        throw new Error(`聚合 ${event.aggregate_id} 已属于案件 ${agg.case_id}，不能挂到 ${event.case_id}`);
      }
      if (agg.type !== event.aggregate_type) {
        throw new Error(`聚合 ${event.aggregate_id} 的类型不能改变`);
      }
      if (event.version !== agg.version + 1) {
        throw new Error(
          `聚合 ${event.aggregate_id} 版本冲突：期望 v${agg.version + 1}，收到 v${event.version}`,
        );
      }
      agg.version += 1;
    } else {
      if (event.version !== 1) {
        throw new Error(`新聚合 ${event.aggregate_id} 首事件版本必须是 1，收到 v${event.version}`);
      }
      this.aggregates.set(event.aggregate_id, {
        version: 1,
        case_id: event.case_id,
        type: event.aggregate_type,
      });
    }

    this.events.push(event);
    this.byEventId.set(event.event_id, event);
    if (event.source_notice_id) {
      this.noticeIndex.set(`${event.case_id}|${event.source_notice_id}`, event);
    }
    if (!replay && this.file) {
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    }
    return { status: "appended", event };
  }

  /**
   * 追加一条事件。信封不合法时抛出含中文原因的错误。
   * 重复 event_id / 重复 source_notice_id 一律返回既有事件，不产生新流水。
   */
  append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件校验失败：${errors.join("；")}`);
    return this.#ingest(event, { replay: false });
  }

  /** 按事件标识查找既有事件（用于来源系统重试时直接返回原记录）。 */
  findEvent(eventId) {
    return this.byEventId.get(eventId) ?? null;
  }

  /** 按外部通知标识查找已吸收的事件。 */
  findNotice(caseId, sourceNoticeId) {
    return this.noticeIndex.get(`${caseId}|${sourceNoticeId}`) ?? null;
  }

  /** 读取某案件的全部事件，按追加顺序返回（副本，避免外部篡改）。 */
  forCase(caseId) {
    return this.events.filter((e) => e.case_id === caseId).map((e) => structuredClone(e));
  }

  /** 读取单个聚合的版本流。 */
  stream(aggregateId) {
    return this.events.filter((e) => e.aggregate_id === aggregateId).map((e) => structuredClone(e));
  }
}

/**
 * 由外部通知派生确定性事件标识：来源系统重试、微信/短信/对账单重复推送时，
 * 只要通知标识不变，派生结果就不变，配合 source_notice_id 实现只吸收一次。
 */
export function deriveEventId(prefix, caseId, sourceNoticeId) {
  const raw = `evt-${prefix}-${caseId}-${sourceNoticeId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  // 超长时截断并追加哈希后缀，避免不同通知标识被截成同一事件标识。
  if (raw.length <= 110) return raw;
  let hash = 5381;
  for (const ch of raw) hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
  return `${raw.slice(0, 100)}-${hash.toString(36).padStart(7, "0")}`;
}
