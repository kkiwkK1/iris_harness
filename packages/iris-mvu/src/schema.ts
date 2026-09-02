/**
 * The `schema` section beside `stat_data`, and the two rules that read it.
 *
 * A card's `[InitVar]` declaration produces not only the initial tree but a
 * schema describing it, and upstream consults that schema on every `insert`:
 * it refuses an append the schema does not permit, and it merges a declared
 * `template` into each newly added member. Iris folded commands without ever
 * looking at the schema, which is visible in two ways on the corpus — 2 inserts
 * upstream refuses and we accept, and 11 whose template upstream merges and we
 * do not.
 *
 * **Why this matters, and it is not replay fidelity.** The same `applyCommands`
 * runs on every finished turn, so accepting an append upstream would refuse
 * writes a divergence straight into the user's save, and a card carried back to
 * SillyTavern grows differently shaped members. Measured against replay it is
 * worth under one point (79.7% ceiling against a 78.8% baseline) — the reason to
 * do it is compatibility, which is the floor rather than an optimisation.
 *
 * @module @iris/mvu/schema
 */

/** A node of the declaration tree, in the shape upstream writes it. */
export interface SchemaNode {
  type?: string
  properties?: Record<string, SchemaNode>
  elementType?: SchemaNode
  /** Whether members may be added that the declaration did not name. */
  extensible?: boolean
  recursiveExtensible?: boolean
  /** Merged into every newly added member. */
  template?: unknown
  [key: string]: unknown
}

/**
 * Whether a node describes an array.
 * @param node - the schema node.
 * @returns true when it is an array node.
 */
export function isArraySchema(node: SchemaNode | undefined): boolean {
  return node?.type === 'array'
}

/**
 * Whether a node describes an object.
 * @param node - the schema node.
 * @returns true when it is an object node.
 */
export function isObjectSchema(node: SchemaNode | undefined): boolean {
  return node?.type === 'object'
}

/** Split a lodash path into segments, `a.b[0].c` → `a`, `b`, `0`, `c`. */
function segmentsOf(path: string): string[] {
  return path.split(/[.[\]]/u).filter(segment => segment !== '')
}

/**
 * The schema node describing a path, or undefined when the schema does not
 * reach it.
 *
 * **Copied from upstream deliberately, including the part that looks like a
 * bug.** A numeric segment steps into `elementType`; anything else must appear
 * in `properties`, and the walk stops the moment a key is missing — it does
 * **not** fall back to an extensible parent's `template`. So a member added at
 * runtime to an `extensible: true` object has no schema of its own, and every
 * schema rule below is skipped for it.
 *
 * That is upstream's semantics, not an oversight to improve on, and it is
 * load-bearing: a corpus append into `命定系统.命定之人.<runtime member>.职业`
 * looked exactly like a schema refusal until this walk was traced, and it is
 * not one — upstream resolves no node there and permits the append. Making the
 * walk "better" by falling back to `template` would refuse writes upstream
 * accepts, which is a divergence in the direction that loses user data.
 * @param schema - the whole `schema` section, if the tree carries one.
 * @param path - the lodash path the command targets.
 * @returns the node, or undefined.
 */
export function schemaForPath(schema: unknown, path: string): SchemaNode | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  let current = schema as SchemaNode
  if (path === '') return current

  for (const segment of segmentsOf(path)) {
    if (/^\d+$/u.test(segment)) {
      if (!isArraySchema(current) || current.elementType === undefined) return undefined
      current = current.elementType
      continue
    }
    const next = isObjectSchema(current) ? current.properties?.[segment] : undefined
    if (next === undefined) return undefined
    current = next
  }
  return current
}

/**
 * Why an insert is refused by the declaration, if it is.
 *
 * Arrays are **deny by default**: upstream refuses unless `extensible` is
 * exactly `true`, so an array that simply never declared the flag is closed.
 * Objects are the opposite — only an explicit `extensible: false` closes them —
 * and a three-argument insert into such an object may still name a key the
 * declaration already lists.
 * @param node - the schema node for the container, if there is one.
 * @param argc - how many arguments the command carried.
 * @param key - the key a three-argument insert names.
 * @returns the refusal message, or undefined when the insert is allowed.
 */
export function refuseInsert(
  node: SchemaNode | undefined,
  argc: number,
  key: string | undefined,
): string | undefined {
  if (node === undefined) return undefined

  if (isArraySchema(node) && node.extensible !== true) {
    return `the declaration does not allow appending to "${String(node['title'] ?? 'this array')}"`
      + ' — its schema is not marked extensible'
  }
  if (isObjectSchema(node) && node.extensible === false) {
    if (argc === 2) return 'the declaration does not allow merging into this object'
    if (key !== undefined && node.properties?.[key] === undefined) {
      return `the declaration has no key "${key}" and does not allow adding one`
    }
  }
  return undefined
}

/**
 * Merge a declared template into a value being inserted.
 *
 * The value wins over the template wherever both name a field, so a template
 * supplies defaults rather than overwriting what the model wrote. Type
 * mismatches are left alone rather than coerced: upstream logs and returns the
 * value untouched, and inventing a conversion here would put a shape into the
 * tree that neither side would produce.
 * @param value - what the command is inserting.
 * @param template - the declaration's template, if it has one.
 * @returns the value with template defaults filled in.
 */
export function applyTemplate(value: unknown, template: unknown): unknown {
  if (template === undefined || template === null) return value

  const valueIsArray = Array.isArray(value)
  const valueIsObject = typeof value === 'object' && value !== null && !valueIsArray
  const templateIsArray = Array.isArray(template)

  if (valueIsObject && !templateIsArray) {
    // Template first, value second: the value's fields win.
    return mergeDeep(structuredClone(template), value)
  }
  if (valueIsArray && templateIsArray) {
    // Upstream's default is concat, not element-wise merge.
    return [...value, ...template as unknown[]]
  }
  if (!valueIsObject && !valueIsArray && templateIsArray) {
    return [value, ...template as unknown[]]
  }
  // Primitive value with an object template, or a shape mismatch: untouched.
  return value
}

/**
 * Recursive merge, source winning, matching lodash's `merge` closely enough for
 * the template case.
 * @param target - mutated and returned.
 * @param source - wins wherever both name a field.
 * @returns the merged target.
 */
function mergeDeep(target: unknown, source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return source
  if (typeof target !== 'object' || target === null) return structuredClone(source)
  if (Array.isArray(source) !== Array.isArray(target)) return structuredClone(source)

  const merged = target as Record<string, unknown>
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    merged[key] = key in merged ? mergeDeep(merged[key], value) : structuredClone(value)
  }
  return merged
}
