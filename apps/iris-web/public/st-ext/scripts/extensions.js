import { s as state, r as renderExtensionTemplateAsync$1 } from "../chunks/scripts-events-D2xxvW0r.js";
import { U as UnsupportedStCompatApiError } from "../chunks/kernel-core-CVpTC58g.js";
const extension_settings = state.extensionSettings;
async function renderExtensionTemplateAsync(moduleKey, templateName) {
  return await renderExtensionTemplateAsync$1(moduleKey, templateName);
}
function unimplemented(member) {
  throw new UnsupportedStCompatApiError(member);
}
export {
  extension_settings,
  renderExtensionTemplateAsync,
  unimplemented
};
