import { U as UnsupportedStCompatApiError } from "../chunks/kernel-core-VDxEywTX.js";
const POPUP_TYPE = {
  DISPLAY: "display",
  TEXT: "text",
  CONFIRM: "confirm",
  INPUT: "input"
};
const POPUP_RESULT = {
  NEGATIVE: 0,
  POSITIVE: 1,
  CANCELLED: 2
};
async function callGenericPopup() {
  throw new UnsupportedStCompatApiError("callGenericPopup (the code editor popup)");
}
export {
  POPUP_RESULT,
  POPUP_TYPE,
  callGenericPopup
};
