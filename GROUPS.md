# 群聊 —— 上游机制速写

**这是速写不是规格。**语料对群聊的兼容义务为零（见第二节），所以这份文档只记录骨架，
供将来立项时不必重新考古。**立项时从文末「没有测量的」清单接续**，那六项是有意留白，
不是遗漏。

测量日期 2026-09-02。对照本机检出 SillyTavern 1.18.0。

## 口径

- 标 **[源码]** 的行号来自本机检出，可复核。
- 第二节的「零」是**多源验证**的零，不是单一目录的空。
- 第三节起是骨架测量，**深度不足以支撑实现**——这是文档性质决定的，不是疏漏。

### 一个必须写进口径的陷阱：拿存在的键去比缺席的键

第一版统计把 5 个 `group_*` 设置项标成「用户改过」。**全是假阳性。**

原因：出厂的 `default/content/settings.json` 虽然含有 `power_user` / `oai_settings` /
`world_info_settings` 这几个父对象，但**不含这些子键**。递归 diff 遇到「用户文件里有、
出厂文件里没有」时报「不同」，而这个「不同」的含义是**基线缺席**，不是**用户改动**。

改成对**代码里的默认值**核对之后，7 项全部吻合（见第二节表）。

这是 `default/content` 基线陷阱的一个变体——同族的另一例是把「ST 存盘时显式写出的默认值」
数成「用户改过」（世界书统计 50 倍误差，见 `METHODS.md` 语料定理案例 4）。
**共同形状：一个 diff 告诉你「不同」，但不告诉你「和什么不同」。**

---

## 一、结论

**零使用，零兼容义务。维持 deferred。**

不是「用得少」，是**连引用都没有**。

这个判断改变的是它该记在哪本账上：做群聊是**开拓新用户**，不是**留住现有用户**。
两者不该排在同一个优先级序列里。

---

## 二、语料裁决：八个来源

| # | 来源 | 结果 |
| --- | --- | --- |
| 1 | `data/default-user/groups/` | **0 项** |
| 2 | `data/default-user/group chats/` | **0 项** |
| 3 | `settings.json` → `active_group` | `null` |
| 4 | **235 个备份**的文件名 | 含 `group` 的 **0 个** |
| 5 | 31 个聊天 `.jsonl` 的群聊标记（`is_group` / `group_id` / `original_avatar`） | **0 个文件命中** |
| 6 | `content.log` | **0 处**提及 |
| 7 | 19 张卡的 `group_only_greetings`（V3 群聊专用开场白） | **0 张**非空 |
| 8 | 7 个 `group_*` 设置项 | **全部为代码默认值** |

**第 4 条是把快照升级成历史结论的那一条**：如果用过再删掉，痕迹会留在 235 个备份里。
没有。

### 第 8 条的核对（对代码默认值，不对出厂内容包）

```
show_group_chat_queue        false   =  public/scripts/power-user.js:189
disable_group_trimming       false   =  public/scripts/power-user.js:215
world_info_use_group_scoring false   =  public/scripts/world-info.js:79
group_models                 false   =  public/scripts/openai.js:431
group_nudge_prompt   "[Write the next reply only as {{char}}.]"
                                     =  public/scripts/openai.js:114（逐字相同）
new_group_chat_prompt        出厂原样
active_group                 null
```

### 卡片侧：11 张的粗扫命中是假阳性，真相是反的

粗扫「卡片 `extensions` 里含 `group` 字样」命中 11 / 19 张。按「包含不是调用」把命中
原文打印出来后：

- 绝大多数是**卡脚本自己的标识符**：`groupsMap` `groupedSkills` `heteromorphicGroup`
  `worldviewGroup` `confirmationGroup` `eventGroup` …
- 一部分是**世界书的分组字段**（`group_override` `group_weight` `use_group_scoring`）
  ——那是 lorebook 的包含组，与群聊无关

收紧到「疑似 API 调用形状」后只剩 **2 张卡**（银麒赎世、魔法少女的扣扣审判），且两张的
名字集完全相同，很可能来自同一个打包库：

```
this.isGroup   sender.isGroup   currentChatIsGroup
getCurrentGroupMembers(   getSavedGroups(   latestGroupInfo   groupId =
```

决定性的一问——**这些名字在 API 面里存在吗**：

```
getCurrentGroupMembers   TH@types:0  TH-src:0  ST-public:0
getSavedGroups           TH@types:0  TH-src:0  ST-public:0
currentChatIsGroup       TH@types:0  TH-src:0  ST-public:0
latestGroupInfo          TH@types:0  TH-src:0  ST-public:0
isGroup                  TH@types:1  TH-src:1  ST-public:5
```

四个在任何 API 面里都不存在——**是卡自己的内部函数**。唯一真实的 `isGroup` 追下去是
`isGroupChat`，只是 `getChatHistoryDetail(data, isGroupChat?)` 与
`getChatsFromFiles(data, isGroupChat)` 的一个**可选布尔参数**
（`src/function/raw_character.ts:237` 默认 `false`），不是群聊能力。

---

## 三、存储契约

[源码] `src/endpoints/groups.js:163-177`，`id = String(Date.now())`：

```js
{
  id, name, members: [], avatar_url,
  allow_self_responses: bool,
  activation_strategy: 0,
  generation_mode: 0,
  disabled_members: [],
  fav, chat_id,
  chats: [id],
  auto_mode_delay: 5,
  generation_mode_join_prefix: '',
  generation_mode_join_suffix: '',
}
```

- 落盘位置：`data/<user>/groups/<id>.json`
- **`members` 存的是头像文件名，不是 id**
- 群聊记录另存于 `data/<user>/group chats/`

---

## 四、生成模式：**三个**，不是两个

社区常见的描述是「换卡 / 合卡」两种。[源码] `public/scripts/group-chats.js:129-133`：

```js
export const group_generation_mode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 };
```

| 值 | 含义 |
| --- | --- |
| `SWAP: 0` | 换卡——每次只用当前发言成员的卡 |
| `APPEND: 1` | 合卡——把启用成员的卡拼在一起 |
| `APPEND_DISABLED: 2` | 合卡，**且把被禁用成员的卡也拼进去**（`:553` 的条件用到它） |

合卡模式另有两个分隔串：`generation_mode_join_prefix` / `generation_mode_join_suffix`。

---

## 五、发言顺序：4 种策略，但前面有 4 条绕过路径

```js
// group-chats.js:122-127
export const group_activation_strategy = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 };
```

分派在 `:1002-1031`。**策略只在下面四条都不命中时才被咨询**：

| 条件 | 行为 | 行号 |
| --- | --- | --- |
| `params.force_chid` 是数字 | 强制指定成员 | `:1006` |
| `type === 'quiet'` | `activateSwipe(allowSystem: true)` 取 1 个；空则退回列表序首个 | `:1008-1012` |
| `type === 'swipe'` 或 `'continue'` | `activateSwipe(allowSystem: false)`；空则 toast 并抛错 | `:1014-1020` |
| `type === 'impersonate'` | `activateImpersonate` | `:1021-1022` |

**所以「四种发言顺序策略」这个说法在实现上不完整——swipe 和 continue 根本不走策略。**
它们走 `activateSwipe`，按「上一条是谁说的」决定。

### 一处反直觉：MANUAL 在非用户输入时是随机的

```js
// :1029-1030
} else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
    activatedMembers = shuffle(enabledMembers).slice(0, 1)
        .map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
}
```

手动模式在**非用户输入**时不是「不发言」，是 **`shuffle` 后随机挑一个**。

默认自动模式间隔 `DEFAULT_AUTO_MODE_DELAY = 5`（`:135`）。

---

## 六、swipe 与成员身份是耦合的

这是我们把「按候选存变量」扩展到群聊时的难点所在，上游的落点在 `activateSwipe`
（`:1015`）和它旁边这句 toast（`:1018`，原文）：

```js
toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
throw new Error('Deleted group member swiped');
```

**即：群聊里重 roll 一条回复，要求那个成员仍在群里；成员被移除则该条无法再 swipe，
并抛错。**

所以「哪个候选」和「谁在说话」在群聊里**不是正交的两维**——候选携带成员身份，成员
消失则候选失效。我们现有的按候选变量模型要扩展到群聊时，这是形状上的第一个约束。

---

## 七、没有测量的

按裁决只做了语料裁决与骨架速写。以下**均未测量**，立项时从这里接续：

1. 四种策略各自的内部算法（`activateNaturalOrder` / `activateListOrder` /
   `activatePooledOrder`）
2. 群聊里**世界书**的作用域规则
3. 群聊里**变量**的作用域规则
4. 酒馆助手脚本在群聊 frame 里的语境差异
5. 群聊记录 `.jsonl` 与单人聊天的格式差异
6. 服务端 `/api/chats/group/get` 与 `/api/chats/get` 的契约差异
   （只知道 `getChatsFromFiles` 按 `isGroupChat` 分派到这两个端点，`public/script.js:8395`）

规模参考：`public/scripts/group-chats.js` 2490 行，`src/endpoints/groups.js` 为服务端。
