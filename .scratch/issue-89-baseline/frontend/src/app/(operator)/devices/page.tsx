import { DevicesScreen } from "@/features/devices";
import { readSetupContext } from "@/lib/search-setup-context";

export default async function Page({ searchParams }: PageProps<"/devices">) {
  return <DevicesScreen setup={readSetupContext(await searchParams)} />;
}
