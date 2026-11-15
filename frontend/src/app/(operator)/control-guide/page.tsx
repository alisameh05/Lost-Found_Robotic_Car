import { ControlGuideScreen } from "@/features/control-guide";
import { readSetupContext } from "@/lib/search-setup-context";

export default async function Page({ searchParams }: PageProps<"/control-guide">) {
  return <ControlGuideScreen setup={readSetupContext(await searchParams)} />;
}
