import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("中文样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件类型必须落在四个既有聚合内", () => {
  const base = {
    event_id: "evt-legal-0001",
    event_type: "CLAIM_REGISTERED",
    aggregate_type: "closure_case",
    aggregate_id: "c1",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "错误归属",
  };
  const errors = validateEvent(base);
  assert.ok(errors.some((e) => e.includes("只能归属聚合 customer_claim")));
});

test("缺少 payload 必填字段给出中文错误", () => {
  const errors = validateEvent({
    event_id: "evt-legal-0002",
    event_type: "CLOSURE_ANNOUNCED",
    aggregate_type: "closure_case",
    aggregate_id: "c1",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "公告",
    payload: { store_name: "店" },
  });
  assert.ok(errors.some((e) => e.includes("notice_channels")));
  assert.ok(errors.some((e) => e.includes("choice_deadline")));
});
