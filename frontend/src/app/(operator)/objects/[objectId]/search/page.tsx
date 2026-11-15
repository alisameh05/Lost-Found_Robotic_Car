import { SearchSetupScreen } from "@/features/search";
import { readSetupMode } from "@/lib/search-setup-context";

export default async function Page({ params, searchParams }: PageProps<"/objects/[objectId]/search">) {
  const { objectId } = await params;
  return <SearchSetupScreen objectId={objectId} mode={readSetupMode((await searchParams).mode)} />;
}
