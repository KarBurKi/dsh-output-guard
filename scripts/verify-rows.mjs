// 0.1.6 验证：summary / trigger / settle 三种行都得带 pluginVersion，
// settle 还要带 sessionId。伪造 ctx + agent 跑一轮真帧，看落盘的 JSONL。
//
// 只写 /tmp 下的临时文件，不碰真 events.jsonl。

import fs from "node:fs";

const OUT = "/tmp/og-016.jsonl";
process.env.DSH_OUTPUT_GUARD_EVENTS_FILE = OUT;
fs.rmSync(OUT, { force: true });

const { apply, VERSION } = await import(
  "file:///C:/Users/41806/.dsh/plugins/dsh-output-guard/lib/index.js"
);

const top = {};
apply({ on(ev, fn) { top[ev] = fn; } }, { enabled: true });

const ag = {};
const session = { id: "session-verify016" };
const agent = {
  id: "session-verify016",
  session,
  ctx: {
    effect(fn) { return fn(); },
    on(ev, fn) { ag[ev] = fn; return () => {}; },
  },
};

top["agent/created"]({ agent });

// 第 1 轮：造 C 信号退化（4 字片段连续重复 60 次）
ag["agent/assistant-stream"]({ frame: { type: "start", attemptId: "a1", revision: 0, turn: 5, step: 1 } });
for (let i = 0; i < 60; i += 1) {
  ag["agent/assistant-stream"]({
    frame: {
      type: "chunk", attemptId: "a1", revision: 0, index: i, time: 0,
      chunk: { type: "reasoning-delta", text: "做。\n\n" },
    },
  });
}
ag["agent/assistant-stream"]({ frame: { type: "end", attemptId: "a1", revision: 0, index: 60, outcome: {} } });
ag["session/event"](session, { type: "turn/end", data: { turn: 5, reason: { kind: "stop" } } });

// 第 2 轮：正常文本，不该触发，但要有一行 summary
ag["agent/assistant-stream"]({ frame: { type: "start", attemptId: "a2", revision: 0, turn: 6, step: 1 } });
ag["agent/assistant-stream"]({
  frame: {
    type: "chunk", attemptId: "a2", revision: 0, index: 0, time: 0,
    chunk: { type: "reasoning-delta", text: "读插件目录，看 package.json 里的版本号和 lib 下的文件。" },
  },
});
ag["agent/assistant-stream"]({ frame: { type: "end", attemptId: "a2", revision: 0, index: 1, outcome: {} } });
ag["session/event"](session, { type: "turn/end", data: { turn: 6, reason: { kind: "stop" } } });

// --- 断言 ---
const rows = fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  OK  " : "  FAIL"}  ${msg}`);
  if (!ok) fail += 1;
};

console.log(`版本常量 VERSION = ${VERSION}`);
console.log(`落盘 ${rows.length} 行\n`);

const byType = (t) => rows.filter((r) => r.type === t);
check(byType("summary").length === 2, `summary 两行（实际 ${byType("summary").length}）`);
check(byType("trigger").length === 1, `trigger 一行（实际 ${byType("trigger").length}）`);
check(byType("settle").length === 1, `settle 一行（实际 ${byType("settle").length}）`);

for (const t of ["summary", "trigger", "settle"]) {
  for (const r of byType(t)) {
    check(r.pluginVersion === VERSION, `${t} 带 pluginVersion=${VERSION}（实际 ${JSON.stringify(r.pluginVersion)}）`);
    check(typeof r.sessionId === "string" && r.sessionId === "session-verify016", `${t} 带 sessionId（实际 ${JSON.stringify(r.sessionId)}）`);
  }
}

const settle = byType("settle")[0];
check(settle?.turn === 5, `settle turn=5（实际 ${settle?.turn}）`);
check(typeof settle?.roundFinalChars === "number" && settle.roundFinalChars > 0, `settle roundFinalChars 非空（实际 ${settle?.roundFinalChars}）`);

const normalSummary = byType("summary").find((r) => r.turn === 6);
check(normalSummary?.triggers === 0, `第 2 轮 triggers=0（实际 ${normalSummary?.triggers}）`);

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
