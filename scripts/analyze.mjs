#!/usr/bin/env node
/**
 * 输出守卫数据分析。给「一周后定阈值」用。
 *
 * 只读 events.jsonl，不改任何东西，不联网。
 *
 * 用法：
 *   node scripts/analyze.mjs                      # 默认读 ~/.dsh/output-guard/events.jsonl
 *   node scripts/analyze.mjs <path>               # 指定文件
 *   node scripts/analyze.mjs <path> --json        # 出 JSON，给别的脚本吃
 *
 * 设计上守一条：**只给数，不替人下结论。** 报告的最后一节只列「要回答的问题」
 * 和「回答它需要看哪个数」，不写「建议把阈值改成 X」——那要人看着 sample 判。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const fileArg = args.find((a) => !a.startsWith("--"));
const FILE = fileArg ?? path.join(os.homedir(), ".dsh", "output-guard", "events.jsonl");

if (!fs.existsSync(FILE)) {
  console.error(`找不到文件：${FILE}`);
  process.exit(1);
}

const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);
const rows = [];
let blank = 0;
const badLines = [];

lines.forEach((line, i) => {
  if (!line.trim()) {
    blank += 1;
    return;
  }
  try {
    rows.push(JSON.parse(line));
  } catch (e) {
    badLines.push({ line: i + 1, err: e.message, head: line.slice(0, 80) });
  }
});

// ---------------------------------------------------------------------------
// 分版本
//
// 0.1.3 之前 `repeatChars` 只并了 A 和 B 的位置，C 一个没算。而 C 占九成以上的
// 触发。所以那批行的 repeatRate / repeatChars **整列不可用**，只能看次数。
// 混在一起算会把「字段算错」当成「阈值合理」。
// ---------------------------------------------------------------------------

const TRUSTWORTHY_FROM = [0, 1, 3]; // 0.1.3 起 repeatChars 可信

function verNum(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function verAtLeast(v, min) {
  const a = verNum(v);
  if (!a) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== min[i]) return a[i] > min[i];
  }
  return true;
}

const byVersion = new Map();
for (const r of rows) {
  const v = r.pluginVersion ?? "(无版本字段)";
  if (!byVersion.has(v)) byVersion.set(v, []);
  byVersion.get(v).push(r);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function quantiles(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const q = (p) => {
    if (s.length === 1) return s[0];
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return {
    n: s.length,
    min: s[0],
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    max: s[s.length - 1],
  };
}

const r2 = (x) => (x === null || x === undefined ? "-" : Math.round(x * 10000) / 10000);

function hist(nums, edges) {
  const buckets = new Array(edges.length + 1).fill(0);
  for (const n of nums) {
    let i = 0;
    while (i < edges.length && n >= edges[i]) i += 1;
    buckets[i] += 1;
  }
  const labels = [];
  for (let i = 0; i <= edges.length; i += 1) {
    const lo = i === 0 ? "-∞" : String(edges[i - 1]);
    const hi = i === edges.length ? "+∞" : `<${edges[i]}`;
    labels.push(`${lo} ${hi}`);
  }
  const total = nums.length || 1;
  return labels.map((lab, i) => ({
    label: lab,
    count: buckets[i],
    pct: Math.round((buckets[i] / total) * 1000) / 10,
  }));
}

// 触发形态的指纹：同一形态归一类。
// A: 哪个字；B: 哪个词；C: gram 本身（去掉首尾空白方便归并）。
function sampleKey(s) {
  if (!s || typeof s !== "object") return null;
  if (s.signal === "A") return `A|${s.char ?? "?"}|run>=${s.run ?? "?"}`;
  if (s.signal === "B") return `B|${s.word ?? "?"}|x${s.count ?? "?"}`;
  if (s.signal === "C") {
    const g = String(s.gram ?? "");
    const named = g
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `C|${JSON.stringify(named)}|len=${s.gramLen ?? "?"}|x${s.repeat ?? "?"}`;
  }
  return `${s.signal ?? "?"}|${JSON.stringify(s).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const report = {
  file: FILE,
  bytes: fs.statSync(FILE).size,
  lines: lines.length,
  blankLines: blank,
  parsed: rows.length,
  badLines,
  versions: {},
  untrustworthyNote: "0.1.3 之前的 repeatRate / repeatChars 不可用（C 的字符没算进分母），只看次数。",
};

for (const [v, rs] of [...byVersion.entries()].sort()) {
  const triggers = rs.filter((r) => r.type === "trigger");
  const settles = rs.filter((r) => r.type === "settle");
  const summaries = rs.filter((r) => r.type === "summary");
  const trusted = verAtLeast(v, TRUSTWORTHY_FROM);

  const sigCount = {};
  for (const t of triggers) sigCount[t.signal ?? "?"] = (sigCount[t.signal ?? "?"] ?? 0) + 1;

  // settle 配对：靠 turn + attemptId。同一 turn 多个 step 就有多行，都要对。
  const settleKey = new Set(settles.map((s) => `${s.turn}|${s.attemptId}`));
  const paired = triggers.filter((t) => settleKey.has(`${t.turn}|${t.attemptId}`)).length;

  const withSample = triggers.filter((t) => t.sample).length;

  // 形态归类
  const shapes = new Map();
  for (const t of triggers) {
    const k = sampleKey(t.sample);
    if (!k) continue;
    if (!shapes.has(k)) shapes.set(k, []);
    shapes.get(k).push(t);
  }
  const shapeList = [...shapes.entries()]
    .map(([k, ts]) => ({
      key: k,
      count: ts.length,
      sessions: [...new Set(ts.map((t) => String(t.sessionId ?? "").slice(8, 16)))],
      rates: ts.map((t) => t.repeatRate).filter((x) => typeof x === "number"),
    }))
    .sort((a, b) => b.count - a.count);

  const rates = triggers.map((t) => t.repeatRate).filter((x) => typeof x === "number");
  const finalChars = settles.map((s) => s.roundFinalChars).filter((x) => typeof x === "number");

  report.versions[v] = {
    trusted,
    summary: summaries.length,
    trigger: triggers.length,
    settle: settles.length,
    triggerPaired: paired,
    withSample,
    signals: sigCount,
    rateQuantiles: trusted ? quantiles(rates) : null,
    rateHistogram: trusted ? hist(rates, [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) : null,
    finalCharsQuantiles: trustSafe(finalChars),
    shapes: shapeList.slice(0, 12).map((s) => ({
      shape: s.key,
      count: s.count,
      sessions: s.sessions,
      rateP50: quantiles(s.rates)?.p50 ?? null,
    })),
    shapeTotal: shapeList.length,
  };
}

// settle 的 roundFinalChars 不受 repeatChars 那个 bug 影响，各版本都能看。
function trustSafe(nums) {
  return quantiles(nums);
}

// 跨版本总览：哪些轮触发了、每轮几次
const turns = new Map();
for (const r of rows) {
  if (r.type !== "trigger") continue;
  const k = `${r.sessionId ?? "?"}|${r.turn}`;
  turns.set(k, (turns.get(k) ?? 0) + 1);
}
report.turns = {
  withTrigger: turns.size,
  distribution: (() => {
    const counts = [...turns.values()];
    const h = {};
    for (const c of counts) h[c] = (h[c] ?? 0) + 1;
    return h;
  })(),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 人读版
// ---------------------------------------------------------------------------

const L = [];
const push = (s = "") => L.push(s);

push("");
push("输出守卫数据分析");
push("==================");
push(`文件    ${FILE}`);
push(`大小    ${(report.bytes / 1024).toFixed(0)} KB`);
push(`行数    ${report.lines}（空行 ${report.blankLines}，解析成功 ${report.parsed}，坏行 ${badLines.length}）`);
if (badLines.length) {
  push("");
  push("坏行：");
  for (const b of badLines.slice(0, 10)) push(`  第 ${b.line} 行  ${b.err}  开头 ${JSON.stringify(b.head)}`);
}
push("");
push(`注意：${report.untrustworthyNote}`);
push("");

for (const [v, s] of Object.entries(report.versions)) {
  const tag = s.trusted ? "rate 可信" : "rate 不可信";
  push(`--- 版本 ${v}（${tag}）---`);
  push(`  summary ${s.summary} / trigger ${s.trigger} / settle ${s.settle}`);
  if (s.trigger) {
    push(`  settle 配对 ${s.triggerPaired}/${s.trigger}${s.triggerPaired < s.trigger ? "  ← 有触发没结算" : ""}`);
    push(`  带 sample ${s.withSample}/${s.trigger}`);
    push(`  信号分布 ${JSON.stringify(s.signals)}`);
  }
  if (s.rateQuantiles) {
    const q = s.rateQuantiles;
    push(`  rate 分位 n=${q.n}  最小 ${r2(q.min)}  p10 ${r2(q.p10)}  p25 ${r2(q.p25)}  p50 ${r2(q.p50)}  p75 ${r2(q.p75)}  p90 ${r2(q.p90)}  最大 ${r2(q.max)}`);
    push("  rate 直方图");
    for (const b of s.rateHistogram) {
      const bar = "#".repeat(Math.min(40, Math.round(b.pct / 2)));
      push(`    ${b.label.padEnd(10)} ${String(b.count).padStart(5)}  ${String(b.pct).padStart(5)}%  ${bar}`);
    }
  }
  if (s.finalCharsQuantiles) {
    const q = s.finalCharsQuantiles;
    push(`  roundFinalChars n=${q.n}  p10 ${q.p10}  p50 ${q.p50}  p90 ${q.p90}  最大 ${q.max}`);
  }
  if (s.shapes.length) {
    push(`  触发形态（共 ${s.shapeTotal} 种，列前 ${s.shapes.length}）`);
    for (const sh of s.shapes) {
      push(`    ${String(sh.count).padStart(5)} 次  rate中位 ${r2(sh.rateP50)}  ${sh.shape}`);
      push(`            会话 ${sh.sessions.slice(0, 4).join(", ")}`);
    }
  }
  push("");
}

push("--- 跨版本总览 ---");
push(`  有触发的轮数 ${report.turns.withTrigger}`);
push(`  每轮触发次数分布 ${JSON.stringify(report.turns.distribution)}`);
push("");
push("--- 要回答的问题（这里只列问题，不替你下结论）---");
push("");
push("1. 误报率是多少？");
push("   看：各版本的「触发形态」列表，逐条判断那是不是真退化。");
push("   有 sample 的行能直接判；0.1.4 之前的行没有 sample，只能捞原文。");
push("");
push("2. 阈值该定在哪？");
push("   看：rate 直方图 + 触发形态。真退化应该聚在高 rate 那一端；");
push("   如果高 rate 那头是一堆正常代码，说明判据本身认错了东西，调阈值没用。");
push("");
push("3. 触发有没有影响产出？");
push("   看：roundFinalChars 的分位。拿它跟「没触发的轮」比——这里只统计了触发的轮，");
push("   没触发的要另外从会话存档取，别拿这份报告的数直接下结论。");
push("");
push("4. 哪种形态占比最大？");
push("   看：触发形态列表第一行。如果它是个奇怪的短片段，先想想为什么它会被判成重复。");
push("");
push("已知的洞都堵了，不等于穷尽。");
push("");

console.log(L.join("\n"));
