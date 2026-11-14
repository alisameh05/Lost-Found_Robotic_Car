import { DashboardScreen } from "@/features/dashboard";
import { isFixtureMode } from "@/lib/config";

export default function Page() {
  return <DashboardScreen fixtureEnabled={isFixtureMode()} />;
}
