export async function readFixtureShell() {
  return (await import("./fixture-shell")).FixtureShell;
}
