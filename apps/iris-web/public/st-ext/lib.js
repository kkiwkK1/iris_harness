import { U as UnsupportedStCompatApiError } from "./chunks/kernel-core-VDxEywTX.js";
const yaml = {
  stringify() {
    throw new UnsupportedStCompatApiError("lib.js yaml.stringify (YAML-schema variables)");
  },
  parseDocument() {
    throw new UnsupportedStCompatApiError("lib.js yaml.parseDocument (YAML-schema variables)");
  }
};
export {
  yaml
};
