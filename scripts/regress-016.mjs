// 0.1.6 回归：0.1.5 验过的东西一条都不许退。
// 1) 六份真代码文档的误报必须还是 0
// 2) 真退化样本必须还触发（次数只许多不许少）
// 3) enabled 类型校验不变

import fs from "node:fs";

const { detect, createState, maskSample } = await import(
  "file:///C:/Users/41806/.dsh/plugins/dsh-output-guard/lib/detect.js"
);
const { validateConfig } = await import(
  "file:///C:/Users/41806/.dsh/plugins/dsh-output-guard/lib/index.js"
);

const TH = {
  windowChars: 2000,
  signalA: { run: 8 },
  signalB: { chars: ["好", "做", "嗯", "继续", "好的"], ratio: 0.15, minCount: 12 },
  signalC: { minGram: 4, maxGram: 16, repeat: 8 },
  trigger: { consecutive: 2, repeatChars: 500 },
};

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  OK  " : "  FAIL"}  ${msg}`);
  if (!ok) fail += 1;
};

// --- 1) 误报复查 ---
const docs = [
  ["detect.js 自己", "C:/Users/41806/.dsh/plugins/dsh-output-guard/lib/detect.js"],
  ["index.js 自己", "C:/Users/41806/.dsh/plugins/dsh-output-guard/lib/index.js"],
  ["dsh-flow", "D:/DSH/.dsh/plugins/dsh-flow/lib/index.js"],
  ["dsh-recall", "D:/DSH/.dsh/plugins/dsh-recall/lib/index.js"],
  ["dsh-theater", "D:/DSH/.dsh/plugins/dsh-theater/lib/index.js"],
  ["执行书", "D:/【欧鲸鲸的工作室】/【文档区】/计划与任务/执行书_输出守卫_NA_20261027.md"],
];

console.log("=== 1) 正常代码/文档的误报 ===");
for (const [name, p] of docs) {
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    console.log(`  SKIP  ${name}（读不到：${e.code}）`);
    continue;
  }
  const state = createState();
  let hits = 0;
  for (let i = 0; i < text.length; i += 500) {
    const r = detect(text.slice(i, i + 500), TH, state);
    if (r.triggered) hits += 1;
  }
  check(hits === 0, `${name} 触发 ${hits} 次（要求 0）`);
}

// --- 2) 真退化回放 ---
console.log("\n=== 2) 真退化回放 ===");
const SAMPLE = "D:/【欧鲸鲸的工作室】/【临时文件区】/da88ea98-t377-reasoning.txt";
if (fs.existsSync(SAMPLE)) {
  const text = fs.readFileSync(SAMPLE, "utf8");
  const state = createState();
  let triggers = 0;
  const sig = {};
  for (let i = 0; i < text.length; i += 200) {
    const r = detect(text.slice(i, i + 200), TH, state);
    if (r.triggered) {
      triggers += 1;
      sig[r.signal] = (sig[r.signal] ?? 0) + 1;
    }
  }
  console.log(`  样本 ${text.length} 字符`);
  check(triggers >= 112, `触发 ${triggers} 次（0.1.5 是 112，要求 >=112）`);
  console.log(`  信号分布 ${JSON.stringify(sig)}`);
} else {
  console.log(`  SKIP  样本不在：${SAMPLE}`);
}

// --- 3) enabled 类型校验 ---
console.log("\n=== 3) enabled 类型校验 ===");
const okCases = [true, false];
for (const v of okCases) {
  let threw = null;
  try { validateConfig({ enabled: v }); } catch (e) { threw = e; }
  check(threw === null, `enabled: ${JSON.stringify(v)} 通过`);
}
const badCases = ["false", "true", 1, 0];
for (const v of badCases) {
  let threw = null;
  try { validateConfig({ enabled: v }); } catch (e) { threw = e; }
  check(threw !== null, `enabled: ${JSON.stringify(v)} 抛错（${threw ? threw.message.slice(0, 60) : "没抛"}）`);
}

// --- 4) 三种信号各自能抓 ---
// 注意两件事，都是第一次写用例时踩的：
//   a. `trigger.consecutive: 2` 要求连续两帧疑似才置 triggered，单帧只到 hit。
//   b. 信号顺序是 A → B → C，B 会抢在 C 前面。「做」「好」在 B 的词表里，
//      拿它们造 C 的样本会先被 B 抓住（40 个「做」占非空白 50% > 15%）。
//      所以 A 用不在词表里的字，C 用不含废词的片段。
console.log("\n=== 4) 三种信号 ===");
const cases = [
  ["A 单字连续", "鲸".repeat(400), "A"],
  ["B 词霸占", "好的".repeat(300), "B"],
  ["C 片段连续", "一二三四五。\n\n".repeat(60), "C"],
];
for (const [name, text, want] of cases) {
  const state = createState();
  let got = null;
  for (let i = 0; i < text.length; i += 200) {
    const r = detect(text.slice(i, i + 200), TH, state);
    if (r.triggered) { got = r.signal; break; }
  }
  check(got === want, `${name} → ${got}（期望 ${want}）`);
}

// --- 5) 正常文本不触发 ---
console.log("\n=== 5) 正常文本 ===");
const normals = [
  "读插件目录，看 package.json 里的版本号和 lib 下的文件。",
  "The quick brown fox jumps over the lazy dog. This is a normal English sentence.",
  "",
];
for (const t of normals) {
  const state = createState();
  const r = detect(t, TH, state);
  check(r.hit === false, `${JSON.stringify(t.slice(0, 30))} hit=${r.hit}`);
}

// --- 6) sample 脱敏 ---
console.log("\n=== 6) sample 脱敏 ===");
const masked = maskSample({ signal: "A", char: "D:\\secret\\path", run: 9 });
check(masked.char === "<PATH>", `路径脱敏（实际 ${JSON.stringify(masked.char)}）`);
const maskedH = maskSample({ signal: "C", gram: "做。", gramLen: 4, repeat: 38 });
check(maskedH.gram === "做。", `普通汉字原样保留（实际 ${JSON.stringify(maskedH.gram)}）`);

console.log(`\n${fail === 0 ? "回归全过" : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
