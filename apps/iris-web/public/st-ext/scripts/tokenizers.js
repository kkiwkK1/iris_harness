let warned = false;
async function getTokenCountAsync(text) {
  if (!warned) {
    warned = true;
    console.warn("[iris-st-compat] token counts are length/4 estimates in the pilot (no tokenizer bridge)");
  }
  const value = typeof text === "string" ? text : "";
  return Math.ceil(value.length / 4);
}
export {
  getTokenCountAsync
};
