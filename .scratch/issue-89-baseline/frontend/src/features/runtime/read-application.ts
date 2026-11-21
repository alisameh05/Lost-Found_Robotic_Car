export async function readFixtureShell() {
  return (await import("./fixture-shell")).FixtureShell;
}

export async function readRecordsShell() {
  return (await import("./records-shell")).RecordsShell;
}
