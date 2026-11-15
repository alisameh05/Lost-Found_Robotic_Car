import { LiveSearchScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]/live">) {
  const { sessionId } = await params;
  return <LiveSearchScreen sessionId={sessionId} />;
}
