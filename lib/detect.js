/**
 * 检测器：纯函数，不碰 ctx、不写盘，方便直接 import() 单测。
 *
 * 三条信号，任一命中 = 1 次「疑似」：
 *   A：窗口内同一字符连续出现 ≥ signalA.run
 *   B：signalB.chars 里那些词在窗口内的总字数占窗口 > signalB.ratio，且总计数 > signalB.minCount
 *   C：窗口内任一长度 minGram..maxGram 的 n-gram 出现次数 ≥ signalC.repeat
 *
 * 触发：连续 `trigger.consecutive` 次疑似，或窗口内重复字符数 > `trigger.repeatChars`。
 * 触发后连续计数归零，避免同一 attempt 后续每帧都算一次触发。
 *
 * @module dsh-output-guard/detect
 */

const DEFAULT_SIGNAL_B_CHARS = ["好", "做", "嗯", "继续", "好的"];

/**
 * 信号 A 的默认排除集：**全部 ASCII 可打印字符 + 空白**。
 *
 * **为什么是这个范围**（2026-10-27 实测两轮代码、各 200+ 帧）：
 *
 * 第一版只排除排版字符（`-=*#_|~\`` + 空白），`dsh-flow` 的 1322 行代码 0 命中，
 * 但 `dsh-recall` 的 234 帧里还有 13 次命中，查出来两种：
 *   - `86400000` 末尾 5 个 `0`（真实代码里的常数）
 *   - 注释里的占位符 `s-xxxxxxxx`（8 个 `x`）
 * 两个都不是退化，是代码和注释的常态。
 *
 * 结论：**A 只对非 ASCII 字符（中文等）生效**。理由——模型退化解码刷的是「好」「做」「嗯」
 * 这类中文实义字（今晚那次事故就是「做」刷 12.7 万次）；ASCII 上的长连续串绝大多数是
 * 数字常数、占位符、分隔线。真要退化刷 `xxxx`、`----`，信号 C 的**连续重复**判据抓得住
 * （见 scanSignalC 的 v3）。
 *
 * 想放开就把这个值改窄（比如只留 `" \t\r\n"`），或者在 profile 里配 `signalA.ignore`。
 */
const DEFAULT_SIGNAL_A_IGNORE =
  " \t\r\n" +
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/** 缺字段取默认值：少传一个键不许抛错。 */
function normalizeThresholds(thresholds = {}) {
  const t = thresholds ?? {};
  return {
    windowChars: t.windowChars ?? 2000,
    signalA: {
      run: t.signalA?.run ?? 8,
      ignore:
        t.signalA?.ignore === undefined
          ? DEFAULT_SIGNAL_A_IGNORE
          : Array.isArray(t.signalA.ignore)
            ? t.signalA.ignore.join("")
            : String(t.signalA.ignore),
    },
    signalB: {
      chars: t.signalB?.chars ?? DEFAULT_SIGNAL_B_CHARS,
      ratio: t.signalB?.ratio ?? 0.15,
      // 2026-10-27 晚改：50 → 12。原因见本文件顶部「夹心式重复」注释——
      // 退化不一定刷成几百个，常见形态是「好。好。好。一句真话」反复夹，
      // 单次 attempt 的 reasoning 只有几十到一两百字，50 的门槛永远够不着。
      minCount: t.signalB?.minCount ?? 12,
    },
    signalC: {
      minGram: t.signalC?.minGram ?? 4,
      maxGram: t.signalC?.maxGram ?? 16,
      repeat: t.signalC?.repeat ?? 8,
    },
    trigger: {
      consecutive: t.trigger?.consecutive ?? 2,
      repeatChars: t.trigger?.repeatChars ?? 500,
    },
  };
}

/** 不传 state 时造一个一次性的；跨帧调用必须传同一个。 */
export function createState() {
  return {
    /** 最近 windowChars 个字符。 */
    window: "",
    /** 供跨帧观察：上一帧结尾字符与它连续的长度。 */
    lastChar: null,
    lastRun: 0,
    /** 连续疑似次数。 */
    suspiciousStreak: 0,
    /** 最近一次疑似命中的信号（repeatChars 单独触发时带上它）。 */
    lastSignal: null,
    /** 上次触发时的疑似计数，仅用于调试。 */
    triggers: 0,
  };
}

/**
 * 把窗口里属于「高频词」的字符位置标出来（长词优先，位置去重）。
 * B 的计数单位是「字」不是「次」：「好的」算 2 个字。
 */
function markSignalBChars(window, chars) {
  const marked = new Set();
  const counts = new Map();
  const words = [...chars].filter((w) => typeof w === "string" && w.length > 0).sort((a, b) => b.length - a.length);
  for (const word of words) {
    let n = 0;
    let idx = window.indexOf(word);
    while (idx !== -1) {
      for (let i = 0; i < word.length; i++) marked.add(idx + i);
      n += 1;
      idx = window.indexOf(word, idx + 1);
    }
    if (n > 0) counts.set(word, n);
  }
  return { marked, counts };
}

/**
 * A：同一字符连续 ≥ run。返回最大 run 与所有重复段的字符位置。
 * 直接扫整个窗口，跨帧连续段自然接上；窗口被截断时按截断后的窗口算（近似）。
 *
 * `ignore` 里的字符（默认是空白与 `-=*#_|~\`` 这类排版字符）**不参与连续段计数**：
 * 它们连续再多也只是格式，不是退化。理由见 DEFAULT_SIGNAL_A_IGNORE 的注释。
 */
function scanSignalA(window, run, ignore = "") {
  const marked = new Set();
  const ignored = new Set(ignore);
  let maxRun = 0;
  let maxChar = "";
  let i = 0;
  while (i < window.length) {
    if (ignored.has(window[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < window.length && window[j] === window[i]) j++;
    const len = j - i;
    if (len > maxRun) {
      maxRun = len;
      maxChar = window[i];
    }
    if (len >= run) for (let k = i; k < j; k++) marked.add(k);
    i = j;
  }
  return { hit: maxRun >= run, maxRun, maxChar, marked };
}

/**
 * C：窗口内存在某个长度 minGram..maxGram 的 n-gram，**连续重复** ≥ repeat 次。
 *
 * **三次改出来的判据，每次都拿真实代码实测过**（2026-10-27，`dsh-flow/lib/index.js`，210 帧）：
 *
 *   v1「窗口内任一 n-gram 出现 ≥ repeat 次」（重叠计数）→ **210 帧 210 命中，100% 误报**。
 *   v2 改不重叠计数 + 跳过纯空白 → 58 帧命中，**剩下的全是 C**，第一次落在代码里的正则
 *      `/^[ \t]{0,3}(`{3,}|~{3,})/`。缩进、`const `、`return` 这些在 2000 字符窗口里
 *      重复 8 次太正常——**判据本身就不对**。
 *   v3（本版）改成「**连续**重复」：退化解码的特征是同一段**紧挨着**刷几千次
 *      （`做做做做做`、`好的好的好的`），不是「分散出现 8 次」。分散出现是自然语言和代码的常态。
 *
 * 另外两条约束保留：
 *   - **不重叠**：游标每次前进 L，否则 `    ` 一段缩进能数出几百次。
 *   - **跳过纯空白 n-gram**：缩进本身就是最强的「重复」，但它不是退化。
 *
 * 2026-10-28 改：**命中时把重复段的位置标进 `marked`**。
 * 原版一命中就 `return true`，位置一个没记，于是 `detect()` 算 `repeatChars` 时只能并
 * A∪B 的位置——C 单独触发时 `repeatChars` 恒为 0。实测 2026-10-27 的 245 条 trigger 里
 * 230 条是 C，那批数据的 `repeatRate` 全是假的（171 条 rate < 0.1，其中还有 0）。
 */
function scanSignalC(window, { minGram, maxGram, repeat }, marked) {
  const length = window.length;
  let best = { gram: "", gramLen: 0, repeat: 0 };
  if (length === 0) return { hit: marked.size > 0, ...best };
  // 连续重复 repeat 次至少需要 L*repeat 个字符，短窗口直接跳过。
  const maxL = Math.min(maxGram, Math.floor(length / repeat));
  let hit = false;
  const markRun = (start, blocks, L) => {
    if (blocks < repeat) return false;
    const s = Math.max(start, 0);
    const end = Math.min(start + blocks * L, length);
    for (let k = s; k < end; k++) marked.add(k);
    // 记「覆盖字符最多」的那一段，作为这一帧的形态样本。
    if (!best.gramLen || blocks * L > best.repeat * best.gramLen) {
      best = { gram: window.slice(s, s + L), gramLen: L, repeat: blocks };
    }
    return true;
  };
  for (let L = minGram; L <= maxL; L++) {
    let runStart = -1;
    let blocks = 0;
    for (let i = 0; i + L <= length; i += L) {
      const prev = i >= L ? window.slice(i - L, i) : null;
      const cur = window.slice(i, i + L);
      if (prev !== null && cur === prev && cur.trim() !== "") {
        if (blocks === 0) {
          runStart = i - L;
          blocks = 2;
        } else {
          blocks += 1;
        }
      } else {
        if (markRun(runStart, blocks, L)) hit = true;
        runStart = -1;
        blocks = 0;
      }
    }
    if (markRun(runStart, blocks, L)) hit = true;
  }
  return { hit, ...best };
}

/**
 * @param {string} text 一段 delta 文本（reasoning-delta）
 * @param {object} [thresholds] 阈值；缺字段取默认值
 * @param {object} [state] 跨帧状态；不传则本次调用一次性使用
 * @returns {{hit:boolean, signal:"A"|"B"|"C"|null, repeatRate:number, repeatChars:number}}
 */
export function detect(text, thresholds, state) {
  const th = normalizeThresholds(thresholds);
  const s = state ?? createState();

  if (typeof text !== "string" || text.length === 0) {
    // 空串：跳过，不更新 lastChar / lastRun，也不动窗口。
    return { hit: false, signal: null, repeatRate: 0, repeatChars: 0 };
  }

  s.window = (s.window + text).slice(-th.windowChars);

  // lastChar / lastRun：窗口末尾字符与它连续的长度（观察值；A 的判定直接扫整个窗口，
  // 跨帧连续段天然接上，不依赖这两个值）。
  const tail = s.window.slice(-1);
  let tailRun = 1;
  while (tailRun < s.window.length && s.window[s.window.length - 1 - tailRun] === tail) tailRun += 1;
  s.lastChar = tail;
  s.lastRun = tailRun;

  const windowLen = s.window.length;

  const sigA = scanSignalA(s.window, th.signalA.run, th.signalA.ignore);
  const sigB = markSignalBChars(s.window, th.signalB.chars);
  const markedB = sigB.marked;
  const bCount = markedB.size;
  // 2026-10-27 晚改：分母从「含空白的窗口长度」改成「非空白字符数」。
  // 退化的典型形态是「好。\n\n好。\n\n」，换行占了一半字符，按含空白算永远到不了 0.15，
  // 于是明明一半思考是填充词也判不出来（实测 9.3% vs 实际近两成）。语义上也该是
  // 「这些字里有多少是填充」，空白不算字。
  const nonSpaceLen = s.window.replace(/\s/g, "").length;
  const bHit = bCount > th.signalB.minCount && nonSpaceLen > 0 && bCount / nonSpaceLen > th.signalB.ratio;

  // 重复字符 = A 的连续段 ∪ B 的高频字 ∪ C 的连续重复段，按位置去重。
  // C 必须传 repeatPositions 进去——它自己知道哪段在重复，不传就白算（见 scanSignalC 注释）。
  const repeatPositions = new Set(sigA.marked);
  for (const pos of markedB) repeatPositions.add(pos);
  const sigC = scanSignalC(s.window, th.signalC, repeatPositions);
  const repeatChars = repeatPositions.size;
  const repeatRate = windowLen === 0 ? 0 : Number((repeatChars / windowLen).toFixed(4));

  let signal = null;
  if (sigA.hit) signal = "A";
  else if (bHit) signal = "B";
  else if (sigC.hit) signal = "C";

  // 命中形态：给「一周后定阈值」留可判形态的证据。这里是原文，脱敏在落盘时做（maskSample）。
  let sample = null;
  if (signal === "A") {
    sample = { signal: "A", char: sigA.maxChar, run: sigA.maxRun };
  } else if (signal === "B") {
    let topWord = "";
    let topCount = 0;
    for (const [w, n] of sigB.counts) {
      if (n > topCount) {
        topWord = w;
        topCount = n;
      }
    }
    sample = { signal: "B", word: topWord, count: topCount, chars: bCount };
  } else if (signal === "C") {
    sample = { signal: "C", gram: sigC.gram, gramLen: sigC.gramLen, repeat: sigC.repeat };
  }

  const suspicious = signal !== null;
  s.suspiciousStreak = suspicious ? s.suspiciousStreak + 1 : 0;
  if (suspicious) s.lastSignal = signal;

  const triggeredByStreak = s.suspiciousStreak >= th.trigger.consecutive;
  const triggeredByChars = repeatChars > th.trigger.repeatChars;
  const triggered = triggeredByStreak || triggeredByChars;

  if (triggered) {
    s.triggers += 1;
    // 触发后归零：同一 attempt 后续再走 consecutive 次疑似才可能再触发。
    s.suspiciousStreak = 0;
  }

  return {
    // hit = 本次命中任一信号（1 次疑似）；是否「记触发」看 triggered。
    hit: suspicious,
    signal: suspicious ? signal : triggered ? s.lastSignal ?? null : null,
    repeatRate,
    repeatChars,
    triggered,
    // 命中形态（原文）。落盘前必须过 maskSample。
    sample,
  };
}

/**
 * 命中形态的脱敏。**只放得进 events.jsonl 的东西才叫「能落盘」**。
 *
 * 为什么必须脱敏：`sample` 里是 reasoning 的一小段（4~16 字 n-gram，或一个填充字），
 * 而 reasoning 里会出现主人的路径、别的会话 id、邮箱、密钥、长数字。这一段虽短，
 * 但缩到 4 个字就够撞上「D:\」这种开头，不处理就是往日志里写私人信息。
 *
 * 脱敏只替换**有明确形状**的东西，不做泛化删除——泛化会让 sample 全变 `<MASK>`，
 * 那就白存了。形状不认识的短文本原样留（它本来就只有几个字）。
 */
export function maskSample(sample) {
  if (!sample || typeof sample !== "object") return null;
  const out = { ...sample };
  for (const key of ["char", "word", "gram"]) {
    if (typeof out[key] === "string") out[key] = maskText(out[key]);
  }
  return out;
}

function maskText(text) {
  return String(text)
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "<PATH>")
    .replace(/\bsession-[0-9a-f]{8}[0-9a-f-]*/gi, "<SID>")
    // 邮箱不能只认 ASCII：`\w` 不含中文，`主人@example.com` 会漏。按「@ 两侧的非空白」判。
    .replace(/[^\s@]{1,64}@[^\s@]{1,64}\.[^\s@]{1,64}/g, "<EMAIL>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/\b(?:sk-|gho_|ghp_|ghu_|ghs_|xox[bpa]-)[A-Za-z0-9_-]{8,}/g, "<KEY>")
    .slice(0, 32);
}
