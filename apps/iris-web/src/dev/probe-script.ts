/**
 * A card body written to answer three questions, and nothing else.
 *
 * The first browser run of the sandbox should not be a real card. OVERLORD's nine
 * scripts would fail in nine unrelated ways and none of them would tell us
 * whether the *frame* works — the signal would be buried in whatever those
 * scripts happen to need. This probe exercises exactly the three things that
 * cannot be checked without a browser and renders its findings into its own body,
 * where a human can read them.
 *
 * It renders rather than reports because the frame is cross-origin: the shell
 * cannot read the frame's DOM, and card code has no channel of its own. What the
 * shell *can* see — that the body ran, and what height came back — is displayed
 * beside the frame. Together they cover all three.
 *
 * Deliberately free of backslashes: this string is assembled through a shell that
 * silently eats them, and an escape that collapses here would be invisible.
 *
 * @module iris-web/dev/probe-script
 */

/** The probe, as a card script body. */
export const PROBE_SCRIPT = `
var lines = [];
function record(label, value) {
  lines.push([label, String(value)]);
}

// (a) Does an opaque-origin frame with 'unsafe-eval' actually run the two shapes
// webpack output uses? If either of these fails, no real card can run at all.
try {
  record('new Function', new Function('return 1 + 1')() === 2 ? 'runs' : 'wrong result');
} catch (error) {
  record('new Function', 'BLOCKED: ' + error.message);
}
try {
  record('indirect eval', eval('1 + 1') === 2 ? 'runs' : 'wrong result');
} catch (error) {
  record('indirect eval', 'BLOCKED: ' + error.message);
}

// (c) The measurement ten of the fourteen real sites make. Zero here would mean
// the shell never reported, or reported before the frame was listening.
try {
  var element = parent.document.documentElement;
  record('parent.document.documentElement.clientWidth', element.clientWidth);
  record('parent.document.documentElement.clientHeight', element.clientHeight);
  record('parent.innerWidth', parent.innerWidth);
} catch (error) {
  record('viewport', 'THREW: ' + error.message);
}

// The probe 12 of 15 SillyTavern sites make, and one field behind it.
try {
  record('parent.SillyTavern is truthy', Boolean(parent.SillyTavern));
  record('SillyTavern.name2', parent.SillyTavern ? parent.SillyTavern.name2 : 'n/a');
  record('bare SillyTavern is truthy', typeof SillyTavern !== 'undefined' && Boolean(SillyTavern));
} catch (error) {
  record('SillyTavern', 'THREW: ' + error.message);
}

// A refusal must arrive as a throw naming the member, never as undefined.
try {
  var forbidden = parent.document.cookie;
  record('parent.document.cookie', 'NOT REFUSED: ' + forbidden);
} catch (error) {
  record('parent.document.cookie', 'refused: ' + error.message);
}

// A write into extension settings should reach the shell.
try {
  extension_settings.irisProbe = Date.now();
  record('extension_settings write', 'accepted');
} catch (error) {
  record('extension_settings write', 'THREW: ' + error.message);
}

// (b) Mount visible content into the container, which is what the container is
// for and what should make ResizeObserver report a height.
var root = parent.document.body;
var panel = parent.document.createElement('div');
panel.setAttribute('style', 'font:13px/1.55 ui-monospace,Consolas,monospace;padding:14px 16px;color:#111');
var heading = parent.document.createElement('div');
heading.setAttribute('style', 'font-weight:600;margin-bottom:8px');
heading.appendChild(parent.document.createTextNode('Iris sandbox probe'));
panel.appendChild(heading);
for (var at = 0; at < lines.length; at += 1) {
  var row = parent.document.createElement('div');
  row.setAttribute('style', 'display:flex;gap:10px;padding:2px 0');
  var key = parent.document.createElement('span');
  key.setAttribute('style', 'color:#555;min-width:20em');
  key.appendChild(parent.document.createTextNode(lines[at][0]));
  var value = parent.document.createElement('span');
  value.appendChild(parent.document.createTextNode(lines[at][1]));
  row.appendChild(key);
  row.appendChild(value);
  panel.appendChild(row);
}
root.appendChild(panel);
`
