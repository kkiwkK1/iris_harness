/**
 * Canned prose the fake generates.
 *
 * Deliberately long, multi-paragraph, and Markdown-bearing. The interface being
 * built against this fake is a reading surface, and a fake that answers "Hello!
 * How can I help?" would let real layout bugs — measure, paragraph rhythm,
 * emphasis inside dialogue, a fence in the middle of a scene — go unseen until
 * a live model finds them.
 *
 * @module @iris/client-fake/corpus
 */

/** Replies keyed by nothing in particular; the index is chosen by turn and candidate. */
const REPLIES: readonly string[] = [
  `The lamp gutters once and holds. She does not look up from the wick trimmer.\n\n"You came the long way," she says. "Through the cistern stair. I can smell it on your coat." A pause, the small metallic sound of the trimmer closing. "Most people take the bridge and lie about it."\n\nOutside, the rain has found the gap in the shutter again, and is making its slow argument with the sill.`,

  `"Ask me tomorrow," she says, and then, because that is a coward's answer and she knows it: "No. Ask me now."\n\nShe sets the glass down. The flame steadies into that particular blue it only finds after midnight, when the gas in the lines has gone cold enough to burn clean.\n\n"I signed the register under a name that wasn't mine. Twice. The second time I *knew* what the ledger was for."`,

  `She turns the map ninety degrees, which does not help, and then ninety again, which does.\n\n"Here." Her finger stops on a stretch of coast that the surveyors gave up on. "This is the part they draw as a straight line because the truth would cost them a season. It is not a straight line. It is four hundred small bays that each want their own name."\n\n> *Soundings unreliable past the second shoal. Do not trust the chart. Trust the lead.*\n\n"My grandmother wrote that. She was correct, and they printed it anyway, in the margin, where no one reads."`,

  `A long silence, the kind that is doing work.\n\n"You want the tidy version," she says at last. "Where I was clever and the door was already open. That version exists. I have told it at three dinners and it goes down very well with the fish."\n\nShe pulls her sleeve back. The scar runs from the wrist toward the elbow and stops, abruptly, as if it had been talked out of continuing.\n\n"This is from the untidy version."`,

  `"Records don't lie," the Archivist says. "That is a thing people say about records, and it is why the archive is the best place in the city to keep a lie. A lie in a mouth has to be repeated. A lie in a ledger only has to be *filed*."\n\nIt turns the page with a flat palm, the way you would smooth a bedsheet.\n\n"Row nine. Nineteen entries in one hand, and the nineteenth is in a slightly different ink. Someone came back. Years later, by the oxidation. And they did not add anything. They *corrected* something."`,

  `She laughs, and it is not a kind laugh, but it is not aimed at you.\n\n"You've been reading the pamphlets. 'The city rests on seven wells.' It rests on eleven, and four of them are dry, and one of the dry ones has a door in the bottom of it."\n\n"I'm not going to tell you which. You'd go tonight, in that coat, with no rope, and then I'd have to explain to your sister why I let you."`,

  `"Fine." She wipes her hands on the rag, deliberately, one finger at a time. "You want the mechanism. Most people want the story; you want the mechanism. I like that about you and it is going to get you killed."\n\n"The mantles are woven in the workhouse, dipped in thorium nitrate, and fired once. After the firing there is no fabric left — only the ash, holding its own shape out of habit. Touch it and it's gone. That's why we carry them in the tin, and that is why a lamplighter with steady hands earns twice."`,

  `Nothing, for a moment. Then she says your name — the short form, the one only two people use — and the room reorganizes itself around it.\n\n"I need you to understand that I am about to be honest with you, and that afterwards you will wish I hadn't been, and that I am doing it anyway."\n\nThe rain has stopped. Neither of you mentions it.`,
]

/** Reasoning traces, kept short: the UI collapses them, so the point is that they exist. */
const REASONING: readonly string[] = [
  `The user is pushing for a direct answer. Character is evasive by nature but has been established as honest under pressure — so: one deflection, then commit. Keep the physical business (the trimmer, the glass) carrying the beat instead of stage-directing the emotion.`,
  `Continuity check: the coast survey was mentioned two turns ago, the grandmother has not been introduced yet. Introducing her through a marginal note is cheaper than exposition and gives the map an owner.`,
  `Tone is drifting warm. Pull back — this character's affection reads as bluntness, not softness. Cut the reassurance and let the refusal do the work.`,
  `The user asked a mechanism question. Answer it concretely and accurately enough to be satisfying, then use the accuracy as characterization rather than as a lecture.`,
]

/**
 * Pick a reply deterministically.
 *
 * Deterministic rather than random so that a regenerate produces the *same*
 * alternate every time for a given turn and candidate slot. Debugging a swipe
 * bug against a fake that reshuffles is miserable.
 * @param turn - the turn being generated.
 * @param candidate - which candidate slot this generation fills.
 * @returns the reply text.
 */
export function replyFor(turn: number, candidate: number): string {
  const index = (turn * 3 + candidate * 5) % REPLIES.length
  return REPLIES[index] ?? ''
}

/**
 * Pick a reasoning trace deterministically.
 *
 * Not every generation gets one — a UI that only ever sees messages with
 * reasoning never gets its "no reasoning block at all" layout exercised.
 * @param turn - the turn being generated.
 * @param candidate - which candidate slot this generation fills.
 * @returns the trace, or undefined for turns that emit none.
 */
export function reasoningFor(turn: number, candidate: number): string | undefined {
  if ((turn + candidate) % 3 === 2) return undefined
  return REASONING[(turn + candidate * 2) % REASONING.length]
}

/**
 * Cut text into stream-sized pieces.
 *
 * Splits on whitespace boundaries but re-attaches the separator, so the
 * concatenation of every delta is byte-identical to the source. Chunks
 * deliberately do not align to words at the seams the caller sees, because the
 * protocol says a client must not assume whole words.
 * @param text - the full reply.
 * @param pieces - how many deltas to produce.
 * @returns the deltas, in order.
 */
export function chunk(text: string, pieces: number): string[] {
  if (pieces <= 1 || text.length === 0) return [text]
  const size = Math.ceil(text.length / pieces)
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}
