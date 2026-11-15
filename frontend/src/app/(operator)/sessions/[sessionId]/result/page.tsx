import { SearchResultScreen } from "@/features/search";

export default async function Page({ params }: PageProps<"/sessions/[sessionId]/result">) {
  const { sessionId } = await params;
  return <SearchResultScreen sessionId={sessionId} />;
}
