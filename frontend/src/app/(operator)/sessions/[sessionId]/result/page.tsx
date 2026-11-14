import { SessionScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]/result">) {
  const { sessionId } = await params;
  return <SessionScreen sessionId={sessionId} view="result" />;
}
