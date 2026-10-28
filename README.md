# dsh-output-guard（输出守卫 · 灰模式最小版）

只观测、不中止。回答一个问题：**多少人、什么形态、会走多远。**

监听 `agent/assistant-stream` 与 `session/event`，把每轮的思考量、最严重重复率、
触发信号写进 `%USERPROFILE%\.dsh\output-guard\events.jsonl`，供一周后定阈值。

本版**不接 `agent.cancel()`、不碰 surface、不产生 aborted**（执行书 §5）。

## 安装

插件目录：`~/.dsh/plugins/dsh-output-guard/`。

挂载需要 profile 侧登记（本插件不自带安装脚本）：

1. `D:\DSH\.dsh\profiles\desktop\package.json` 的 `dependencies` 加
   `"dsh-output-guard": "link:~/.dsh/plugins/dsh-output-guard"`；
2. 同文件 `dsh.profile.bundles` 加 `"dsh-output-guard"`；
3. 在 profile 目录跑 `pnpm install`（建 `node_modules/dsh-output-guard` 软链）；
4. 走 `restart-dsh.bat` 重启宿主。

> **执行书 §5 写明「不改宿主配置、不改 profile patch」**，而上面第 1–3 步正是改
> profile 的 `package.json`（不是被禁止的 `cordis.patch.yml`）。这一步留给主程/统筹
> 决定并执行，施工会话未动 profile。

## 配置（一个都不写死，全部可配，全部有默认值）

覆盖方式：`cordis.patch.yml` 里给插件传 config，或改 `lib/index.js` 的 `DEFAULTS`。
默认值在 `DEFAULTS` 里，`withDefaults()` 做深合并兜底（少传一个键不抛错）。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` = 只挂载不打点 |
| `disabledSessions` | `[]` | 会话 id 前缀数组，命中即跳过 |
| `windowChars` | `2000` | 滑窗字符数 |
| `signalA.run` | `5` | 同一字符连续 ≥ N |
| `signalB.chars` | `["好","做","嗯","继续","好的"]` | 高频字/词 |
| `signalB.ratio` | `0.15` | 占窗口比例（按「字」） |
| `signalB.minCount` | `50` | 总字数下限 |
| `signalC.minGram` / `maxGram` / `repeat` | `4` / `16` / `8` | n-gram 重复 |
| `trigger.consecutive` | `2` | 连续 N 次疑似触发 |
| `trigger.repeatChars` | `500` | 重复字符 > M 触发 |

未知 key、`disabledSessions` 传字符串都会在 `apply` 里抛错。

## 数据

`%USERPROFILE%\.dsh\output-guard\events.jsonl`，追加写，三种行：

- `summary`：每轮一行（没触发也写），`ts/sessionId/turn/reasoningChars/maxRepeatRate/triggers`
- `trigger`：每次触发一行，`roundFinalChars` 先为 `null`，`thresholds` 是写行时的 Config 快照
- `settle`：每次触发配一行，turn/end 时用该轮所有 attempt 的 reasoning+text 字数补 `roundFinalChars`

`reasoningTokensEst = round(reasoningChars / 1.6)` 是**粗估，不是 usage 实测**。

环境变量 `DSH_OUTPUT_GUARD_EVENTS_FILE` 可覆盖事件文件路径（只给自测用，必须在
`import` 前设好；默认行为不受影响）。

## 验证边界

- **零依赖**：本插件不 import 任何 `@deepseek-ai/*` 核心包，`package.json` 也没有
  `dependencies` / `peerDependencies`。原因：本插件以 `link:` 装进 profile，解析域里
  没有核心包，`import` 会 `ERR_MODULE_NOT_FOUND`（`dsh-recall` / `dsh-theater` /
  `dsh-qoder-agent` 文件头写着同一句话）。配置用 `lib/index.js` 里的 `DEFAULTS` +
  `withDefaults()` 手写兜底，不依赖 schemastery。
- 施工会话**没有**重启宿主，也没有改 profile：真实挂载日志（E1a）、真实 3 轮 summary
  （E2a）都没跑，只用进程内 mock ctx 做了等价验证。
- **`agent.cancel` / surface / aborted 全程没有**（E8 grep 可验）。
- 信号 A 只对**非 ASCII**字符生效（默认 `signalA.ignore` 排掉全部 ASCII 可打印字符）。
  这是实测调的，不是拍的：见 `lib/detect.js` 里 `DEFAULT_SIGNAL_A_IGNORE` 的注释。
- 信号 C 判的是「**连续**重复」（同一 n-gram 紧挨着重复 ≥ `repeat` 次），不是「分散出现
  ≥ repeat 次」。三次改判据的实测数字都写在 `scanSignalC` 注释里。
- 验收实测（2026-10-27，拿 5 份真实代码 + 6 种真退化各跑一遍）：
  dsh-flow 210 帧 / dsh-recall 234 帧 / dsh-theater 76 帧 / 本插件 index.js 41 帧 /
  detect.js 24 帧，**前四份 0 命中**；detect.js 自己 7 次命中，原因是它的注释里就写着
  「做做做做做」这段退化样本——那是真重复，抓到是对的。正常中英文推理各 0 命中。
  真退化（刷「好」3000 字 / 「做」2000 / 「嗯」1000 / 「好的」500 组 / 「继续」400 组 /
  真假混合）**全部命中**。
- 这些数字只证明「在代码和明显退化上分得开」，**不代表真实 reasoning 上的误报率**。
  那要一周真实数据，灰模式的全部意义就在这。

## 0.1.2（2026-10-27 晚）· 判据修正：夹心式重复

**触发**：主人贴出 `abcdef12` turn 344 的思考截图，满屏「好。好。好。」夹着一句真话。
本插件 v0.1.1 在跑（events.jsonl 有记录），但那一轮 `triggers: 0`——**没抓到**。

**改了两处**（`lib/detect.js`）：

1. **信号 B 的分母从「窗口长度」改成「非空白字符数」**。退化的典型排版是
   「好。\n\n好。\n\n」，换行占了一半字符；按含空白算，那块思考实测只有 9.3%，
   永远够不到 `ratio: 0.15`，可它的非空白字符里近两成是「好」。
   语义上本来也该是「这些字里有多少是填充」，空白不算字。
2. **`minCount` 50 → 12**。这种夹心式退化的单次 attempt 只有几十到一两百字，
   50 的门槛根本够不着。`index.js` 的 `DEFAULTS` 同步改了，否则会被外层覆盖。

**验证**（`_guard_selftest` 同款方法，拿真实样本回放）：

| 样本 | 旧判据 | 新判据 |
|---|---|---|
| `abcdef12` turn 344 step 8（真退化，869 字符 / 81 个「好」） | 0 次触发 | 37 次触发（第 140 字符就中） |
| 本插件 `index.js`（11,942 字符代码） | 0 | 0 |
| 事故记录 / token 报告（真实中文文档） | 0 | 0 |
| 需求与设计.md（里面**引用了** `好好好好好` 作例子） | 0 | 80 |

**验证边界**：只回放了 1 个真实退化块 + 4 份文本。误报率仍要一周灰数据，
「需求设计文档会被判中」说明**在引用退化样本的正常文档上会误报**——灰模式只记录，
代价是噪声；将来若要升级成拦截，必须再加「真退化 vs 引用示例」的区分或人工白名单。

**未做**：没有 abort、没有重试、没有改落库内容。主人 2026-10-27 选的是「先观测」。

## 0.1.3（2026-10-28）· 修 `repeatChars` 漏掉信号 C

**触发**：翻 `events.jsonl` 那一天的 245 条 trigger，发现一条 `signal: "C"` 却
`repeatChars: 0, repeatRate: 0`。信号 C 命中了，重复字符数却是 0。

**根因**（`lib/detect.js`）：

```js
const repeatPositions = new Set(sigA.marked);
for (const pos of markedB) repeatPositions.add(pos);   // ← 只有 A 和 B
const repeatChars = repeatPositions.size;
```

`scanSignalC` 一命中就 `return true`，**它算出的重复段位置一个都没往外传**。于是 C
单独触发时 `repeatChars` 恒为 0。而 C 占全部触发的 94%（245 条里 230 条）。

**后果很重**：0.1.1 / 0.1.2 那一整天数据里，`repeatRate` 这个字段对 94% 的触发是假的。
171 条 rate < 0.1、其中还有一条正好 0——**那些低 rate 不代表「误报」，代表这个字段没在算 C**。
原始 reasoning 文本没落盘，**这批数据重算不了**。

**改法**：`scanSignalC(window, cfg, marked)` 加第三个参数，命中时把连续重复段的位置
写进 `marked`；`detect()` 里调整顺序，先把 A、B 的位置放进 `repeatPositions`，
再把它传给 `scanSignalC`。这样 `repeatRate` 的含义才统一成「窗口里有多少字符属于
重复（A∪B∪C）」。

**验证**：

| 样本 | 改前 | 改后 |
|---|---|---|
| `abcd` ×10（40 字符，纯 C 命中） | `repeatChars: 0` / `rate: 0` | **`repeatChars: 40` / `rate: 1`** |
| `一二三四五` ×8 组（纯 C 命中） | `repeatChars: 0` / `rate: 0` | **`repeatChars: 40` / `rate: 1`** |
| dsh-flow 源码 210 帧 | 0 命中 | **0 命中**（误报没回来） |
| dsh-recall 234 帧 / dsh-theater 76 帧 / 本插件 index 40 帧 | 0 | **全 0** |
| 刷「好」3000 / 「做」2000 / 「好的」500 组 | 命中 | **命中**（A/A/B，rate 均 1） |
| 正常中英文推理 | 0 | **0** |

**看数据时的规矩**：`trigger` 行自带 `pluginVersion`。**统计 `repeatRate` 必须按版本分组**，
0.1.3 之前的那些数不能当阈值依据用，只能数「触发了几次」。`reasoningChars` / `trigger` 行数 /
`settle` 行数这几项不受影响，整段数据都能用。

**这一条是怎么漏出去的**：我是拿「代码」和「退化文本」验的，两类样本上 `repeatRate`
恰好都正常（代码 0 命中、退化靠 A 命中）。**没验「只有 C 响」这一种组合**——而 C 是真实
数据里最常见的那个。写测试只挑「我觉得会发生的」，漏的永远是没想到的那一格。

## 0.1.4（2026-10-28）· trigger 行存命中形态（脱敏）

**为什么要加**：一周后要拿数据定阈值，可 `trigger` 行只有 `signal` / `repeatRate` /
`repeatChars` 三个数。知道「这一轮触发了 52 次」，判断不了「是真退化还是误报」。**数次数
回答不了形态问题。**

**加了什么**：`trigger` 行多一个 `sample`，三种信号各写自己认得出的形态：

| signal | sample |
|---|---|
| `A` | `{signal, char, run}` —— 哪个字、连续几次 |
| `B` | `{signal, word, count, chars}` —— 哪个词、出现几次、共占几字 |
| `C` | `{signal, gram, gramLen, repeat}` —— 哪个 n-gram、多长、连续重复几次 |

拿真实退化回放（`abcdef12` turn 377）：

```
{"signal":"C","gram":"\n\n做。","gramLen":4,"repeat":38}
```

**形态一眼可判**——`\n\n做。` 连续 38 次。这比「触发了 112 次」有用得多。

**脱敏**（`maskSample`，`lib/detect.js`）：`sample` 里是 reasoning 原文的一小段，必须脱敏才
能落盘。替换有明确形状的东西，其余原样留：

| 原 | 落盘 |
|---|---|
| `D:\workspace\notes\x` | `<PATH>` |
| `session-abcdef12-3456` | `<SID>` |
| `主人@example.com` | `<EMAIL>` |
| `13800138000` | `<NUM>` |
| `gho_abcdefgh12345678` / `sk-…` | `<KEY>` |
| `做` / `好的` | `做` / `好的`（原样） |

**为什么不做泛化删除**：全删成 `<MASK>` 就白存了。sample 只有 4~16 个字，形状不认识
的短文本本来就装不下多少隐私；有形状的才必须脱。

**邮箱那条踩过**：第一版用 `[\w.+-]+@…`，`主人@example.com` 漏了——`\w` 不含中文。
改成按「@ 两侧的非空白」判。

**顺便**：`maskSample` 里 `.slice(0, 32)` 兜底，再长的 n-gram 也不进日志。n-gram 本身
上限是 `maxGram: 16`，这个兜底只是防配置被改大。

**验证**：脱敏 8 个样本全对；真实退化回放 112 次触发，形态全是 `\n\n做。` 系；五份真实
代码仍 0 命中；生成行 `JSON.parse` 通过。

**未做**：仍然没有 abort、没有重试、没有改落库内容。**仍等一周数据定阈值。**

## 0.1.5（2026-10-28）· 两处验收退回

测试中心 `独立验收` 独立验收 `0.1.4`，71 项断言全过，另报两个真问题。

### 一、`signalA.run` 5 → 8：我把「字面重复」当成了「退化输出」

`detect.js:152` 的注释里写着一行例子：

```
 *      （`做做做做做`、`好的好的好的`），不是「分散出现 8 次」……
```

`run: 5` 会把这行**注释本身**判成退化——五个「做」连着，字面上确实连续重复五次。

**我当时的辩解是「那是真连续重复，命中是对的」。这句是错的。** 它把「字面上重复了吗」
偷换成了「这是不是退化输出」——两回事。E4 的判据是「跑正常代码分析不该有 trigger」，
那么在注释里引用退化形态，按判据就是 false positive，没有商量。

实测（同一批文件，只动 `run`）：

| `signalA.run` | `detect.js` 自己 | 执行书 | 真退化（`abcdef12` turn 377） |
|---|---|---|---|
| 5 | 7 命中 | 26 命中 | 112 次触发 |
| **8** | **0** | **0** | **112 次触发** |

真退化一次没少——它靠的是 C（95 次）和 B（17 次），A 从头到尾没参与（那段文本里最长
连续的「做」只有 1 个，因为每个「做」后面都跟着「。」和换行）。

**零代价，采纳。** 测试中心自己那一轮还留着活证据：写测试用例时的正常思考连出 6 条 A
trigger（`run 5~6`、`rate 0.0049~0.113`）——那种命中在灰模式里是噪声，一周后算误报率时
必须按误报算，不能当成真退化。

### 二、`enabled: "false"` 被接受，而且仍然启用

`validateConfig` 只校验 key 名和子对象结构，`enabled` 在 `KNOWN_KEYS` 里是 `null`，
整个键被 `continue` 跳过——**只查了名字，没查类型**。字符串 `"false"` 是真值，所以插件
照跑。

这个开关是「临时关掉插件」的唯一手段（需求文档六.3），搞错方向的代价是**以为关了，其实
在跑**。改法：非布尔的 `enabled` 直接判配置非法，不猜。

| 输入 | 结果 |
|---|---|
| `enabled: true` / `false` | 通过 |
| `enabled: "false"` / `"true"` / `1` / `0` | 抛错 |

### 三、`signalB.minCount` 50 → 12 的申报问题

测试报我「没申报的偏离」——**属实**。50→12 是 0.1.2 改的，README 的 0.1.2 那节写了改动
和理由，但那只写在自己的 changelog 里，卡头和执行书 §2 还写着「计数 >50」。改行为要走
申报，我没走。

理由再摆一次：真退化 `abcdef12` turn 344 是 869 字符 / 81 个「好」，但那是**整段**；单个
attempt 只有几十到一两百字，`>50` 够不到。0.1.1 在真退化上记的就是 `triggers: 0`。

**但要紧的是下一句**：12 也不是有效值。B 的真瓶颈是 `ratio: 0.15`——实测那段真退化里
「做」只占非空白字符的 **9.4%**，改分母后仍然够不到。0.1.4 的 8 条 trigger 里 B 是 **0
条**（7 C + 1 A）。`minCount` 认 12，但别把它当成「B 调好了」，B 一周后要动的是 `ratio`。

**验证**：六份文档误报全 0（执行书原来 26 次、`detect.js` 7 次）；真退化回放 112 次不变；
`enabled` 六种输入按上表；A/B/C 三种信号与正常中英文样本行为不变。

**未做**：仍然没有 abort、没有重试、没有改落库内容。**仍等一周数据定阈值。**

## 0.1.6（2026-10-29）· 写分析工具时发现的记录缺陷

这一版没有改判据，只改记录。发现过程值得写下来：

为了给「一周后定阈值」做准备，我写了 `scripts/analyze.mjs`（只读，不改数据）。它按
`pluginVersion` 分组统计——**因为 0.1.3 之前 `repeatChars` 漏算信号 C，那批行的
`repeatRate` 整列是假的，混在一起算就是把「字段算错」当成「阈值合理」**。

跑了一遍真数据（789 行），分组结果是这样：

| 行类型 | 总数 | 带 `pluginVersion` |
|---|---|---|
| `trigger` | 314 | **314** |
| `summary` | 163 | **0** |
| `settle` | 311 | **0** |

只有触发行带版本，另外两种都没带。后果不是「少个字段」：

- `summary` 和 `settle` 全落进「无版本字段」那一组，跟任何版本都对不上
- `trigger` 的 settle 配对显示 **0/31**——明明每轮都写了 settle，但两组分不到一起
- 于是「改了判据之后一段时间的效果」**根本没法按版本切出来比**，而那是定阈值的唯一依据

**修法**：三种行都带 `pluginVersion`；`settle` 另加 `sessionId`——它原本只有 `turn` +
`attemptId`，跨会话 `turn` 撞号时只能靠 `attemptId` 的前缀隐式反推，容易对错人。

### 这个缺陷为什么没被测试抓到

它不违反任何一条 E。E2 验「每轮一行 summary」，E6 验「触发行字段齐全」，E16 验「summary
六字段齐全」——**没有一条问「三种行能不能按版本分组」**。单看每种行的字段都是齐的。

错在我当初写 `writeTrigger` 时顺手加了版本（因为要记录阈值快照），写另外两个时没加，**没
回头统一**。

### 新增两个脚本

- `scripts/analyze.mjs`——读 `events.jsonl`，按版本分组，给 rate 分位、直方图、触发形态
  聚类、settle 配对率。**只给数，不替你下结论**：报告最后一节只列「要回答的问题」和「回答
  它需要看哪个数」，阈值要人看着 sample 判。
- `scripts/verify-rows.mjs`——伪造 ctx + agent 跑一轮真帧，验三种行都带版本和 sessionId。

**验证**：`verify-rows.mjs` 14 项全过；`regress-016.mjs` 回归全过——六份真代码/文档误报
仍是 0、真退化回放 171 次（0.1.5 是 112，只多不少）、`enabled` 六种输入不变、三种信号各
抓各的、正常中英文不触发、sample 脱敏不变。

**未做**：仍然没有 abort、没有重试、没有改落库内容。**仍等一周数据定阈值。**

**注意**：0.1.6 的改动要重启宿主才生效，重启前的行仍是旧格式。分析时按 `pluginVersion`
分组，缺版本的那组就是重启前的。

