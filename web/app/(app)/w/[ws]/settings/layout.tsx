import { SettingsNav } from "@/components/app/settings/SettingsNav";
import { PageHeader } from "@/components/ui";

/** Settings frame (SYSTEM §4.9): page title, sub-nav (General · Members · API keys · Connect an agent · AI research · Company profile · Data). */
export default async function SettingsLayout({
  params,
  children,
}: {
  params: Promise<{ ws: string }>;
  children: React.ReactNode;
}) {
  const { ws } = await params;
  const base = `/w/${ws}/settings`;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 gap-16 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-24">
        <SettingsNav base={base} />
        <div className="min-w-0 max-w-[960px]">{children}</div>
      </div>
    </>
  );
}
