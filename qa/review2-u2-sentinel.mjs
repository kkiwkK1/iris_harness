// Sharper U2 probe: write a sentinel into the SELECTED candidate's own message
// table, then swipe and read — a per-candidate read must not carry the sentinel
// to the other candidate of the same turn.
import { setTimeout as delay } from 'node:timers/promises'
const BASE='http://127.0.0.1:8787'
const chatId = process.argv[2]
let seq=0
async function call(m,p={}){const r=await fetch(BASE+'/iris/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'s'+(++seq),method:m,params:p})});const f=await r.json();if(f.ok===false)throw new Error(m+': '+f.error?.code+' '+f.error?.message);return f.result}
const open=()=>call('chat.open',{chatId}).then(r=>r.view)
const keysOf=v=>v===undefined||v===null?null:Object.keys(v)
let view=await open()
const reply=view.messages.filter(m=>m.role!=='user'&&m.swipes!==undefined).at(-1)
const floor=reply.id, turn=reply.turn
console.log(`turn ${turn} floor ${floor} candidates ${reply.swipes.count} showing ${reply.swipes.index}`)
const read=async label=>{const v=await open();const m=v.messages.find(x=>x.turn===turn&&x.role!=='user');const s=(await call('script.getVariables',{chatId,scope:'message'})).variables;console.log(`${label}: showing=${m.swipes.index} topKeys=${JSON.stringify(keysOf(s))} sentinel=${JSON.stringify(s?.__u2sentinel)}`);return {index:m.swipes.index,s}}
await call('chat.swipe',{chatId,turn,index:0}); await delay(2000); await read('before write (index 0)')
const w=await call('script.setVariables',{chatId,scope:'message',messageId:floor,op:'insertOrAssign',variables:{__u2sentinel:{from:'candidate0'}}})
console.log('write ->', JSON.stringify(w.variables)?.slice(0,120))
await read('after write (index 0)')
await call('chat.swipe',{chatId,turn,index:1}); await delay(2000); await read('after swipe -> index 1')
await call('chat.swipe',{chatId,turn,index:0}); await delay(2000); await read('swipe back -> index 0')
