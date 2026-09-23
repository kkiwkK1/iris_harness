/**
 * The page's half of `/doctor`, read from the live document.
 *
 * Separate from `doctor.ts` so that module stays loadable under `node --test`
 * without a DOM; everything here is a one-line reading of `document` or
 * `location`, and the checks that judge them are tested there with fakes.
 *
 * @module iris-web/app/doctor-page
 */

import type { DoctorPage } from './doctor.ts'

/**
 * The file name of the module script this document booted from.
 *
 * A dev server puts its own client (`/@vite/client`) in a module tag ahead of
 * the entry, so the built-entry shape is preferred when present and the first
 * module script is the fallback — which on a dev page is the source entry, and
 * `doctor.ts` reads that as "not a build, not compared".
 * @param doc - the document.
 * @returns the name, or undefined when the page has no module script.
 */
export function bootEntry(doc: Document): string | undefined {
  const names = [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map(tag => new URL(tag.src, doc.baseURI).pathname.split('/').pop() ?? '')
    .filter(name => name !== '' && name !== 'client')
  return names.find(name => /^index-[\w-]+\.js$/.test(name)) ?? names[0]
}

/**
 * Everything the doctor needs from this page, now.
 * @param characterId - the open conversation's card, when it names one.
 * @returns the page reading.
 */
export function readDoctorPage(characterId: string | undefined): DoctorPage {
  const entry = bootEntry(document)
  return {
    ...entry === undefined ? {} : { entry },
    shellPolicy: document.querySelector('meta[http-equiv="Content-Security-Policy" i]') !== null,
    port: window.location.port,
    ...characterId === undefined ? {} : { characterId },
    fetchText: async (path, method) => {
      // `no-store`: the question is what the host serves now. A cached answer
      // is exactly the stale reading the bundle row exists to catch.
      const response = await fetch(path, { method, cache: 'no-store' })
      return { status: response.status, body: await response.text() }
    },
  }
}
