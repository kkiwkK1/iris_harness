const registered = [];
const SlashCommandParser = {
  addCommandObject(command) {
    registered.push(command);
    console.info(`[iris-st-compat] slash command "/${String(command["name"] ?? "?")}" registered inertly (pilot has no execution surface)`);
    return command;
  },
  /** Exposed for tests and diagnostics only. */
  registeredCommands() {
    return registered;
  }
};
export {
  SlashCommandParser
};
