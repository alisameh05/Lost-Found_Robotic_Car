import { SessionScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]">) {
  const { sessionId } = await params;
  return <SessionScreen sessionId={sessionId} view="details" />;
}
