
const bootEnvSnapshot: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
);

export function getBootEnvSnapshot(): Record<string, string> {
  return { ...bootEnvSnapshot };
}
