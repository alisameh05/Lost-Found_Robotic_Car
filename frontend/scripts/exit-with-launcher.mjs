// The Windows launcher owns this pipe. Closing it also covers launcher process loss.
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(1));
process.stdin.resume();
