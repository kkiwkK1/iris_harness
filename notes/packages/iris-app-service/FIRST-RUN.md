# The first-run path

What a profile that has never been used does, measured against one built for the
purpose: `apps/iris/data/empty`, holding five imported cards, their books, and
**nothing else** — no `settings.json`, no `card-storage.json`, no
`script-policy.json`, no `script-buttons.json`, no `script-variables.json`, no
`extension-settings.json`. Their absence is the state under test; a profile
pre-seeded with them cannot answer the question.

The reason to write this down is that every one of these files is created by a
*write*, so on a first run every reader meets a file that is not there. A
tolerated absence and a crash look identical in the code until someone runs it.

## The chat list scans the directory; there is no index to miss

An early hypothesis was that the list depends on an index or on `settings.json`,
and that an empty profile would therefore show nothing. **It does not.** Against
that profile — which has no `settings.json` at all — both the store and the RPC
handler return every chat:

```
character.list -> 5
chat.list      -> 5
   银麒赎世-20260903-061239 | 银麒赎世
   魔法少女的扣扣审判1-20260903-061240 | 魔法少女的扣扣审判1.0
   创世回廊1-20260903-061240 | 创世回廊1.3
   可攻略女主拒绝被攻略-20260903-061240 | 可攻略女主拒绝被攻略
   爱衣-20260903-061240 | 爱衣
```

`ChatStore.list()` reads `chats/`, so a chat is visible because its file exists.
There is no registration step between writing a chat and seeing it, and so no
step that a first run can be missing.

## An absent `settings.json` loads defaults and does not throw

`SettingsStore` only writes on change, so a profile where nobody has changed a
setting has no settings file. `load()` treats that as the defaults rather than
as an error — the four product defaults apply, and the first run behaves like a
run whose user happened to agree with all of them.

This is the behaviour we want, and it is worth an explicit line precisely
because it is invisible when it works: nothing in a green run distinguishes
"tolerated the absence" from "never looked".

## Not a finding: a relative `IRIS_DATA_DIR`

An empty conversation list on a host started with
`IRIS_DATA_DIR=./apps/iris/data/empty` was, on investigation, the working
directory: `cordis.yml` resolves `dataDir` against the process cwd, and the
default `./data` only names the usual profile when the host is started from
`apps/iris`. Restarted with an absolute path, the same profile shows five cards
and five conversations. Recorded here only so the next person reads the
discriminator rather than the symptom — **if the Characters column is empty too,
the directory is wrong, and nothing about the first-run path is involved.**
