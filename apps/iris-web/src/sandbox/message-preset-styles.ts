/**
 * The two stylesheets a message frame needs, put into its own document.
 *
 * A separate module purely for **evaluation order**. ES module imports are
 * hoisted but their bodies run in declaration order, so this being imported
 * before `@tailwindcss/browser` is what puts these sheets into the head before
 * Tailwind injects its own — which is upstream's order
 * (`third_party_message.html`: FontAwesome CSS, then Tailwind) and decides who
 * wins a specificity tie. Written as statements in the entry instead, they would
 * have run *after* Tailwind, because Tailwind's own import would have been
 * hoisted above them.
 *
 * `<style>` elements rather than `<link>`: a link is a second request from a
 * frame whose whole purpose is to make none, and it would reintroduce the
 * "arrived / did not arrive" split that inlining the fonts exists to remove.
 *
 * @module iris-web/sandbox/message-preset-styles
 */

/*
 * FontAwesome's **split** sheets, not `all.min.css`, and the reason is measured.
 *
 * `all.min.css` is the four sub-sheets concatenated, and it carries **10**
 * `@font-face` declarations for four distinct faces — the same file redeclared
 * per sub-sheet. With the faces inlined as data URIs that duplication is not
 * free: it was 1.2 MB of the bundle against 370 KB of actual font bytes.
 *
 * The split sheets declare one face each, so every face is inlined once.
 * SillyTavern's own page loads them this way too. Icon coverage is unchanged —
 * base rules plus solid, brands, regular, and the v4 compatibility face that old
 * cards' bare `fa-` class names need.
 */
import faBase from '@fortawesome/fontawesome-free/css/fontawesome.min.css?inline'
import faSolid from '@fortawesome/fontawesome-free/css/solid.min.css?inline'
import faBrands from '@fortawesome/fontawesome-free/css/brands.min.css?inline'
import faRegular from '@fortawesome/fontawesome-free/css/regular.min.css?inline'
import faV4 from '@fortawesome/fontawesome-free/css/v4-font-face.min.css?inline'
import uiCss from 'jquery-ui/dist/themes/base/jquery-ui.min.css?inline'

/**
 * Add one stylesheet to the frame's head.
 * @param css - the stylesheet text.
 * @param label - a marker attribute, so a diagnostic can name which sheet.
 */
function addStyle(css: string, label: string): void {
  const style = document.createElement('style')
  style.setAttribute('data-iris-style', label)
  style.textContent = css
  document.head.append(style)
}

addStyle(faBase, 'fontawesome')
addStyle(faSolid, 'fontawesome-solid')
addStyle(faBrands, 'fontawesome-brands')
addStyle(faRegular, 'fontawesome-regular')
addStyle(faV4, 'fontawesome-v4')
addStyle(uiCss, 'jquery-ui')
