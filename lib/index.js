/**
 * 输出守卫（灰模式 / Host 半）。
 *
 * 本版**不中止任何一轮**：只监听 `agent/assistant-stream` 与 `session/event`，
 * 把每轮的思考量、最严重重复率、触发信号写进
 * `%USERPROFILE%\.dsh\output-guard\events.jsonl`，供一周后定阈值。
 *
 * 打点一律用 `console.info` / `console.error`：产品 profile 下插件的 logger 不落盘
 * （见 dsh-llm-retry 源码注释：product profiles mount no console exporter），
 * 写进去等于没写；宿主 stdout 会被 restart 脚本捕获进 tmp_all\host-out-*.log。
 *
 * @module dsh-output-guard
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detect, createState, maskSample } from "./detect.js";

export const name = "output-guard";

/** 不依赖任何 host 服务：只接事件、只写文件，缺服务也不该阻止插件挂载。 */
export const inject = [];

export const VERSION = "0.1.5";

/** 信号 B 的默认高频字/词（需求§四），单位是「字」不是「次」。 */
const DEFAULT_SIGNAL_B_CHARS = ["好", "做", "嗯", "继续", "好的"];

/**
 * 默认阈值。全部可在 profile 里覆盖，一个都不写死在调用点（E7）。
 * 这些默认值是从需求§四与卡头抄来的，**没有一个是实测调过的**——灰模式一周的数据
 * 就是为了回头验这些数。
 *
 * **为什么这里不用 `@deepseek-ai/schemastery` 定义 Config**（2026-10-27 实测）：
 * 本插件以 `link:` 装进 profile，解析域里没有 `@deepseek-ai/*` 核心包，`import` 直接
 * `ERR_MODULE_NOT_FOUND`。`dsh-llm-retry` 能用 schemastery 是因为它打包在 app.asar 里、
 * 跟核心包同处一个解析域。本地插件目录下所有插件（dsh-recall / dsh-theater / dsh-qoder-agent）
 * 都是零依赖，文件头写着同一句「不 import 任何 @deepseek-ai/* 核心包」。
 */
const DEFAULTS = {
  enabled: true,
  disabledSessions: [],
  windowChars: 2000,
  // run 5 → 8（2026-10-28，测试 独立验收 报的误报）。
  // run=5 会打中「注释里引用退化形态」的代码：`detect.js` 自己 7 次、执行书 26 次，
  // 命中的全是 `做做做做做` 这种被引用的例子，不是退化输出。实测提到 8：两类文档
  // 都归零，真退化（`做。\n\n` 重复）的触发次数一次不少——它靠 C 和 B，A 没参与。
  signalA: { run: 8 },
  signalB: { chars: DEFAULT_SIGNAL_B_CHARS, ratio: 0.15, minCount: 12 },
  signalC: { minGram: 4, maxGram: 16, repeat: 8 },
  trigger: { consecutive: 2, repeatChars: 500 },
};

/** 已知 key 的嵌套结构：只用于 validateConfig 报出精确路径。 */
const KNOWN_KEYS = {
  enabled: null,
  disabledSessions: null,
  windowChars: null,
  signalA: { run: null },
  signalB: { chars: null, ratio: null, minCount: null },
  signalC: { minGram: null, maxGram: null, repeat: null },
  trigger: { consecutive: null, repeatChars: null },
};

/**
 * 未知 key / 类型不对一律抛错，不静默吞（照 dsh-llm-retry 的 validateConfig 写法，
 * 多做了子对象递归与数组类型检查）。
 */
export function validateConfig(config = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("output-guard: Config must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!(key in KNOWN_KEYS)) throw new Error(`output-guard: unknown key "${key}"`);
    const sub = KNOWN_KEYS[key];
    if (sub === null) continue;
    const value = config[key];
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`output-guard: "${key}" must be an object`);
    }
    for (const subKey of Object.keys(value)) {
      if (!(subKey in sub)) throw new Error(`output-guard: unknown key "${key}.${subKey}"`);
    }
  }
  if (config.disabledSessions !== undefined && !Array.isArray(config.disabledSessions)) {
    throw new Error(
      "output-guard: disabledSessions must be an array of session-id prefixes (e.g. [\"abc12345\"]), not a string",
    );
  }
  // 2026-10-28 测试报的洞：`enabled: "false"`（字符串）能过，而且仍然启用——
  // `"false"` 是真值。`enabled` 在 KNOWN_KEYS 里是 null，整个键被跳过，只查了名字没查类型。
  // 这个开关是「临时关掉插件」的唯一手段（需求文档六.3），搞错方向的代价是插件以为关了其实在跑。
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(
      `output-guard: enabled must be a boolean (true/false), not ${typeof config.enabled} "${String(config.enabled)}"`,
    );
  }
}

/**
 * 把「loader 可能没给全」的 Config 补成完整对象。Config schema 负责校验与
 * 默认值，这里再做一次纯函数兜底：`detect()` / 单测 / 探针都可以直接调用。
 */
export function withDefaults(raw = {}) {
  const c = raw ?? {};
  const signalA = c.signalA ?? {};
  const signalB = c.signalB ?? {};
  const signalC = c.signalC ?? {};
  const trigger = c.trigger ?? {};
  return {
    enabled: c.enabled ?? true,
    disabledSessions: c.disabledSessions ?? [],
    windowChars: c.windowChars ?? 2000,
    signalA: { run: signalA.run ?? 8 },
    signalB: {
      chars: signalB.chars ?? DEFAULT_SIGNAL_B_CHARS.slice(),
      ratio: signalB.ratio ?? 0.15,
      minCount: signalB.minCount ?? 12,
    },
    signalC: {
      minGram: signalC.minGram ?? 4,
      maxGram: signalC.maxGram ?? 16,
      repeat: signalC.repeat ?? 8,
    },
    trigger: {
      consecutive: trigger.consecutive ?? 2,
      repeatChars: trigger.repeatChars ?? 500,
    },
  };
}

/** 事件文件：默认 `%USERPROFILE%\.dsh\output-guard\events.jsonl`；env 覆盖只给自测用。 */
const EVENTS_FILE =
  process.env.DSH_OUTPUT_GUARD_EVENTS_FILE ||
  path.join(os.homedir(), ".dsh", "output-guard", "events.jsonl");

/** 追加一行 JSONL。写盘失败不许吞：console.error 出完整错误，然后继续跑。 */
function appendEvent(record) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(
      `[output-guard] 写 ${EVENTS_FILE} 失败：${error?.stack ?? String(error)}`,
    );
  }
}

/** 阈值快照：写这一行时的 Config（E7：改了 Config，新行变、旧行不变）。 */
function thresholdsSnapshot(resolved) {
  return {
    windowChars: resolved.windowChars,
    signalA: { ...resolved.signalA },
    signalB: {
      chars: [...resolved.signalB.chars],
      ratio: resolved.signalB.ratio,
      minCount: resolved.signalB.minCount,
    },
    signalC: { ...resolved.signalC },
    trigger: { ...resolved.trigger },
  };
}

export function apply(ctx, config) {
  validateConfig(config ?? {});
  const resolved = withDefaults(config);
  console.info(
    `[output-guard] v${VERSION} apply enabled=${resolved.enabled} windowChars=${resolved.windowChars}`,
  );

  // 必须挂在 agent.ctx 上：顶层 ctx 收不到 agent 上下文事件。
  ctx.on("agent/created", ({ agent } = {}) => {
    if (!agent) return;
    // agent.session 可能没有：兜到 agent.id（E9②）。
    const sid = String(agent.session?.id || agent.id || "");
    if (!resolved.enabled) {
      console.info(`[output-guard] 总开关关闭，跳过 agent ${sid}`);
      return;
    }
    if (resolved.disabledSessions.some((prefix) => sid.startsWith(prefix))) {
      console.info(`[output-guard] 会话 ${sid} 在 disabledSessions 里，跳过`);
      return;
    }

    agent.ctx.effect(() => {
      console.info(`[output-guard] v${VERSION} 已挂载 agent=${sid}`);

      // attemptId -> { turn, step, reasoning(字数), text(字数) }
      const attempts = new Map();
      // turn -> { reasoning(字数, 全部 attempt 之和), text(同上), triggers, maxRepeatRate, pending }
      const turns = new Map();

      /** 每轮一行 summary，不管有没有触发（E2）。 */
      const writeSummary = ({ turn, reasoningChars, maxRepeatRate, triggers }) => {
        appendEvent({
          type: "summary",
          ts: new Date().toISOString(),
          sessionId: sid,
          turn,
          reasoningChars,
          maxRepeatRate,
          triggers,
        });
      };

      /** 每次触发一行；roundFinalChars 先留 null，由 settle 行在 turn/end 补。 */
      const writeTrigger = ({
        turn,
        step,
        attemptId,
        signal,
        repeatRate,
        repeatChars,
        reasoningChars,
        sample,
      }) => {
        // 粗估，不是 usage 实测：只给一周后一个量级感，不参与任何判定。
        // 不等 usage chunk——那会把触发行拖到流末尾，丢掉「触发那一刻」。
        const reasoningTokensEst = Math.round(reasoningChars / 1.6);
        appendEvent({
          type: "trigger",
          ts: new Date().toISOString(),
          sessionId: sid,
          turn,
          step,
          attemptId,
          signal,
          repeatRate,
          repeatChars,
          reasoningChars,
          reasoningTokensEst,
          roundFinalChars: null,
          label: "",
          // 命中形态（脱敏后）。只数次数判断不了「真退化还是误报」，形态能。
          sample: maskSample(sample),
          thresholds: thresholdsSnapshot(resolved),
          pluginVersion: VERSION,
        });
        console.info(
          `[output-guard] trigger turn=${turn} signal=${signal} rate=${repeatRate} chars=${reasoningChars} session=${sid}`,
        );
      };

      /** 每次触发各一行，turn/end 时补 roundFinalChars（turn + attemptId 对号）。 */
      const writeSettle = ({ turn, attemptId, roundFinalChars }) => {
        appendEvent({
          type: "settle",
          ts: new Date().toISOString(),
          turn,
          attemptId,
          roundFinalChars,
        });
      };

      const onFrame = (frame) => {
        if (!frame || typeof frame.type !== "string") return;
        const attemptId = frame.attemptId;
        if (attemptId === undefined || attemptId === null) return;

        if (frame.type === "start") {
          if (frame.turn === undefined || frame.turn === null) {
            console.info(
              `[output-guard] start 帧缺 turn（attempt=${String(attemptId)}），跳过该 attempt`,
            );
            return;
          }
          attempts.set(attemptId, {
            turn: frame.turn,
            step: frame.step,
            reasoning: 0,
            text: 0,
            detectState: createState(),
            triggered: false,
          });
          return;
        }

        const attempt = attempts.get(attemptId);
        if (!attempt) {
          // chunk 帧没有 turn/step，只能反查 start 帧；查不到说明挂载晚于 attempt 开始，
          // 属于可观测的漏帧——跳过并留一行 info，不硬猜 turn（E10）。
          console.info(
            `[output-guard] 查不到 attemptId=${String(attemptId)} 的 start 帧，跳过该帧（挂载晚于 attempt 开始）`,
          );
          return;
        }

        if (frame.type === "end") {
          attempts.delete(attemptId);
          return;
        }

        if (frame.type !== "chunk") return;
        const chunk = frame.chunk ?? {};
        if (typeof chunk.text !== "string" || chunk.text.length === 0) return;

        const size = chunk.text.length;
        const turnData = turns.get(attempt.turn) ?? {
          reasoning: 0,
          text: 0,
          triggers: 0,
          maxRepeatRate: 0,
          pending: [],
        };
        turns.set(attempt.turn, turnData);

        if (chunk.type === "reasoning-delta") {
          attempt.reasoning += size;
          turnData.reasoning += size;
          // 检测只看 reasoning 文本；C 的 n-gram 不跨帧拼，直接扫滑窗。
          const result = detect(chunk.text, resolved, attempt.detectState);
          if (result.repeatRate > turnData.maxRepeatRate) turnData.maxRepeatRate = result.repeatRate;
          if (result.triggered && !attempt.triggered) {
            attempt.triggered = true;
            turnData.triggers += 1;
            // 触发行先写；attemptId 记进 pending，turn/end 时补 settle。
            turnData.pending.push({ attemptId, step: attempt.step });
            writeTrigger({
              turn: attempt.turn,
              step: attempt.step,
              attemptId,
              signal: result.signal,
              repeatRate: result.repeatRate,
              repeatChars: result.repeatChars,
              reasoningChars: attempt.reasoning,
              sample: result.sample,
            });
          }
        } else if (chunk.type === "text-delta") {
          attempt.text += size;
          turnData.text += size;
        }
      };

      const onTurnEnd = (turn, reason) => {
        const data = turns.get(turn);
        turns.delete(turn);
        if (!data) {
          // 不许静默跳过：这个 turn 一次帧都没收到（agent 中途创建 / start 帧丢了），
          // 也要写一条 0 值 summary，否则 E2 的「每轮一行」就断了。
          console.info(
            `[output-guard] turn=${String(turn)} 没有收到任何帧，写一条 0 值 summary（reason=${String(reason?.kind ?? reason)}）`,
          );
          writeSummary({ turn, reasoningChars: 0, maxRepeatRate: 0, triggers: 0 });
          return;
        }
        writeSummary({
          turn,
          reasoningChars: data.reasoning,
          maxRepeatRate: data.maxRepeatRate,
          triggers: data.triggers,
        });
        // settle 用该轮所有 attempt 的 reasoning + text 字数之和。
        const roundFinalChars = data.reasoning + data.text;
        for (const pending of data.pending) {
          writeSettle({ turn, attemptId: pending.attemptId, roundFinalChars });
        }
        console.info(
          `[output-guard] turn=${String(turn)} 结算 reasoning=${data.reasoning} text=${data.text} triggers=${data.triggers} reason=${String(reason?.kind ?? reason)}`,
        );
      };

      const stopStream = agent.ctx.on("agent/assistant-stream", ({ frame }) => onFrame(frame));
      // 同一条 session/event 会在每个 agent 的 ctx 上各触发一遍，session 必须是同一个才处理。
      const stopTurn = agent.ctx.on("session/event", (session, event) => {
        if (session !== agent.session) return;
        if (event?.type === "turn/end") onTurnEnd(event.data?.turn, event.data?.reason);
      });

      return () => {
        stopStream();
        stopTurn();
        attempts.clear();
        turns.clear();
      };
    }, "dsh-output-guard.agent()");
  });
}
