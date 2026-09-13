const ARGUMENT_TYPE = {
  BOOLEAN: "boolean",
  CLOSURE: "closure",
  DICTIONARY: "dictionary",
  NUMBER: "number",
  RANGE: "range",
  STRING: "string",
  SUBCOMMAND: "subcommand",
  VARIABLE_NAME: "variable_name"
};
const SlashCommandArgument = {
  fromProps(props) {
    return { ...props };
  }
};
const SlashCommandNamedArgument = {
  fromProps(props) {
    return { ...props };
  }
};
export {
  ARGUMENT_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument
};
