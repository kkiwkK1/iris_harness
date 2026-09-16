import { splitBodyTag } from '../apps/iris-web/src/app/body-tag.ts'
import { claimMessageSurfaces } from '../apps/iris-web/src/sandbox/frontend-blocks.ts'
import { repairStrayFences } from '../apps/iris-web/src/app/stray-fences.ts'
let seq=0
async function rpc(m,p={}){const r=await fetch('http://127.0.0.1:8787/iris/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'p'+(++seq),method:m,params:p})});return r.json()}
const list=(await rpc('chat.list',{})).result.chats
// today's chats only
const today=list.filter(c=>/20260917/.test(c.chatId))
console.log('chats today:',today.length)
let folded=0, ok=0, noc=0
for(const c of today){
  const v=(await rpc('chat.open',{chatId:c.chatId})).result.view
  const reply=v.messages.filter(m=>m.role!=='user'&&m.text.trim()!=='').at(-1)
  if(!reply) continue
  const display=repairStrayFences(reply.text)
  const split=splitBodyTag(display,'content')
  const bodyText=split.body ?? display
  const full=claimMessageSurfaces(display)
  const body=claimMessageSurfaces(bodyText)
  if(full.blocks.length===0){noc++;continue}
  const verdict = body.blocks.length===0 ? 'FOLDED-AWAY' : 'ok'
  if(verdict==='FOLDED-AWAY')folded++;else ok++
  console.log(`${c.chatId.slice(0,46).padEnd(48)} tagged=${String(split.tagged).padEnd(5)} displayClaims=${full.blocks.length} bodyClaims=${body.blocks.length} head=${String(split.head.length).padEnd(7)} tail=${String(split.tail.length).padEnd(7)} ${verdict}`)
}
console.log(`\nsummary: renderable replies=${folded+ok} ok=${ok} FOLDED-AWAY=${folded} noClaims=${noc}`)
