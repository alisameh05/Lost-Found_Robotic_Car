import { SessionScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]/live">) {
  const { sessionId } = await params;
  return <SessionScreen sessionId={sessionId} view="live" />;
}
