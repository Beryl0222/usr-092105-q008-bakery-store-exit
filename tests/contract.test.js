import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, EVENT_TYPES } from "../src/validator.js";

test("中文样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("信封缺字段与非法枚举给出中文错误", () => {
  assert.deepEqual(validateEvent({}), [
    "缺少字段：event_id",
    "缺少字段：event_type",
    "缺少字段：aggregate_type",
    "缺少字段：aggregate_id",
    "缺少字段：case_id",
    "缺少字段：occurred_at",
    "缺少字段：version",
    "缺少字段：summary",
    "缺少字段：payload",
  ]);
  assert.ok(validateEvent({
    event_id: "evt-x-0001",
    event_type: "NOT_A_TYPE",
    aggregate_type: "customer_claim",
    aggregate_id: "c1",
    case_id: "case-1",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "非法类型",
    payload: {},
  }).some((m) => m.includes("未知事件类型")));
});

test("付款流水不能挂到顾客权益聚合上", () => {
  const errors = validateEvent({
    event_id: "evt-x-0002",
    event_type: "PAYMENT_SETTLED",
    aggregate_type: "customer_claim",
    aggregate_id: "claim-1",
    case_id: "case-1",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "错挂的支付",
    payload: {},
  });
  assert.ok(errors.some((m) => m.includes("不能挂在聚合")));
});

test("事件类型集合与四类聚合保持稳定", () => {
  for (const t of ["CLOSURE_ANNOUNCED", "CLAIM_REGISTERED", "ORDER_TRANSFERRED", "INVENTORY_DISPOSED", "PAYMENT_SETTLED"]) {
    assert.ok(EVENT_TYPES.includes(t));
  }
});
