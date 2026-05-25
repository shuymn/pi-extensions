import { normalizeFileArg } from "./git";

export type CommandArgParseOptions<TFlag extends string, TValueFlag extends string = never> = {
  readonly args: string;
  readonly booleanFlags: readonly TFlag[];
  readonly valueFlags?: readonly TValueFlag[];
};

export type ParsedCommandArgs<TFlag extends string, TValueFlag extends string = never> = {
  readonly files: string[];
  readonly flags: Record<TFlag, boolean>;
  readonly values: Record<TValueFlag, string | undefined>;
  readonly valueErrors: Partial<Record<TValueFlag, string>>;
  readonly instructions: string;
};

export function parseCommandArgs<TFlag extends string, TValueFlag extends string = never>({
  args,
  booleanFlags,
  valueFlags,
}: CommandArgParseOptions<TFlag, TValueFlag>): ParsedCommandArgs<TFlag, TValueFlag> {
  const separatorMatch = /(?:^|\s)--(?:\s|$)/.exec(args);
  const optionText = separatorMatch ? args.slice(0, separatorMatch.index).trim() : args.trim();
  const instructions = separatorMatch
    ? args.slice(separatorMatch.index + separatorMatch[0].length).trim()
    : "";

  const files: string[] = [];
  const flags = Object.fromEntries(booleanFlags.map((flag) => [flag, false])) as Record<
    TFlag,
    boolean
  >;
  const valueFlagList = valueFlags ?? [];
  const values = Object.fromEntries(valueFlagList.map((flag) => [flag, undefined])) as Record<
    TValueFlag,
    string | undefined
  >;
  const valueErrors: Partial<Record<TValueFlag, string>> = {};
  const flagSet = new Set<string>(booleanFlags);
  const valueFlagSet = new Set<string>(valueFlagList);
  const tokens = optionText.split(/\s+/).filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (flagSet.has(token)) {
      flags[token as TFlag] = true;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const maybeValueFlag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (valueFlagSet.has(maybeValueFlag)) {
      const nextToken = tokens[index + 1];
      const value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : nextToken;
      if (equalsIndex >= 0) {
        if (value) values[maybeValueFlag as TValueFlag] = value;
        else valueErrors[maybeValueFlag as TValueFlag] = `${maybeValueFlag} requires a value`;
      } else if (
        nextToken === undefined ||
        nextToken.startsWith("-") ||
        nextToken.startsWith("@")
      ) {
        valueErrors[maybeValueFlag as TValueFlag] = `${maybeValueFlag} requires a value`;
      } else {
        values[maybeValueFlag as TValueFlag] = value;
        index += 1;
      }
      continue;
    }

    files.push(normalizeFileArg(token));
  }

  return { files, flags, values, valueErrors, instructions };
}
