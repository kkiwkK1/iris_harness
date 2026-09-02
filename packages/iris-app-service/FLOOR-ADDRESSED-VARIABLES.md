# 脚本 frame 里的楼层寻址变量读写

**设计输入,不是实现。** 派单的问法是「脚本 frame 的快照要携带哪些楼层的表」。
**量完之后这个问题不成立:每一楼的表已经在快照里了。** 所以先把这条说清,后面的账全都
跟着变。

## 口径

- 语料:`E:\sillyTavern` 27 张卡的脚本正文 + 最长的一局(677 行 / 338 个 assistant 楼)。
- 走产品自己的 `CharacterLibrary` / `extractScripts` / `ChatEntry.toFile()`。
- 单人单次,未复核。

---

## 一、快照已经带着全部楼层的表

`ScriptContext.chat` 是 `withUserRowTables(entry)` 造的,而它走的是 `toFile()`——
**`toFile` 会给每一行挂上 `variables`**(`context.ts` 里那句注释写着为什么:
「`toFile`, not `exportMessages`: only the former attaches `chat[i].variables[swipe_id]`」)。
对最长那局实测:

```
快照 chat 数组          18.32 MiB
  其中 variables 表      8.29 MiB
  其余(mes/swipes/meta) 10.03 MiB
带 variables 的行        677 / 677
```

> **`getVariables({message_id: N})` 要的东西,就在 `context.chat[N].variables[swipe_id]`。**
> frame 拒绝这个调用,不是因为数据不在手上,而是因为它只看 `context.variables`
> ——那一份是「最新一楼的表」,确实不记得自己是哪一楼。

所以**不需要新的传输,也不需要窗口**。这条路上真正要做的是让 frame 从 `chat` 回答,
并把「哪一楼」从 `message_id` 直接取。**同步答得上,因为数据已经同步在手。**

**这一点决定了其余几个问题都不必回答**:失效与刷新时机跟 `chat` 走(快照本来就每回合
重建);窗口外楼层不存在(没有窗口);「异步补取后同步答缓存」不需要——而它本来也不
可行,上游 `getVariables` 是同步的,第一次问就答不上。

## 二、但账要反过来记:18.32 MiB 的快照本身才是问题

原来的问法假定「携带楼层表是要新花的钱」。实测是**这笔钱一直在花**,而且花在每一次
快照构建上。分布(同一局,338 个 assistant 楼,表合计 5309 KiB):

```
均值                    15.7 KiB/楼
最大 5% 的楼(17 个)   承载 83.4% 的字节
最大 10% 的楼(34 个)  承载 99.8% 的字节
```

**均值在这里骗人**,而且骗的方向正好相反于直觉:

```
最近   1 楼   281.1 KiB
最近   5 楼  1408.9 KiB
最近  20 楼  3378.0 KiB   ← 全部字节的 64%
最近  50 楼  3615.5 KiB
全部 338 楼  5309.4 KiB
```

**「最近 N 楼」是所有窗口形状里最贵的那一种**,因为上游的清理恰好保留最近 20 楼不剥
(`DEVIATIONS §8`),所以「最近 20 楼」精确地等于「没被剥过的那一批」。
**一个看起来最省的窗口,选中的正是最肥的那一段。** 这条值得单独记:清理规则和窗口规则
如果各自设计,窗口会系统性地挑中清理故意留下的东西。

## 三、语料能告诉我们什么,以及它不能

派单要的三个数,连同它们的**可信度**:

```
卡正文里的变量调用点        52   (读 28 / 写 24)
  内联参数且带 message_id     1
  内联参数但没有 message_id  26
  参数不是内联对象           25   ← 文本判不了
```

**那个 1 不是答案,是这份普查的能力上限。** 两条独立的失明:

1. **25/52 的调用点参数是个变量**,文本读不出它是不是楼层寻址。我第一版普查把这一类
   静默丢掉,报出「27 张卡里只有 1 处楼层寻址」——而单是 V1.5.4 就有 18 个
   `getVariables(` 调用点。**丢掉读不懂的那部分,会得到一个看起来像答案的数。**
2. **27 张卡里 20 张从 CDN import 远程模块**(17 个不同 URL,含
   `MagVarUpdate@beta/artifact/bundle.js`)。**真正的消费者 MVU 就在里面**,对正文普查
   完全不可见。

**所以这件事必须按上游语义建,不能按用量建。** 语料在这个问题上没有发言权——这不是
「语料零」,是「语料看不见」。

## 四、但语料给出了一个形状,而且它不是数字

真实调用点长这样(dev profile 三张卡):

```js
Mvu.getMvuData({ type: 'message', message_id: n })            // V1.5.4,n 是算出来的楼号
Mvu.replaceMvuData({stat_data}, {type:'message', message_id: e})
Mvu.getMvuData({ type: 'message', message_id: 'latest' })      // 绿茵好莱坞、灭仇家满门
```

**`message_id` 不总是数字:`'latest'` 是一个真实在用的字符串哨兵**,两张卡在用。
我们的契约现在是 `z.number().int().min(0)`——**字符串会被 schema 直接拒掉**。

而 `service.ts:1735` 早就记过这件事的另一半:

> the frame refuses every `message_id` but `'latest'`, so no explicit id had ever
> reached this code … the window closes the moment the frame opens that path

**那扇窗正在关上**:V1.5.4 的报错就是 frame 第一次被要求开这条路。所以这份设计是那条
预言的兑现,而 `'latest'` 必须和数字一起被接受,否则今天能跑的两张卡会在开路的同时坏掉。

## 五、写路径

`replaceVariables` / `insertOrAssignVariables` 的楼层寻址**已经有宿主 arm**
(`script.setVariables` 带 `messageId`),`turnForMessage` 做消息号到 turn 的翻译。
所以写这半不缺机制,缺的是 frame 肯把 `message_id` 传下来。

**但有一条既有残留必须在开路时一起说清**(`service.ts` 已记):一个 turn 同时拥有用户行
和回复行,两个消息号映射到同一个 turn、因而同一张表。**上游是按消息存表的,会用用户行
自己的表回答;我们没有用户行的存储,用户行的 id 会读到它回复的表。** 开路之前这条只是
理论,开路之后它是每张按 `message_id` 寻址的卡都会碰到的。

## 六、未查

1. **`'latest'` 之外还有没有别的哨兵**(`'last'`? 负数?)。上游 TH 的取值域没读全。
2. **18.32 MiB 快照的实际传输代价**没量:它每回合过一次 `postMessage`,序列化与结构化
   克隆的开销没测过。**这是「二」里那笔账真正的分母,缺它就只能说贵,说不出多贵。**
3. 卡正文普查的两条失明(§三)意味着**读/写点数永远只有下界**,没有上界。
4. 本文数字单人单次,未复核。
