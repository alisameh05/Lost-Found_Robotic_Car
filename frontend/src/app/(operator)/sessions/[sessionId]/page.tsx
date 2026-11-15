import { SessionDetailsScreen } from "@/features/objects";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]">) {
  const { sessionId } = await params;
  return <SessionDetailsScreen sessionId={sessionId} />;
}
