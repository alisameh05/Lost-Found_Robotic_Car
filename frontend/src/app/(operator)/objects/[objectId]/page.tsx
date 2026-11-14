import { ObjectDetailsScreen } from "@/features/objects";

export default async function Page({ params }: PageProps<"/objects/[objectId]">) {
  const { objectId } = await params;
  return <ObjectDetailsScreen objectId={objectId} />;
}
