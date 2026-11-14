import { SearchSetupScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/objects/[objectId]/search">) {
  const { objectId } = await params;
  return <SearchSetupScreen objectId={objectId} />;
}
